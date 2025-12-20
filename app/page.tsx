'use client'
'use client'

import React, { useEffect, useMemo, useState } from "react";

// Self-contained Client Tracker Dashboard (Next.js App Router page)
// - Local storage persistence (no backend)
// - Client week calculation from start date
// - Program length selector (12 weeks or 6 months) + end date
// - Task rules:
//    - onboarding (Week 1 only) day-of-week tasks
//    - weekly (repeating) day-of-week tasks
//    - week-based milestones (e.g., Week 3 referral)
// - Program reminders:
//    - 2nd last week and last week

const STORAGE_KEY = "client-tracker:v4";

type ProgramType = "12w" | "6m";

type Client = {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD
  program: ProgramType; // "12w" | "6m"
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

type Task = {
  id: string;
  title: string;
  kind: "onboarding" | "weekly" | "milestone" | "program";
};

type Completion = {
  [dateISO: string]: {
    [clientId: string]: {
      [taskId: string]: boolean;
    };
  };
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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

function formatISODate(d: Date) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prettyDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
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

function getClientWeek(startDateISO: string, today = new Date()) {
  const [y, m, d] = startDateISO.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const diffDays = daysBetween(start, today);
  return Math.max(1, Math.floor(diffDays / 7) + 1);
}

function addMonthsToISO(startISO: string, months: number) {
  const [y, m, d] = startISO.split("-").map(Number);
  const dt = new Date(y, m - 1, d);

  const targetMonth = dt.getMonth() + months;
  const y2 = dt.getFullYear() + Math.floor(targetMonth / 12);
  const m2 = ((targetMonth % 12) + 12) % 12;

  const out = new Date(y2, m2, dt.getDate()); // JS auto-clamps for short months
  return formatISODate(out);
}

function getProgramEndDateISO(client: Pick<Client, "startDate" | "program">) {
  const startISO = client.startDate;
  const program = client.program || "12w";
  if (program === "6m") {
    return addMonthsToISO(startISO, 6);
  }
  // 12 weeks
  const [y, m, d] = startISO.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(start);
  end.setDate(end.getDate() + 7 * 12);
  return formatISODate(end);
}

function getProgramTotalWeeks(client: Client) {
  const endISO = getProgramEndDateISO(client);
  const [sy, sm, sd] = client.startDate.split("-").map(Number);
  const [ey, em, ed] = endISO.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const totalDays = Math.max(1, daysBetween(start, end));
  return Math.max(1, Math.ceil(totalDays / 7));
}

function normalizeRules(rules: any): TaskRules {
  const safe = rules && typeof rules === "object" ? rules : {};
  return {
    onboarding: Array.isArray(safe.onboarding)
      ? safe.onboarding.filter(Boolean)
      : DEFAULT_TASK_RULES.onboarding,
    weekly: Array.isArray(safe.weekly)
      ? safe.weekly.filter(Boolean)
      : DEFAULT_TASK_RULES.weekly,
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

function generateDailyTasksForClient(client: Client, dateISO: string, rules: TaskRules) {
  const { onboarding, weekly, week: weekRules } = normalizeRules(rules);

  const [y, m, d] = dateISO.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay();
  const week = getClientWeek(client.startDate, date);

  const tasks: Task[] = [];

  // Onboarding (Week 1 only)
  if (week === 1) {
    for (const r of onboarding) {
      if (r.day === day) {
        tasks.push({
          id: `rule:${r.id}`,
          title: r.title,
          kind: "onboarding",
        });
      }
    }
  }

  // Repeating weekly
  for (const r of weekly) {
    if (r.day === day) {
      tasks.push({
        id: `rule:${r.id}`,
        title: r.title,
        kind: "weekly",
      });
    }
  }

  // Week-based milestones
  for (const r of weekRules) {
    if (r.week === week) {
      tasks.push({
        id: `rule:${r.id}`,
        title: r.title,
        kind: "milestone",
      });
    }
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

export default function Page() {
  const todayISO = useMemo(() => formatISODate(new Date()), []);
  const [dateISO, setDateISO] = useState(todayISO);

  const [clients, setClients] = useState<Client[]>([]);
  const [taskRules, setTaskRules] = useState<TaskRules>(DEFAULT_TASK_RULES);
  const [completion, setCompletion] = useState<Completion>({});

  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState(todayISO);
  const [newProgram, setNewProgram] = useState<ProgramType>("12w");

  // Add task rule form
  const [ruleType, setRuleType] = useState<"onboarding" | "weekly" | "week">("onboarding");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleDay, setRuleDay] = useState(0);
  const [ruleWeek, setRuleWeek] = useState(3);

  // Load state
  useEffect(() => {
    const st = loadState();
    if (st?.clients) {
      setClients(
        st.clients.map((c) => ({
          ...c,
          program: (c.program as ProgramType) || "12w",
        }))
      );
    }
    if (st?.taskRules) setTaskRules(normalizeRules(st.taskRules));
    if (st?.completion) setCompletion(st.completion);
  }, []);

  // Save state
  useEffect(() => {
    saveState({ clients, taskRules, completion });
  }, [clients, taskRules, completion]);

  const daySummary = useMemo(() => {
    const rows = clients.map((c) => {
      const { week, tasks } = generateDailyTasksForClient(c, dateISO, taskRules);
      return { client: c, week, tasks };
    });
    rows.sort((a, b) => (a.week - b.week) || a.client.name.localeCompare(b.client.name));
    return rows;
  }, [clients, dateISO, taskRules]);

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

    const c: Client = { id: uid(), name, startDate: newStart, program: newProgram };
    setClients((prev) => [...prev, c]);
    setNewName("");
    setNewStart(todayISO);
    setNewProgram("12w");
  }

  function removeClient(id: string) {
    setClients((prev) => prev.filter((c) => c.id !== id));
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

  const progress = useMemo(() => {
    let total = 0;
    let done = 0;
    for (const row of daySummary) {
      total += row.tasks.length;
      for (const t of row.tasks) {
        if (isChecked(dateISO, row.client.id, t.id)) done += 1;
      }
    }
    return { total, done };
  }, [daySummary, dateISO, completion]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl p-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Client Tracker</h1>
            <p className="text-slate-600 mt-1">
              Daily tasks generated from client start date • Saved locally in your browser
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
              <div className="text-xs uppercase tracking-wide text-slate-500">Today’s progress</div>
              <div className="mt-1 flex items-baseline gap-2">
                <div className="text-xl font-semibold">{progress.done}</div>
                <div className="text-sm text-slate-600">/ {progress.total} tasks done</div>
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
                        Rules are saved locally and will automatically show up in the daily to-do list.
                      </div>
                    </div>
                  </div>

                  <div className="text-xs text-slate-500">
                    Program reminders: 2nd last week + last week are generated automatically based on program length.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="lg:col-span-2">
            <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
              <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Daily to-do list</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    Generated for {DAY_NAMES[new Date(dateISO + "T00:00:00").getDay()]} ({dateISO}).
                  </p>
                </div>
                <div className="text-sm text-slate-600">
                  Clients: <span className="font-medium text-slate-900">{clients.length}</span>
                </div>
              </div>

              {clients.length === 0 ? (
                <div className="mt-6 rounded-2xl border border-dashed border-slate-300 p-8 text-center">
                  <div className="text-lg font-medium">No clients yet</div>
                  <div className="text-sm text-slate-600 mt-1">Add your first client on the left.</div>
                </div>
              ) : (
                <div className="mt-4 space-y-4">
                  {daySummary.map(({ client, week, tasks }) => (
                    <div key={client.id} className="rounded-2xl border border-slate-200 bg-slate-50/40 p-4">
                      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-3 flex-wrap">
                            <h3 className="text-base font-semibold">{client.name}</h3>
                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              Week {week}
                            </span>
                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              Start: {client.startDate}
                            </span>
                            <span className="rounded-full bg-white border border-slate-200 px-2.5 py-1 text-xs text-slate-700">
                              End: {getProgramEndDateISO(client)}
                            </span>
                          </div>
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
                        {tasks.length === 0 ? (
                          <div className="text-sm text-slate-600">No scheduled tasks for this client today.</div>
                        ) : (
                          <ul className="space-y-2">
                            {tasks.map((t) => {
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
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
              <h2 className="text-lg font-semibold">Notes / Next upgrades</h2>
              <ul className="mt-2 text-sm text-slate-700 space-y-1 list-disc pl-5">
                <li>Add login so only you can access it</li>
                <li>Sync to a database (Supabase/Firebase) so it works across devices</li>
                <li>Automate reminders and message templates</li>
                <li>Add client notes, goals, check-in metrics</li>
              </ul>
            </div>
          </div>
        </section>

        <footer className="mt-8 text-xs text-slate-500">
          Tip: This version saves to <span className="font-medium">your browser</span>. If you open it on another device or clear site data, it won’t carry over.
        </footer>
      </div>
    </div>
  );
}
