'use client'

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

const STORAGE_KEY = "client-tracker:v6";

type ProgramType = "12w" | "6m";
type ClientGoal = "fat_loss" | "muscle_gain";

type Client = {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD
  program: ProgramType;
  goal?: ClientGoal;
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

// Monday-start week (common AU business week)
function getWeekStartISO(dateISO: string) {
  const d = parseISODate(dateISO);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const mondayBased = (day + 6) % 7; // Mon=0, Tue=1, ... Sun=6
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

function loadState(): { clients?: Client[]; taskRules?: TaskRules; completion?: Completion } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state: { clients: Client[]; taskRules: TaskRules; completion: Completion }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
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
      title: "Client is on their 2nd last week — reach out, confirm goals + next steps",
      kind: "program",
    });
  }
  if (week === totalWeeks) {
    tasks.push({
      id: "program:last-week",
      title: "Client is on their LAST week — check-in + set the next goal",
      kind: "program",
    });
  }

  return { week, tasks };
}

export default function Page() {
  // ---------- AUTH (force login) ----------
  const [authLoading, setAuthLoading] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUserEmail(data.user?.email ?? null);
      setAuthLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user?.email ?? null);
      setAuthLoading(false);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-600">
        Loading…
      </div>
    );
  }

  if (!userEmail) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="text-sm text-slate-600 mt-1">
            Enter your email and we’ll send you a secure magic link.
          </p>
          <SignIn />
        </div>
      </div>
    );
  }

  // ---------- APP ----------
  const todayISO = useMemo(() => formatISODate(new Date()), []);
  const [dateISO, setDateISO] = useState(todayISO);

  const [clients, setClients] = useState<Client[]>([]);
  const [taskRules, setTaskRules] = useState<TaskRules>(DEFAULT_TASK_RULES);
  const [completion, setCompletion] = useState<Completion>({});

  // Add client
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState(todayISO);
  const [newProgram, setNewProgram] = useState<ProgramType>("12w");
  const [newGoal, setNewGoal] = useState<ClientGoal>("fat_loss");

  // Add rule
  const [ruleType, setRuleType] = useState<"onboarding" | "weekly" | "week">("onboarding");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleDay, setRuleDay] = useState(0);
  const [ruleWeek, setRuleWeek] = useState(3);

  // Filters / view (day/week removed earlier; only keep all/incomplete)
  const [taskFilter, setTaskFilter] = useState<"all" | "incomplete">("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "week" | "start" | "incomplete">("week");

  // Overdue lookback
  const OVERDUE_LOOKBACK_DAYS = 30;

  useEffect(() => {
    const st = loadState();
    if (st?.clients) {
      setClients(
        st.clients.map((c) => ({
          ...c,
          program: (c.program as ProgramType) || "12w",
          goal: (c.goal as ClientGoal) || "fat_loss",
          notes: typeof c.notes === "string" ? c.notes : "",
        }))
      );
    }
    if (st?.taskRules) setTaskRules(normalizeRules(st.taskRules));
    if (st?.completion) setCompletion(st.completion);
  }, []);

  useEffect(() => {
    saveState({ clients, taskRules, completion });
  }, [clients, taskRules, completion]);

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

    const c: Client = {
      id: uid(),
      name,
      startDate: newStart,
      program: newProgram,
      goal: newGoal,
      notes: "",
    };
    setClients((prev) => [...prev, c]);
    setNewName("");
    setNewStart(todayISO);
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
      if (ruleType === "onboarding") {
        return { ...safe, onboarding: [...safe.onboarding, { id, day: Number(ruleDay), title }] };
      }
      if (ruleType === "weekly") {
        return { ...safe, weekly: [...safe.weekly, { id, day: Number(ruleDay), title }] };
      }
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

  const dayName = DAY_NAMES[parseISODate(dateISO).getDay()];

  // Build base rows (unfiltered)
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

  // Count incomplete for sorting and summary
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl p-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Client Tracker</h1>
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

            <div className="rounded-2xl bg-white shadow-sm border border-slate-200 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Signed in</div>
              <div className="mt-1 flex items-center gap-3">
                <div className="text-sm text-slate-700 max-w-[220px] truncate" title={userEmail || ""}>
                  {userEmail}
                </div>
                <button
                  onClick={async () => {
                    await supabase.auth.signOut();
                    window.location.reload();
                  }}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-100"
                >
                  Log out
                </button>
              </div>
            </div>
          </div>
        </header>

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
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Tasks</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    Day view for {dayName} ({dateISO})
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 sm:items-center w-full md:w-auto">
                  <div className="flex items-center justify-between w-full md:w-auto gap-2">
                    {/* All / Incomplete hard left */}
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

                    {/* Sort hard right */}
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

                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name or notes…"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-sm w-full sm:w-[360px]"
                  />
                </div>
              </div>

              <div className="mt-3 text-sm text-slate-600">
                Clients shown: <span className="font-medium text-slate-900">{sortedRows.length}</span>
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
                              Start: {client.startDate}
                            </span>
                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              End: {getProgramEndDateISO(client)}
                            </span>
                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              Goal: {client.goal === "muscle_gain" ? "Muscle gain" : "Fat loss"}
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
              Tip: If you need cloud syncing (shared across devices), we’ll wire storage to Supabase tables next.
            </div>
          </div>
        </section>

        <footer className="mt-8 text-xs text-slate-500">
          Logged in as: {userEmail}
        </footer>
      </div>
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendLink() {
    setError(null);
    const e = email.trim();
    if (!e) return;

    setSending(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: e,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });
    setSending(false);

    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="mt-4 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wide text-slate-500">Email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="staff@yourcompany.com"
          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      <button
        onClick={sendLink}
        disabled={sending}
        className="w-full rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-60"
      >
        {sending ? "Sending…" : "Send login link"}
      </button>

      {sent ? (
        <div className="text-sm text-slate-700">
          Check your email for the login link.
        </div>
      ) : null}

      {error ? <div className="text-sm text-red-600">{error}</div> : null}
    </div>
  );
}
