'use client'

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

const STORAGE_KEY = "client-tracker:v6";

type ProgramType = "12w" | "6m";
type GoalType = "fat_loss" | "muscle_gain";

type Client = {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD
  program: ProgramType;
  goal: GoalType;
  notes?: string;
};

type RuleOnboardingOrWeekly = {
  id: string;
  day: number; // 0=Sun..6=Sat
  title: string;
};

type RuleWeek = {
  id: string;
  week: number;
  title: string;
};

type TaskRules = {
  onboarding: RuleOnboardingOrWeekly[];
  weekly: RuleOnboardingOrWeekly[];
  week: RuleWeek[];
};

type TaskKind = "onboarding" | "weekly" | "milestone" | "program";

type Task = {
  id: string;
  title: string;
  kind: TaskKind;
};

type Completion = {
  [dateISO: string]: {
    [clientId: string]: {
      [taskId: string]: boolean;
    };
  };
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DEFAULT_TASK_RULES: TaskRules = {
  onboarding: [
    { id: "o1", day: 6, title: "Send meal plan" }, // Saturday
    { id: "o2", day: 0, title: "Check meal prep / ready to start" }, // Sunday
    { id: "o3", day: 1, title: 'Send "good luck" message' }, // Monday
    { id: "o4", day: 3, title: "Unofficial Mid-Week Check In" }, // Wednesday
  ],
  weekly: [
    { id: "w1", day: 3, title: "Unofficial Mid-Week Check-in" }, // Wednesday
    { id: "w2", day: 5, title: "Send Check-in Message" }, // Friday
    { id: "w3", day: 0, title: "Check-in" }, // Sunday
  ],
  week: [{ id: "wk3", week: 3, title: "Send Referral Message" }],
};

function clsx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function parseISODate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatISODate(d: Date) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prettyDate(iso: string) {
  const dt = parseISODate(iso);
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function daysBetween(a: Date, b: Date) {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function addDaysISO(iso: string, days: number) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return formatISODate(d);
}

function getClientWeek(startDateISO: string, today = new Date()) {
  const start = parseISODate(startDateISO);
  const diffDays = daysBetween(start, today);
  return Math.max(1, Math.floor(diffDays / 7) + 1);
}

function addMonthsToISO(startISO: string, months: number) {
  const dt = parseISODate(startISO);

  const targetMonth = dt.getMonth() + months;
  const y2 = dt.getFullYear() + Math.floor(targetMonth / 12);
  const m2 = ((targetMonth % 12) + 12) % 12;

  const out = new Date(y2, m2, dt.getDate());
  return formatISODate(out);
}

function getProgramEndDateISO(client: Pick<Client, "startDate" | "program">) {
  if (client.program === "6m") return addMonthsToISO(client.startDate, 6);

  const start = parseISODate(client.startDate);
  const end = new Date(start);
  end.setDate(end.getDate() + 7 * 12);
  return formatISODate(end);
}

function getProgramTotalWeeks(client: Client) {
  const endISO = getProgramEndDateISO(client);
  const start = parseISODate(client.startDate);
  const end = parseISODate(endISO);
  const totalDays = Math.max(1, daysBetween(start, end));
  return Math.max(1, Math.ceil(totalDays / 7));
}

function normalizeRules(rules: any): TaskRules {
  const safe = rules && typeof rules === "object" ? rules : {};
  return {
    onboarding: Array.isArray(safe.onboarding) ? safe.onboarding.filter(Boolean) : DEFAULT_TASK_RULES.onboarding,
    weekly: Array.isArray(safe.weekly) ? safe.weekly.filter(Boolean) : DEFAULT_TASK_RULES.weekly,
    week: Array.isArray(safe.week) ? safe.week.filter(Boolean) : DEFAULT_TASK_RULES.week,
  };
}

// localStorage load (for migration only)
function loadLocalState(): { clients?: any[]; taskRules?: any; completion?: any } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function generateTasksForClientOnDate(client: Client, dateISO: string, rules: TaskRules) {
  const { onboarding, weekly, week: weekRules } = normalizeRules(rules);

  const date = parseISODate(dateISO);
  const day = date.getDay();
  const week = getClientWeek(client.startDate, date);

  const tasks: Task[] = [];

  // Onboarding (Week 1 only)
  if (week === 1) {
    for (const r of onboarding) {
      if (r.day === day) tasks.push({ id: `rule:${r.id}`, title: r.title, kind: "onboarding" });
    }
  }

  // Weekly
  for (const r of weekly) {
    if (r.day === day) tasks.push({ id: `rule:${r.id}`, title: r.title, kind: "weekly" });
  }

  // Milestones
  for (const r of weekRules) {
    if (r.week === week) tasks.push({ id: `rule:${r.id}`, title: r.title, kind: "milestone" });
  }

  // Program reminders
  const totalWeeks = getProgramTotalWeeks(client);
  if (week === totalWeeks - 1) {
    tasks.push({
      id: "program:second-last-week",
      title: "Client is on their 2nd last week — start wrapping up / renewal convo",
      kind: "program",
    });
  }
  if (week === totalWeeks) {
    tasks.push({
      id: "program:last-week",
      title: "Client is on their LAST week — final check-in + next steps",
      kind: "program",
    });
  }

  return { week, tasks };
}

type DbClientRow = {
  id: string;
  name: string;
  start_date: string;
  program: ProgramType;
  goal: GoalType;
  notes: string;
};

type DbRuleRow = {
  id: string;
  type: "onboarding" | "weekly" | "week";
  day: number | null;
  week: number | null;
  title: string;
};

type DbCompletionRow = {
  date_iso: string;
  client_id: string;
  task_id: string;
  done: boolean;
};

export default function Page() {
  const todayISO = useMemo(() => formatISODate(new Date()), []);
  const [dateISO, setDateISO] = useState(todayISO);

  // Auth
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  // Cloud state
  const [loading, setLoading] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [taskRules, setTaskRules] = useState<TaskRules>(DEFAULT_TASK_RULES);
  const [completion, setCompletion] = useState<Completion>({});

  // Add client
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState(todayISO);
  const [newProgram, setNewProgram] = useState<ProgramType>("12w");
  const [newGoal, setNewGoal] = useState<GoalType>("fat_loss");

  // Add rule
  const [ruleType, setRuleType] = useState<"onboarding" | "weekly" | "week">("onboarding");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleDay, setRuleDay] = useState(0);
  const [ruleWeek, setRuleWeek] = useState(3);

  // Filters / view (day-only)
  const [taskFilter, setTaskFilter] = useState<"all" | "incomplete">("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "week" | "start" | "incomplete">("week");

  // Overdue lookback
  const OVERDUE_LOOKBACK_DAYS = 30;

  // --- AUTH BOOTSTRAP ---
  useEffect(() => {
    let mounted = true;

    async function boot() {
      setAuthLoading(true);
      const { data } = await supabase.auth.getSession();
      const email = data.session?.user?.email ?? null;
      if (!mounted) return;
      setSessionEmail(email);
      setAuthLoading(false);
    }

    boot();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSessionEmail(newSession?.user?.email ?? null);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function signIn() {
    setAuthError(null);
    const email = authEmail.trim();
    const password = authPassword;
    if (!email || !password) {
      setAuthError("Enter email + password.");
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setAuthError(error.message);
      return;
    }
    setAuthEmail("");
    setAuthPassword("");
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  // --- CLOUD LOADERS ---
  function mapDbClients(rows: DbClientRow[]): Client[] {
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      startDate: r.start_date,
      program: r.program,
      goal: r.goal,
      notes: r.notes ?? "",
    }));
  }

  function mapDbRules(rows: DbRuleRow[]): TaskRules {
    const onboarding: RuleOnboardingOrWeekly[] = [];
    const weekly: RuleOnboardingOrWeekly[] = [];
    const week: RuleWeek[] = [];

    for (const r of rows) {
      if (r.type === "week") {
        week.push({ id: r.id, week: r.week ?? 1, title: r.title });
      } else {
        const day = r.day ?? 0;
        if (r.type === "onboarding") onboarding.push({ id: r.id, day, title: r.title });
        if (r.type === "weekly") weekly.push({ id: r.id, day, title: r.title });
      }
    }

    return normalizeRules({ onboarding, weekly, week });
  }

  function applyCompletionRows(rows: DbCompletionRow[]) {
    const next: Completion = {};
    for (const r of rows) {
      if (!next[r.date_iso]) next[r.date_iso] = {};
      if (!next[r.date_iso][r.client_id]) next[r.date_iso][r.client_id] = {};
      next[r.date_iso][r.client_id][r.task_id] = !!r.done;
    }
    setCompletion(next);
  }

  async function ensureDefaultRulesIfEmpty() {
    const { data, error } = await supabase
      .from("task_rules")
      .select("id")
      .limit(1);

    if (error) return;
    if (data && data.length > 0) return;

    // seed defaults
    const seed: Array<Partial<DbRuleRow>> = [
      ...DEFAULT_TASK_RULES.onboarding.map((r) => ({ type: "onboarding", day: r.day, week: null, title: r.title })),
      ...DEFAULT_TASK_RULES.weekly.map((r) => ({ type: "weekly", day: r.day, week: null, title: r.title })),
      ...DEFAULT_TASK_RULES.week.map((r) => ({ type: "week", day: null, week: r.week, title: r.title })),
    ];

    await supabase.from("task_rules").insert(seed);
  }

  async function loadCloudCore() {
    setLoading(true);
    try {
      await ensureDefaultRulesIfEmpty();

      const [clientsRes, rulesRes] = await Promise.all([
        supabase.from("clients").select("*").order("created_at", { ascending: true }),
        supabase.from("task_rules").select("*").order("created_at", { ascending: true }),
      ]);

      if (clientsRes.error) throw clientsRes.error;
      if (rulesRes.error) throw rulesRes.error;

      setClients(mapDbClients((clientsRes.data as any) || []));
      setTaskRules(mapDbRules((rulesRes.data as any) || []));
    } finally {
      setLoading(false);
    }
  }

  async function loadCompletionsForWindow(selectedDateISO: string) {
    // Load completion rows for [selectedDate-30days .. selectedDate] so we can do overdue + selected day
    const end = parseISODate(selectedDateISO);
    const start = new Date(end);
    start.setDate(start.getDate() - OVERDUE_LOOKBACK_DAYS);
    const startISO = formatISODate(start);

    const { data, error } = await supabase
      .from("completions")
      .select("date_iso, client_id, task_id, done")
      .gte("date_iso", startISO)
      .lte("date_iso", selectedDateISO);

    if (error) {
      // keep old completion if error
      return;
    }

    applyCompletionRows((data as any) || []);
  }

  // Load cloud data once logged in
  useEffect(() => {
    if (!sessionEmail) return;
    loadCloudCore();
  }, [sessionEmail]);

  // Reload completion window whenever date changes (and logged in)
  useEffect(() => {
    if (!sessionEmail) return;
    loadCompletionsForWindow(dateISO);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionEmail, dateISO]);

  // --- HELPERS ---
  function isChecked(dateKey: string, clientId: string, taskId: string) {
    return !!completion?.[dateKey]?.[clientId]?.[taskId];
  }

  async function toggleTask(dateKey: string, clientId: string, taskId: string) {
    // Optimistic update
    setCompletion((prev) => {
      const next: Completion = { ...prev };
      const dateObj = { ...(next[dateKey] || {}) };
      const clientObj = { ...(dateObj[clientId] || {}) };
      clientObj[taskId] = !clientObj[taskId];
      dateObj[clientId] = clientObj;
      next[dateKey] = dateObj;
      return next;
    });

    const nextDone = !isChecked(dateKey, clientId, taskId);

    await supabase
      .from("completions")
      .upsert(
        { date_iso: dateKey, client_id: clientId, task_id: taskId, done: nextDone },
        { onConflict: "date_iso,client_id,task_id" }
      );
  }

  async function addClient() {
    const name = newName.trim();
    if (!name) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newStart)) return;

    const { data, error } = await supabase
      .from("clients")
      .insert({ name, start_date: newStart, program: newProgram, goal: newGoal, notes: "" })
      .select("*")
      .single();

    if (error) return;

    setClients((prev) => [...prev, mapDbClients([data as any])[0]]);
    setNewName("");
    setNewStart(todayISO);
    setNewProgram("12w");
    setNewGoal("fat_loss");
  }

  async function removeClient(id: string) {
    const { error } = await supabase.from("clients").delete().eq("id", id);
    if (error) return;
    setClients((prev) => prev.filter((c) => c.id !== id));
  }

  async function updateClientNotes(id: string, notes: string) {
    setClients((prev) => prev.map((c) => (c.id === id ? { ...c, notes } : c)));
    await supabase.from("clients").update({ notes }).eq("id", id);
  }

  async function addRule() {
    const title = ruleTitle.trim();
    if (!title) return;

    if (ruleType === "week") {
      const wk = Math.max(1, Number(ruleWeek) || 1);
      const { error } = await supabase.from("task_rules").insert({ type: "week", week: wk, day: null, title });
      if (error) return;
    } else {
      const dy = Number(ruleDay);
      const { error } = await supabase.from("task_rules").insert({ type: ruleType, day: dy, week: null, title });
      if (error) return;
    }

    setRuleTitle("");
    // reload rules
    const rulesRes = await supabase.from("task_rules").select("*").order("created_at", { ascending: true });
    if (!rulesRes.error) setTaskRules(mapDbRules((rulesRes.data as any) || []));
  }

  async function deleteRule(type: keyof TaskRules, id: string) {
    const { error } = await supabase.from("task_rules").delete().eq("id", id);
    if (error) return;

    setTaskRules((prev) => {
      const safe = normalizeRules(prev);
      return { ...safe, [type]: (safe[type] as any[]).filter((r: any) => r.id !== id) } as TaskRules;
    });
  }

  async function migrateFromLocalStorage() {
    const st = loadLocalState();
    if (!st) return;

    const localClients = Array.isArray(st.clients) ? st.clients : [];
    const localRules = st.taskRules ? normalizeRules(st.taskRules) : DEFAULT_TASK_RULES;
    const localCompletion: Completion = st.completion && typeof st.completion === "object" ? st.completion : {};

    // 1) Insert clients
    const clientInsertPayload = localClients.map((c: any) => ({
      name: String(c.name || "").trim(),
      start_date: String(c.startDate || todayISO),
      program: (c.program as ProgramType) || "12w",
      goal: (c.goal as GoalType) || "fat_loss",
      notes: typeof c.notes === "string" ? c.notes : "",
    })).filter((c: any) => c.name);

    // Clear existing cloud data first (safer: ask you to do manually, but keeping simple)
    await supabase.from("completions").delete().neq("task_id", "");
    await supabase.from("clients").delete().neq("name", "");
    await supabase.from("task_rules").delete().neq("title", "");

    // Seed rules exactly from local
    const rulesPayload: any[] = [
      ...normalizeRules(localRules).onboarding.map((r) => ({ type: "onboarding", day: r.day, week: null, title: r.title })),
      ...normalizeRules(localRules).weekly.map((r) => ({ type: "weekly", day: r.day, week: null, title: r.title })),
      ...normalizeRules(localRules).week.map((r) => ({ type: "week", day: null, week: r.week, title: r.title })),
    ];
    await supabase.from("task_rules").insert(rulesPayload);

    const insertedClientsRes = await supabase.from("clients").insert(clientInsertPayload).select("*");
    if (insertedClientsRes.error) return;

    // Map local client names to new IDs (best-effort)
    const insertedClients = (insertedClientsRes.data as any[]).map(mapDbClients).flat();
    const nameToId = new Map<string, string>();
    insertedClients.forEach((c) => nameToId.set(c.name, c.id));

    // 2) Insert completions (best-effort)
    const completionRows: any[] = [];
    for (const dISO of Object.keys(localCompletion)) {
      const byClient = localCompletion[dISO] || {};
      for (const localClientId of Object.keys(byClient)) {
        const tasks = byClient[localClientId] || {};
        // We don't know new uuid; try to match by client name from localClients array
        const localClient = localClients.find((x: any) => x.id === localClientId);
        const cloudId = localClient?.name ? nameToId.get(localClient.name) : undefined;
        if (!cloudId) continue;

        for (const taskId of Object.keys(tasks)) {
          completionRows.push({
            date_iso: dISO,
            client_id: cloudId,
            task_id: taskId,
            done: !!tasks[taskId],
          });
        }
      }
    }
    if (completionRows.length > 0) {
      // chunk inserts
      const chunkSize = 500;
      for (let i = 0; i < completionRows.length; i += chunkSize) {
        const chunk = completionRows.slice(i, i + chunkSize);
        await supabase.from("completions").insert(chunk);
      }
    }

    // Reload everything
    await loadCloudCore();
    await loadCompletionsForWindow(dateISO);
  }

  const dayName = DAY_NAMES[parseISODate(dateISO).getDay()];

  // Build base rows (day-only)
  const baseRows = useMemo(() => {
    return clients.map((c) => {
      const day = generateTasksForClientOnDate(c, dateISO, taskRules);
      return { client: c, day };
    });
  }, [clients, dateISO, taskRules]);

  // Search filter
  const searchedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return baseRows;
    return baseRows.filter(({ client }) => {
      const name = client.name.toLowerCase();
      const notes = (client.notes || "").toLowerCase();
      return name.includes(q) || notes.includes(q);
    });
  }, [baseRows, search]);

  function countIncompleteDay(clientId: string, tasks: Task[]) {
    return tasks.reduce((acc, t) => acc + (isChecked(dateISO, clientId, t.id) ? 0 : 1), 0);
  }

  // Sort
  const sortedRows = useMemo(() => {
    const rows = [...searchedRows];

    rows.sort((a, b) => {
      if (sortBy === "name") return a.client.name.localeCompare(b.client.name);
      if (sortBy === "start") return a.client.startDate.localeCompare(b.client.startDate);

      if (sortBy === "incomplete") {
        const ai = countIncompleteDay(a.client.id, a.day.tasks);
        const bi = countIncompleteDay(b.client.id, b.day.tasks);
        if (bi !== ai) return bi - ai;
        return a.client.name.localeCompare(b.client.name);
      }

      // default: week (ascending)
      if (a.day.week !== b.day.week) return a.day.week - b.day.week;
      return a.client.name.localeCompare(b.client.name);
    });

    return rows;
  }, [searchedRows, sortBy, dateISO, completion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Progress (selected day only)
  const progress = useMemo(() => {
    let total = 0;
    let done = 0;
    for (const row of sortedRows) {
      total += row.day.tasks.length;
      for (const t of row.day.tasks) {
        if (isChecked(dateISO, row.client.id, t.id)) done += 1;
      }
    }
    return { total, done };
  }, [sortedRows, dateISO, completion]);

  // Overdue (last N days, before selected date)
  const overdue = useMemo(() => {
    const results: Array<{
      client: Client;
      dateISO: string;
      week: number;
      task: Task;
    }> = [];

    for (const row of sortedRows) {
      const c = row.client;

      for (let i = 1; i <= OVERDUE_LOOKBACK_DAYS; i++) {
        const dISO = addDaysISO(dateISO, -i);
        const d = parseISODate(dISO);

        if (d < parseISODate(c.startDate)) continue;

        const { week, tasks } = generateTasksForClientOnDate(c, dISO, taskRules);

        for (const t of tasks) {
          if (!isChecked(dISO, c.id, t.id)) {
            results.push({ client: c, dateISO: dISO, week, task: t });
          }
        }
      }
    }

    results.sort((a, b) => {
      if (a.dateISO !== b.dateISO) return a.dateISO.localeCompare(b.dateISO);
      return a.client.name.localeCompare(b.client.name);
    });

    return results;
  }, [sortedRows, dateISO, completion, taskRules]);

  // --- UI: AUTH GATE ---
  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-6 w-full max-w-md">
          <div className="text-lg font-semibold">Loading…</div>
          <div className="text-sm text-slate-600 mt-1">Checking session</div>
        </div>
      </div>
    );
  }

  if (!sessionEmail) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-6 w-full max-w-md">
          <h1 className="text-2xl font-semibold tracking-tight">Client Tracker</h1>
          <p className="text-sm text-slate-600 mt-1">Sign in to access the dashboard.</p>

          <div className="mt-5 space-y-3">
            <div>
              <label className="text-xs uppercase tracking-wide text-slate-500">Email</label>
              <input
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                placeholder="staff@email.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-slate-500">Password</label>
              <input
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                placeholder="••••••••"
                type="password"
                autoComplete="current-password"
              />
            </div>

            {authError ? (
              <div className="text-sm text-red-600">{authError}</div>
            ) : null}

            <button
              onClick={signIn}
              className="w-full rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-slate-800 active:bg-slate-950"
            >
              Sign in
            </button>

            <div className="text-xs text-slate-500">
              Create staff users in Supabase → Authentication → Users.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl p-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Client Tracker</h1>
            <p className="text-slate-600 mt-1">
              Cloud mode • Signed in as <span className="font-medium text-slate-900">{sessionEmail}</span>
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <div className="rounded-2xl bg-white shadow-sm border border-slate-200 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Selected day</div>
              <div className="flex items-center gap-3 mt-1">
                <input
                  type="date"
                  value={dateISO}
                  onChange={(e) => setDateISO(e.target.value)}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
                <div className="text-sm text-slate-700">{prettyDate(dateISO)}</div>
              </div>
            </div>

            <div className="rounded-2xl bg-white shadow-sm border border-slate-200 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Progress (selected day)</div>
              <div className="mt-1 flex items-baseline gap-2">
                <div className="text-xl font-semibold">{progress.done}</div>
                <div className="text-sm text-slate-600">/ {progress.total} tasks done</div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={migrateFromLocalStorage}
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-100"
                title="One-click: move local browser data to Supabase"
              >
                Migrate local → cloud
              </button>
              <button
                onClick={signOut}
                className="rounded-xl bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-800"
              >
                Sign out
              </button>
            </div>
          </div>
        </header>

        {loading ? (
          <div className="mt-6 rounded-2xl bg-white shadow-sm border border-slate-200 p-4 text-sm text-slate-600">
            Loading cloud data…
          </div>
        ) : null}

        <section className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left column */}
          <div className="lg:col-span-1 rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
            <h2 className="text-lg font-semibold">Add a client</h2>
            <p className="text-sm text-slate-600 mt-1">Week number is calculated automatically from the start date.</p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500">Client name</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g., Sarah K"
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500">Program length</label>
                <select
                  value={newProgram}
                  onChange={(e) => setNewProgram(e.target.value as ProgramType)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="12w">12 weeks</option>
                  <option value="6m">6 months</option>
                </select>
              </div>

              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500">Client goal</label>
                <select
                  value={newGoal}
                  onChange={(e) => setNewGoal(e.target.value as GoalType)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="fat_loss">Fat loss</option>
                  <option value="muscle_gain">Muscle gain</option>
                </select>
              </div>

              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500">Start date</label>
                <input
                  type="date"
                  value={newStart}
                  onChange={(e) => setNewStart(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
                <div className="mt-1 text-xs text-slate-500">
                  End date:{" "}
                  <span className="font-medium text-slate-700">
                    {getProgramEndDateISO({ startDate: newStart, program: newProgram })}
                  </span>
                </div>
              </div>

              <button
                onClick={addClient}
                className="w-full rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-slate-800 active:bg-slate-950"
              >
                Add client
              </button>

              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500">Task rules</div>

                <div className="mt-2 space-y-3">
                  <div>
                    <div className="text-xs font-medium text-slate-700">Onboarding rules (Week 1 only)</div>
                    <ul className="mt-1 text-sm text-slate-700 space-y-1 list-disc pl-5">
                      {normalizeRules(taskRules).onboarding.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-2">
                          <span>
                            {DAY_NAMES[r.day]}: {r.title}
                          </span>
                          <button
                            onClick={() => deleteRule("onboarding", r.id)}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-100"
                          >
                            Delete
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-slate-700">Repeating weekly rules</div>
                    <ul className="mt-1 text-sm text-slate-700 space-y-1 list-disc pl-5">
                      {normalizeRules(taskRules).weekly.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-2">
                          <span>
                            {DAY_NAMES[r.day]}: {r.title}
                          </span>
                          <button
                            onClick={() => deleteRule("weekly", r.id)}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-100"
                          >
                            Delete
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-slate-700">Week-based rules</div>
                    <ul className="mt-1 text-sm text-slate-700 space-y-1 list-disc pl-5">
                      {normalizeRules(taskRules).week.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-2">
                          <span>
                            Week {r.week}: {r.title}
                          </span>
                          <button
                            onClick={() => deleteRule("week", r.id)}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-100"
                          >
                            Delete
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-xl bg-white border border-slate-200 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Add a new rule</div>

                    <div className="mt-2 space-y-2">
                      <select
                        value={ruleType}
                        onChange={(e) => setRuleType(e.target.value as any)}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="onboarding">Onboarding (Week 1 only)</option>
                        <option value="weekly">Repeating weekly</option>
                        <option value="week">Specific client week</option>
                      </select>

                      {ruleType === "week" ? (
                        <input
                          type="number"
                          min={1}
                          value={ruleWeek}
                          onChange={(e) => setRuleWeek(Number(e.target.value))}
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                          placeholder="Week number"
                        />
                      ) : (
                        <select
                          value={ruleDay}
                          onChange={(e) => setRuleDay(Number(e.target.value))}
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        >
                          {DAY_NAMES.map((d, i) => (
                            <option key={d} value={i}>
                              {d}
                            </option>
                          ))}
                        </select>
                      )}

                      <input
                        value={ruleTitle}
                        onChange={(e) => setRuleTitle(e.target.value)}
                        placeholder="Task description"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                      />

                      <button
                        onClick={addRule}
                        className="w-full rounded-xl bg-slate-900 text-white px-4 py-2 text-sm"
                      >
                        Add rule
                      </button>

                      <div className="text-xs text-slate-500">
                        Rules auto-generate tasks. Program reminders auto-trigger on 2nd last + last week.
                      </div>
                    </div>
                  </div>

                  <div className="text-xs text-slate-500">
                    Overdue shows tasks in the last {OVERDUE_LOOKBACK_DAYS} days that weren’t ticked.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="lg:col-span-2 space-y-4">
            {/* Controls */}
            <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
              <div className="flex flex-col gap-3">

                <div>
                  <h2 className="text-lg font-semibold">Tasks</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    Day view for {dayName} ({dateISO})
                  </p>
                </div>

                {/* ✅ Left/Right layout exactly like your screenshot request */}
                <div className="flex items-center gap-3">
                  {/* LEFT: All / Incomplete */}
                  <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1">
                    <button
                      onClick={() => setTaskFilter("all")}
                      className={clsx(
                        "rounded-lg px-3 py-1.5 text-sm",
                        taskFilter === "all" ? "bg-white border border-slate-200 shadow-sm" : "text-slate-600"
                      )}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setTaskFilter("incomplete")}
                      className={clsx(
                        "rounded-lg px-3 py-1.5 text-sm",
                        taskFilter === "incomplete" ? "bg-white border border-slate-200 shadow-sm" : "text-slate-600"
                      )}
                    >
                      Incomplete
                    </button>
                  </div>

                  {/* spacer */}
                  <div className="flex-1" />

                  {/* RIGHT: Sort */}
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    title="Sort"
                  >
                    <option value="week">Sort: Week (asc)</option>
                    <option value="name">Sort: Name (A–Z)</option>
                    <option value="start">Sort: Start date</option>
                    <option value="incomplete">Sort: Most incomplete</option>
                  </select>
                </div>

                {/* Search row */}
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name or notes…"
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm w-full"
                />

                <div className="text-sm text-slate-600">
                  Clients shown: <span className="font-medium text-slate-900">{sortedRows.length}</span>
                </div>
              </div>
            </div>

            {/* Overdue */}
            <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">Overdue</h3>
                  <p className="text-sm text-slate-600 mt-1">
                    Tasks from the last {OVERDUE_LOOKBACK_DAYS} days (before {dateISO}) that are not ticked.
                  </p>
                </div>
                <div className="text-sm text-slate-600">
                  Total: <span className="font-medium text-slate-900">{overdue.length}</span>
                </div>
              </div>

              {overdue.length === 0 ? (
                <div className="mt-3 text-sm text-slate-600">No overdue tasks 🎉</div>
              ) : (
                <div className="mt-3 space-y-2 max-h-[320px] overflow-auto pr-1">
                  {overdue.map((o, idx) => {
                    const checked = isChecked(o.dateISO, o.client.id, o.task.id);
                    return (
                      <div
                        key={`${o.client.id}-${o.dateISO}-${o.task.id}-${idx}`}
                        className="rounded-xl border border-slate-200 bg-slate-50/40 p-3 flex items-start justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">{o.client.name}</div>
                          <div className="text-xs text-slate-600 mt-0.5">
                            {o.dateISO} • Week {o.week} • {o.task.kind.toUpperCase()}
                          </div>
                          <div className="text-sm text-slate-800 mt-1">{o.task.title}</div>
                        </div>

                        <button
                          onClick={() => toggleTask(o.dateISO, o.client.id, o.task.id)}
                          className={clsx(
                            "shrink-0 rounded-xl px-3 py-2 text-sm border",
                            checked
                              ? "bg-white border-slate-300 text-slate-600"
                              : "bg-slate-900 border-slate-900 text-white"
                          )}
                          title="Mark done / undo"
                        >
                          {checked ? "Undo" : "Mark done"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Client cards */}
            <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
              {sortedRows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center">
                  <div className="text-lg font-medium">No clients match</div>
                  <div className="text-sm text-slate-600 mt-1">Try clearing your search.</div>
                </div>
              ) : (
                <div className="space-y-4">
                  {sortedRows.map(({ client, day }) => {
                    const tasks = day.tasks;
                    const tasksToShow =
                      taskFilter === "incomplete" ? tasks.filter((t) => !isChecked(dateISO, client.id, t.id)) : tasks;

                    if (taskFilter === "incomplete" && tasksToShow.length === 0) return null;

                    return (
                      <div key={client.id} className="rounded-2xl border border-slate-200 bg-slate-50/40 p-4">
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                          <div className="flex items-center gap-3 flex-wrap">
                            <h3 className="text-base font-semibold">{client.name}</h3>

                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              Week {day.week}
                            </span>

                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              Goal: {client.goal === "fat_loss" ? "Fat loss" : "Muscle gain"}
                            </span>

                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              Start: {client.startDate}
                            </span>

                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              End: {getProgramEndDateISO(client)}
                            </span>
                          </div>

                          <button
                            onClick={() => removeClient(client.id)}
                            className="self-start md:self-auto rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-100"
                            title="Remove client"
                          >
                            Remove
                          </button>
                        </div>

                        {/* Notes */}
                        <div className="mt-3">
                          <label className="text-xs uppercase tracking-wide text-slate-500">Notes</label>
                          <textarea
                            value={client.notes || ""}
                            onChange={(e) => updateClientNotes(client.id, e.target.value)}
                            placeholder="e.g., goals, injury, preferences, reminders..."
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm min-h-[70px]"
                          />
                        </div>

                        {/* Tasks */}
                        <div className="mt-3">
                          {tasksToShow.length === 0 ? (
                            <div className="text-sm text-slate-600">No scheduled tasks for this client today.</div>
                          ) : (
                            <ul className="space-y-2">
                              {tasksToShow.map((t) => {
                                const checked = isChecked(dateISO, client.id, t.id);
                                return (
                                  <li
                                    key={t.id}
                                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2"
                                  >
                                    <label className="flex items-center gap-3 cursor-pointer select-none">
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => toggleTask(dateISO, client.id, t.id)}
                                        className="h-4 w-4"
                                      />
                                      <div>
                                        <div
                                          className={clsx(
                                            "text-sm",
                                            checked ? "line-through text-slate-500" : "text-slate-900"
                                          )}
                                        >
                                          {t.title}
                                        </div>
                                        <div className="text-xs text-slate-500">
                                          {t.kind === "milestone"
                                            ? "Milestone"
                                            : t.kind === "program"
                                            ? "Program"
                                            : t.kind === "onboarding"
                                            ? "Onboarding"
                                            : "Weekly"}
                                        </div>
                                      </div>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="text-xs text-slate-500">
              Cloud storage enabled. Staff logins are managed in Supabase Auth.
            </div>
          </div>
        </section>

        <footer className="mt-8 text-xs text-slate-500">
          Tip: Create staff accounts in Supabase → Authentication → Users.
        </footer>
      </div>
    </div>
  );
}
