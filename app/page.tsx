'use client';

import React, { useEffect, useMemo, useRef, useState } from "react";

// -------------------- Types --------------------

type ProgramType = "12w" | "6m";
type ClientGoal = "fat_loss" | "muscle_gain";

type Client = {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD
  program: ProgramType;
  goal: ClientGoal;
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

// -------------------- Constants --------------------

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

// -------------------- Helpers --------------------

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

function isBeforeISO(aISO: string, bISO: string) {
  return aISO < bISO;
}

function isAfterISO(aISO: string, bISO: string) {
  return aISO > bISO;
}

// Monday-start week
function getWeekStartISO(dateISO: string) {
  const d = parseISODate(dateISO);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const mondayBased = (day + 6) % 7; // Mon=0..Sun=6
  d.setDate(d.getDate() - mondayBased);
  return formatISODate(d);
}

function getWeekDates(dateISO: string) {
  const start = getWeekStartISO(dateISO);
  return Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
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

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// returns the most recent day-of-week strictly BEFORE a given date
function getPreviousDowBefore(dateISO: string, dow: number) {
  const d = parseISODate(dateISO);
  d.setDate(d.getDate() - 1);
  while (d.getDay() !== dow) d.setDate(d.getDate() - 1);
  return formatISODate(d);
}

function generateTasksForClientOnDate(client: Client, dateISO: string, rules: TaskRules) {
  const { onboarding, weekly, week: weekRules } = normalizeRules(rules);

  // UPCOMING clients (date before start): only pre-start weekend onboarding tasks
  if (isBeforeISO(dateISO, client.startDate)) {
    const preSatISO = getPreviousDowBefore(client.startDate, 6);
    const preSunISO = getPreviousDowBefore(client.startDate, 0);

    const tasks: Task[] = [];
    if (dateISO === preSatISO) {
      for (const r of onboarding) if (r.day === 6) tasks.push({ id: `rule:${r.id}`, title: r.title, kind: "onboarding" });
    }
    if (dateISO === preSunISO) {
      for (const r of onboarding) if (r.day === 0) tasks.push({ id: `rule:${r.id}`, title: r.title, kind: "onboarding" });
    }
    return { week: 0, tasks, upcoming: true as const };
  }

  const date = parseISODate(dateISO);
  const day = date.getDay();
  const week = getClientWeek(client.startDate, date);

  const tasks: Task[] = [];

  // Onboarding (Week 1 only)
  if (week === 1) {
    for (const r of onboarding) if (r.day === day) tasks.push({ id: `rule:${r.id}`, title: r.title, kind: "onboarding" });
  }

  // Weekly
  for (const r of weekly) if (r.day === day) tasks.push({ id: `rule:${r.id}`, title: r.title, kind: "weekly" });

  // Milestones
  for (const r of weekRules) if (r.week === week) tasks.push({ id: `rule:${r.id}`, title: r.title, kind: "milestone" });

  // Program reminders (2nd last + last week)
  const totalWeeks = getProgramTotalWeeks(client);
  if (week === totalWeeks - 1) {
    tasks.push({
      id: "program:second-last-week",
      title: "Client is on their 2nd last week — reach out, check happiness, set next goal",
      kind: "program",
    });
  }
  if (week === totalWeeks) {
    tasks.push({
      id: "program:last-week",
      title: "Client is on their LAST week — review results + agree next goal / renewal",
      kind: "program",
    });
  }

  return { week, tasks, upcoming: false as const };
}

// -------------------- Cloud State (via /api/state) --------------------

async function fetchCloudState(): Promise<{ clients?: Client[]; taskRules?: TaskRules; completion?: Completion } | null> {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const json = await res.json();
    return (json?.state ?? null) as any;
  } catch {
    return null;
  }
}

async function saveCloudState(state: { clients: Client[]; taskRules: TaskRules; completion: Completion }) {
  const res = await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Save failed: ${res.status} ${t}`);
  }
}

// -------------------- Page --------------------

export default function Page() {
  // ✅ ALL hooks must be above any conditional return

  const [mounted, setMounted] = useState(false);

  const [todayISO, setTodayISO] = useState<string>("");
  const [dateISO, setDateISO] = useState<string>("");

  const [clients, setClients] = useState<Client[]>([]);
  const [taskRules, setTaskRules] = useState<TaskRules>(DEFAULT_TASK_RULES);
  const [completion, setCompletion] = useState<Completion>({});

  // Add client
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState<string>("");
  const [newProgram, setNewProgram] = useState<ProgramType>("12w");
  const [newGoal, setNewGoal] = useState<ClientGoal>("fat_loss");

  // Add rule
  const [ruleType, setRuleType] = useState<"onboarding" | "weekly" | "week">("onboarding");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleDay, setRuleDay] = useState(0);
  const [ruleWeek, setRuleWeek] = useState(3);

  // Filters / view
  const [taskFilter, setTaskFilter] = useState<"all" | "incomplete">("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "week" | "start" | "incomplete">("week");

  // All clients page sorting ✅ moved up (was causing crash)
  const [allClientsSort, setAllClientsSort] = useState<"name" | "start" | "end">("name");

  // Overdue lookback
  const OVERDUE_LOOKBACK_DAYS = 30;

  // Simple "pages" (hamburger menu)
  const [activePage, setActivePage] = useState<"tracker" | "allClients">("tracker");
  const [menuOpen, setMenuOpen] = useState(false);

  // Pop-up reminder dismissal
  const [dismissProgramBanner, setDismissProgramBanner] = useState(false);

  // Cloud load/save guards
  const [cloudLoaded, setCloudLoaded] = useState(false);
  const skipNextSaveRef = useRef(true);

  // Mount + load cloud state
  useEffect(() => {
    (async () => {
      setMounted(true);

      const t = formatISODate(new Date());
      setTodayISO(t);
      setDateISO(t);
      setNewStart(t);

      const st = await fetchCloudState();

      if (st?.clients) {
        setClients(
          st.clients.map((c: any) => ({
            ...c,
            program: (c.program as ProgramType) || "12w",
            goal: (c.goal as ClientGoal) || "fat_loss",
            notes: typeof c.notes === "string" ? c.notes : "",
          }))
        );
      }

      if (st?.taskRules) setTaskRules(normalizeRules(st.taskRules));
      if (st?.completion) setCompletion(st.completion);

      setCloudLoaded(true);
      skipNextSaveRef.current = true;
    })();
  }, []);

  // Auto-save to cloud (debounced)
  useEffect(() => {
    if (!mounted || !cloudLoaded) return;

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    const t = setTimeout(() => {
      saveCloudState({ clients, taskRules, completion }).catch((e) => {
        console.error(e);
      });
    }, 400);

    return () => clearTimeout(t);
  }, [clients, taskRules, completion, mounted, cloudLoaded]);

  function isChecked(dateKey: string, clientId: string, taskId: string) {
    return !!completion?.[dateKey]?.[clientId]?.[taskId];
  }

  function toggleTask(dateKey: string, clientId: string, taskId: string) {
    setCompletion((prev) => {
      const next: Completion = { ...prev };
      const dateObj = { ...(next[dateKey] || {}) };
      const clientObj = { ...(dateObj[clientId] || {}) };
      clientObj[taskId] = !clientObj[taskId];
      dateObj[clientId] = clientObj;
      next[dateKey] = dateObj;
      return next;
    });
  }

  function addClient() {
    const name = newName.trim();
    if (!name) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newStart)) return;

    const c: Client = { id: uid(), name, startDate: newStart, program: newProgram, goal: newGoal, notes: "" };
    setClients((prev) => [...prev, c]);
    setNewName("");
    setNewStart(todayISO || formatISODate(new Date()));
    setNewProgram("12w");
    setNewGoal("fat_loss");
  }

  function removeClient(id: string) {
    setClients((prev) => prev.filter((c) => c.id !== id));
  }

  function updateClientNotes(id: string, notes: string) {
    setClients((prev) => prev.map((c) => (c.id === id ? { ...c, notes } : c)));
  }

  function addRule() {
    const title = ruleTitle.trim();
    if (!title) return;

    const id = uid();
    setTaskRules((prev) => {
      const safe = normalizeRules(prev);
      if (ruleType === "onboarding") return { ...safe, onboarding: [...safe.onboarding, { id, day: Number(ruleDay), title }] };
      if (ruleType === "weekly") return { ...safe, weekly: [...safe.weekly, { id, day: Number(ruleDay), title }] };
      return { ...safe, week: [...safe.week, { id, week: Math.max(1, Number(ruleWeek) || 1), title }] };
    });

    setRuleTitle("");
  }

  function deleteRule(type: keyof TaskRules, id: string) {
    setTaskRules((prev) => {
      const safe = normalizeRules(prev);
      return { ...safe, [type]: (safe[type] as any[]).filter((r) => r.id !== id) } as TaskRules;
    });
  }

  const weekDates = useMemo(() => (dateISO ? getWeekDates(dateISO) : []), [dateISO]);

  const upcomingClients = useMemo(() => {
    if (!dateISO) return [];
    return clients.filter((c) => isAfterISO(c.startDate, dateISO)).sort((a, b) => a.startDate.localeCompare(b.startDate));
  }, [clients, dateISO]);

  const activeClients = useMemo(() => {
    if (!dateISO) return [];
    return clients.filter((c) => !isAfterISO(c.startDate, dateISO)).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, dateISO]);

  const baseRows = useMemo(() => {
    if (!dateISO) return [];
    return activeClients.map((c) => {
      const day = generateTasksForClientOnDate(c, dateISO, taskRules);
      const week = weekDates.map((d) => generateTasksForClientOnDate(c, d, taskRules));
      return { client: c, day, week };
    });
  }, [activeClients, dateISO, taskRules, weekDates]);

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
      if (a.day.week !== b.day.week) return a.day.week - b.day.week;
      return a.client.name.localeCompare(b.client.name);
    });
    return rows;
  }, [searchedRows, sortBy, dateISO, completion]); // eslint-disable-line react-hooks/exhaustive-deps

  const progress = useMemo(() => {
    let total = 0;
    let done = 0;
    for (const row of sortedRows) {
      total += row.day.tasks.length;
      for (const t of row.day.tasks) if (isChecked(dateISO, row.client.id, t.id)) done += 1;
    }
    return { total, done };
  }, [sortedRows, dateISO, completion]);

  const programAlerts = useMemo(() => {
    const alerts: Array<{ client: Client; label: "secondLast" | "last" }> = [];
    for (const row of sortedRows) {
      const c = row.client;
      const week = row.day.week;
      const total = getProgramTotalWeeks(c);
      if (week === total - 1) alerts.push({ client: c, label: "secondLast" });
      if (week === total) alerts.push({ client: c, label: "last" });
    }
    return alerts;
  }, [sortedRows]);

  useEffect(() => {
    setDismissProgramBanner(false);
  }, [dateISO]);

  const overdue = useMemo(() => {
    const results: Array<{ client: Client; dateISO: string; week: number; task: Task }> = [];
    for (const row of sortedRows) {
      const c = row.client;
      for (let i = 1; i <= OVERDUE_LOOKBACK_DAYS; i++) {
        const dISO = addDaysISO(dateISO, -i);
        if (isBeforeISO(dISO, c.startDate)) continue;
        const { week, tasks } = generateTasksForClientOnDate(c, dISO, taskRules);
        for (const t of tasks) {
          if (!isChecked(dISO, c.id, t.id)) results.push({ client: c, dateISO: dISO, week, task: t });
        }
      }
    }
    results.sort((a, b) => (a.dateISO !== b.dateISO ? a.dateISO.localeCompare(b.dateISO) : a.client.name.localeCompare(b.client.name)));
    return results;
  }, [sortedRows, dateISO, completion, taskRules]);

  const allClientsSorted = useMemo(() => {
    const arr = [...clients];
    arr.sort((a, b) => {
      if (allClientsSort === "name") return a.name.localeCompare(b.name);
      if (allClientsSort === "start") return a.startDate.localeCompare(b.startDate);
      const ae = getProgramEndDateISO(a);
      const be = getProgramEndDateISO(b);
      return ae.localeCompare(be);
    });
    return arr;
  }, [clients, allClientsSort]);

  // ✅ Now it’s safe to conditionally return
  if (!mounted || !dateISO) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-6 text-sm text-slate-700">
          Loading…
        </div>
      </div>
    );
  }

  const dayName = DAY_NAMES[parseISODate(dateISO).getDay()];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl p-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Client Tracker</h1>
              <p className="text-slate-600 mt-1">Cloud saved (Supabase) • Accessible on any computer</p>
            </div>

            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="ml-auto rounded-xl border border-slate-200 bg-white shadow-sm px-3 py-2 hover:bg-slate-50"
                title="Menu"
              >
                <div className="flex flex-col gap-1">
                  <span className="block h-0.5 w-5 bg-slate-700" />
                  <span className="block h-0.5 w-5 bg-slate-700" />
                  <span className="block h-0.5 w-5 bg-slate-700" />
                </div>
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-2 w-52 rounded-2xl border border-slate-200 bg-white shadow-lg p-2 z-50">
                  <button
                    onClick={() => {
                      setActivePage("tracker");
                      setMenuOpen(false);
                    }}
                    className={clsx(
                      "w-full text-left rounded-xl px-3 py-2 text-sm hover:bg-slate-50",
                      activePage === "tracker" && "bg-slate-50 font-medium"
                    )}
                  >
                    Client Tracker
                  </button>
                  <button
                    onClick={() => {
                      setActivePage("allClients");
                      setMenuOpen(false);
                    }}
                    className={clsx(
                      "w-full text-left rounded-xl px-3 py-2 text-sm hover:bg-slate-50",
                      activePage === "allClients" && "bg-slate-50 font-medium"
                    )}
                  >
                    All Clients
                  </button>
                </div>
              )}
            </div>
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
          </div>
        </header>

        {activePage === "allClients" ? (
          <section className="mt-6 rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">All Clients</h2>
                <p className="text-sm text-slate-600 mt-1">A clean list of every client (sortable). Notes are editable here.</p>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600">Sort by:</label>
                <select
                  value={allClientsSort}
                  onChange={(e) => setAllClientsSort(e.target.value as any)}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="name">Alphabetical</option>
                  <option value="start">Start date</option>
                  <option value="end">End date</option>
                </select>
              </div>
            </div>

            <div className="mt-4 overflow-auto rounded-2xl border border-slate-200">
              <table className="min-w-[900px] w-full text-sm">
                <thead className="bg-slate-50">
                  <tr className="text-left">
                    <th className="p-3 font-semibold text-slate-700">Name</th>
                    <th className="p-3 font-semibold text-slate-700">Goal</th>
                    <th className="p-3 font-semibold text-slate-700">Start</th>
                    <th className="p-3 font-semibold text-slate-700">End</th>
                    <th className="p-3 font-semibold text-slate-700">Notes</th>
                    <th className="p-3 font-semibold text-slate-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allClientsSorted.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-slate-600">No clients yet.</td>
                    </tr>
                  ) : (
                    allClientsSorted.map((c) => (
                      <tr key={c.id} className="border-t border-slate-200">
                        <td className="p-3 font-medium">{c.name}</td>
                        <td className="p-3">{c.goal === "fat_loss" ? "Fat loss" : "Muscle gain"}</td>
                        <td className="p-3">{c.startDate}</td>
                        <td className="p-3">{getProgramEndDateISO(c)}</td>
                        <td className="p-3">
                          <textarea
                            value={c.notes || ""}
                            onChange={(e) => updateClientNotes(c.id, e.target.value)}
                            className="w-full min-w-[320px] rounded-xl border border-slate-300 px-3 py-2 text-sm min-h-[44px]"
                            placeholder="Notes…"
                          />
                        </td>
                        <td className="p-3">
                          <button
                            onClick={() => removeClient(c.id)}
                            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-100"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
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
                    onChange={(e) => setNewGoal(e.target.value as ClientGoal)}
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
                      {newStart ? getProgramEndDateISO({ startDate: newStart, program: newProgram }) : ""}
                    </span>
                  </div>
                </div>

                <button
                  onClick={addClient}
                  className="w-full rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-slate-800 active:bg-slate-950"
                >
                  Add client
                </button>

                {/* Upcoming */}
                <div className="rounded-xl bg-white border border-slate-200 p-3">
                  <div className="flex items-end justify-between gap-2">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-500">Upcoming clients</div>
                      <div className="text-sm text-slate-700 mt-1">
                        Clients with a future start date (they’ll get pre-start weekend tasks automatically).
                      </div>
                    </div>
                    <div className="text-sm text-slate-600">{upcomingClients.length}</div>
                  </div>

                  {upcomingClients.length === 0 ? (
                    <div className="mt-3 text-sm text-slate-600">No upcoming clients.</div>
                  ) : (
                    <div className="mt-3 space-y-2 max-h-[240px] overflow-auto pr-1">
                      {upcomingClients.map((c) => {
                        const preSat = getPreviousDowBefore(c.startDate, 6);
                        const preSun = getPreviousDowBefore(c.startDate, 0);
                        return (
                          <div key={c.id} className="rounded-xl border border-slate-200 bg-slate-50/40 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-slate-900">{c.name}</div>
                                <div className="text-xs text-slate-600 mt-0.5">
                                  Starts: {c.startDate} • Goal: {c.goal === "fat_loss" ? "Fat loss" : "Muscle gain"}
                                </div>
                                <div className="text-xs text-slate-500 mt-1">
                                  Pre-start tasks: {preSat} (Sat) + {preSun} (Sun)
                                </div>
                              </div>

                              <button
                                onClick={() => removeClient(c.id)}
                                className="shrink-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-100"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Rules */}
                <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Task rules</div>

                  <div className="mt-2 space-y-3">
                    <div>
                      <div className="text-xs font-medium text-slate-700">Onboarding rules (Week 1 only)</div>
                      <ul className="mt-1 text-sm text-slate-700 space-y-1 list-disc pl-5">
                        {normalizeRules(taskRules).onboarding.map((r) => (
                          <li key={r.id} className="flex items-center justify-between gap-2">
                            <span>{DAY_NAMES[r.day]}: {r.title}</span>
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
                            <span>{DAY_NAMES[r.day]}: {r.title}</span>
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
                            <span>Week {r.week}: {r.title}</span>
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
                              <option key={d} value={i}>{d}</option>
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
              <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold">Tasks</h2>
                      <p className="text-sm text-slate-600 mt-1">Day view for {dayName} ({dateISO})</p>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                      <div className="flex w-full sm:w-auto justify-between gap-2">
                        <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1">
                          <button
                            onClick={() => setTaskFilter("all")}
                            className={clsx("rounded-lg px-3 py-1.5 text-sm", taskFilter === "all" ? "bg-white border border-slate-200 shadow-sm" : "text-slate-600")}
                          >
                            All
                          </button>
                          <button
                            onClick={() => setTaskFilter("incomplete")}
                            className={clsx("rounded-lg px-3 py-1.5 text-sm", taskFilter === "incomplete" ? "bg-white border border-slate-200 shadow-sm" : "text-slate-600")}
                          >
                            Incomplete
                          </button>
                        </div>

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
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="text-sm text-slate-600">
                      Clients shown: <span className="font-medium text-slate-900">{sortedRows.length}</span>
                    </div>

                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search name or notes…"
                      className="rounded-xl border border-slate-300 px-3 py-2 text-sm w-full sm:w-80"
                    />
                  </div>
                </div>

                {!dismissProgramBanner && programAlerts.length > 0 && (
                  <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-amber-900">Program reminder (follow-up / next goal)</div>
                        <div className="text-sm text-amber-800 mt-1">
                          {programAlerts.map((a, idx) => (
                            <div key={`${a.client.id}-${a.label}-${idx}`}>
                              <span className="font-medium">{a.client.name}</span>{" "}
                              {a.label === "secondLast"
                                ? "is on their 2nd last week — reach out + set next goal."
                                : "is on their LAST week — review results + agree next goal / renewal."}
                            </div>
                          ))}
                        </div>
                      </div>

                      <button
                        onClick={() => setDismissProgramBanner(true)}
                        className="shrink-0 rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm hover:bg-amber-100/50"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
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
                              checked ? "bg-white border-slate-300 text-slate-600" : "bg-slate-900 border-slate-900 text-white"
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

                          <div className="mt-3">
                            <label className="text-xs uppercase tracking-wide text-slate-500">Notes</label>
                            <textarea
                              value={client.notes || ""}
                              onChange={(e) => updateClientNotes(client.id, e.target.value)}
                              placeholder="e.g., goals, injury, preferences, reminders..."
                              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm min-h-[70px]"
                            />
                          </div>

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
                                          <div className={clsx("text-sm", checked ? "line-through text-slate-500" : "text-slate-900")}>
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
                Note: This is now cloud-saved (Supabase). Data stays across devices.
              </div>
            </div>
          </section>
        )}

        <footer className="mt-8 text-xs text-slate-500">
          Tip: Open the site on another computer to confirm the same clients show up.
        </footer>
      </div>
    </div>
  );
}
