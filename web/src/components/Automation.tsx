"use client";
import {
  json,
  request,
  type CrashInfo,
  type CrashPolicy,
  type Schedule,
  type ScheduleRun,
  type ScheduleTask,
  type ServerEvent,
} from "@/lib/api";
import { buildCron, describeCron, describeInterval, weekdayNames, type Preset } from "@/lib/cron";
import { fmtAgo, fmtTime } from "@/lib/format";
import { ArrowDown, ArrowUp, Check, CircleAlert, CircleCheck, Clock, History, Pencil, Play, Plus, RotateCw, Terminal, Timer, Trash2, TriangleAlert, Archive, Power, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Drawer, useConfirm } from "./feedback";
import { Button, Card, Empty, ErrorNotice, Notice, Segmented, State, Status, Switch, useLoad } from "./shared";
import { useToast } from "./toast";

/* ---------- Helpers ---------- */

type Step =
  | { action: "power"; power: "start" | "stop" | "restart" | "kill" }
  | { action: "command"; command: string }
  | { action: "backup" }
  | { action: "wait"; seconds: string };

const powerLabel = { start: "Start", stop: "Stop", restart: "Restart", kill: "Force stop" } as const;

function stepText(t: ScheduleTask | Step) {
  switch (t.action) {
    case "power":
      return powerLabel[t.power];
    case "command":
      return t.command.length > 28 ? `${t.command.slice(0, 27)}…` : t.command;
    case "backup":
      return "Back up";
    case "wait":
      return `Wait ${t.seconds} s`;
  }
}
const StepIcon = ({ action }: { action: ScheduleTask["action"] }) => {
  const Icon = { power: Power, command: Terminal, backup: Archive, wait: Timer }[action];
  return <Icon aria-hidden="true" />;
};

function scheduleName(s: Schedule) {
  if (s.name) return s.name;
  const parts = s.tasks.slice(0, 3).map(stepText);
  return `${parts.join(" → ")}${s.tasks.length > 3 ? " …" : ""}` || "Schedule";
}
const triggerText = (s: Pick<Schedule, "cron" | "intervalMinutes" | "timezone">) =>
  s.cron ? describeCron(s.cron, s.timezone) : s.intervalMinutes ? describeInterval(s.intervalMinutes) : "—";

function zones(extra: string[]) {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") || [];
  } catch {
    /* older browsers */
  }
  return ["UTC", ...new Set([...extra, ...list].filter((z) => z && z !== "UTC"))];
}
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/* ---------- Tab ---------- */

export default function Automation({ id }: { id: string }) {
  return (
    <>
      <Schedules id={id} />
      <CrashProtection id={id} />
    </>
  );
}

/* ---------- Schedules ---------- */

function Schedules({ id }: { id: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad<Schedule[]>(`/servers/${id}/schedules`);
  const storage = useLoad<{ enabled: boolean }>("/storage/status");
  const backupOk = storage.data ? storage.data.enabled : true;
  const [editing, setEditing] = useState<Schedule | "new" | null>(null),
    [history, setHistory] = useState<Schedule | null>(null),
    [busy, setBusy] = useState("");
  const list = Array.isArray(data) ? data : [];

  async function toggle(s: Schedule, enabled: boolean) {
    setBusy(s.id);
    try {
      await json("PATCH", `/servers/${id}/schedules/${s.id}`, { enabled });
      await reload();
    } catch (e) {
      toast({ tone: "bad", title: "Couldn’t change the schedule", description: (e as Error).message });
    } finally {
      setBusy("");
    }
  }
  async function runNow(s: Schedule) {
    setBusy(`run-${s.id}`);
    try {
      await json("POST", `/servers/${id}/schedules/${s.id}/run`);
      toast({ tone: "busy", title: `Running “${scheduleName(s)}”…`, description: "Open History to follow it." });
      setTimeout(() => void reload(), 2500);
    } catch (e) {
      toast({ tone: "bad", title: "Couldn’t start it", description: (e as Error).message });
    } finally {
      setBusy("");
    }
  }
  async function remove(s: Schedule) {
    if (!(await confirm("It stops running immediately. Past runs are kept for a while.", { title: `Delete “${scheduleName(s)}”?`, confirmLabel: "Delete" }))) return;
    try {
      await request(`/servers/${id}/schedules/${s.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: "Schedule deleted" });
      void reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  }

  return (
    <>
      <Card
        title="Schedules"
        description="Run power actions, console commands and backups on a timer."
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus /> New schedule
          </Button>
        }
        flush
      >
        <State loading={loading} error={error} rows={3}>
          {list.length ? (
            <ul className="sched-list">
              {list.map((s) => (
                <li className={`sched${s.enabled ? "" : " is-off"}`} key={s.id}>
                  <div className="sched__head">
                    <div className="sched__title">
                      <strong>{scheduleName(s)}</strong>
                      <span className="muted small">
                        <Clock aria-hidden="true" /> {triggerText(s)}
                      </span>
                    </div>
                    <Switch checked={s.enabled} busy={busy === s.id} onChange={(v) => void toggle(s, v)} label={`${scheduleName(s)} is ${s.enabled ? "on" : "off"}`} />
                  </div>
                  <div className="sched__steps" aria-label="Steps">
                    {s.tasks.map((t, i) => (
                      <span className="tag sched__step" key={i} title={t.action === "command" ? t.command : undefined}>
                        <StepIcon action={t.action} />
                        {stepText(t)}
                      </span>
                    ))}
                  </div>
                  <div className="sched__meta small">
                    <span className="faint">
                      Next run:{" "}
                      {s.enabled && s.nextRunAt ? (
                        <time dateTime={s.nextRunAt} title={fmtTime(s.nextRunAt)} className="muted">
                          {fmtAgo(s.nextRunAt)}
                        </time>
                      ) : (
                        <span className="muted">Paused</span>
                      )}
                    </span>
                    <span className="faint">
                      Last run:{" "}
                      {s.lastRunAt ? (
                        <>
                          <Status tone={s.lastStatus === "succeeded" ? "ok" : s.lastStatus === "failed" ? "bad" : s.lastStatus === "running" ? "busy" : "neutral"} label={s.lastStatus === "succeeded" ? "Succeeded" : s.lastStatus === "failed" ? "Failed" : s.lastStatus === "skipped" ? "Skipped" : s.lastStatus || "—"} />{" "}
                          <time dateTime={s.lastRunAt} title={fmtTime(s.lastRunAt)} className="muted">
                            {fmtAgo(s.lastRunAt)}
                          </time>
                        </>
                      ) : (
                        <span className="muted">Never</span>
                      )}
                    </span>
                    {s.lastStatus === "failed" && s.lastError ? <span className="sched__error">{s.lastError}</span> : null}
                  </div>
                  <div className="sched__actions">
                    <Button size="sm" busy={busy === `run-${s.id}`} onClick={() => void runNow(s)}>
                      {busy === `run-${s.id}` ? null : <Play />}
                      Run now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setHistory(s)}>
                      <History /> History
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                      <Pencil /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(s)}>
                      <Trash2 /> Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No schedules yet">Create one to restart a server every night, back it up weekly or run a command on a timer.</Empty>
          )}
        </State>
      </Card>
      <ScheduleEditor
        serverId={id}
        target={editing}
        backupOk={backupOk}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void reload();
        }}
      />
      <RunHistory serverId={id} schedule={history} onClose={() => setHistory(null)} />
    </>
  );
}

/* ---------- Editor ---------- */

function ScheduleEditor({ serverId, target, backupOk, onClose, onSaved }: { serverId: string; target: Schedule | "new" | null; backupOk: boolean; onClose: () => void; onSaved: () => void }) {
  return (
    <Drawer open={!!target} onOpenChange={(o) => !o && onClose()} title={target === "new" ? "New schedule" : "Edit schedule"} description="Choose when it runs and what it does." wide>
      {target ? <EditorForm key={target === "new" ? "new" : target.id} serverId={serverId} existing={target === "new" ? null : target} backupOk={backupOk} onClose={onClose} onSaved={onSaved} /> : null}
    </Drawer>
  );
}

function EditorForm({ serverId, existing, backupOk, onClose, onSaved }: { serverId: string; existing: Schedule | null; backupOk: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(existing?.name || ""),
    [mode, setMode] = useState<"cron" | "interval">(existing && !existing.cron ? "interval" : "cron"),
    [expr, setExpr] = useState(existing?.cron || "0 4 * * *"),
    [tz, setTz] = useState(existing?.timezone || browserZone()),
    [minutes, setMinutes] = useState(String(existing?.intervalMinutes || 60)),
    [preset, setPreset] = useState<Preset | "custom">(existing?.cron ? "custom" : "daily"),
    [time, setTime] = useState("04:00"),
    [every, setEvery] = useState(6),
    [dow, setDow] = useState(1),
    [steps, setSteps] = useState<Step[]>(() =>
      existing ? existing.tasks.map((t): Step => (t.action === "wait" ? { action: "wait", seconds: String(t.seconds) } : t)) : [{ action: "power", power: "restart" }],
    ),
    [missed, setMissed] = useState<"skip" | "run">(existing?.missed || "skip"),
    [enabled, setEnabled] = useState(existing?.enabled ?? true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const zoneList = useMemo(() => zones([tz, browserZone()]), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Presets write the expression; typing in it switches back to "custom".
  const applyPreset = (p: Preset | "custom", t = time, e = every, d = dow) => {
    setPreset(p);
    if (p !== "custom") setExpr(buildCron(p, { time: t, every: e, dow: d }));
  };

  // Next runs, straight from the API so what you see is what will happen.
  const [preview, setPreview] = useState<{ next: string[] } | { error: string } | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (mode !== "cron" || !expr.trim()) {
      setPreview(null);
      return;
    }
    const ticket = ++seq.current;
    const t = setTimeout(() => {
      request<{ next: string[] }>(`/cron/preview?expr=${encodeURIComponent(expr.trim())}&tz=${encodeURIComponent(tz)}`)
        .then((r) => seq.current === ticket && setPreview(r))
        .catch((e) => seq.current === ticket && setPreview({ error: (e as Error).message }));
    }, 350);
    return () => clearTimeout(t);
  }, [mode, expr, tz]);

  const move = (i: number, by: -1 | 1) =>
    setSteps((xs) => {
      const j = i + by;
      if (j < 0 || j >= xs.length) return xs;
      const next = [...xs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const setStep = (i: number, step: Step) => setSteps((xs) => xs.map((x, j) => (j === i ? step : x)));

  const minutesNum = Number(minutes);
  const problems: string[] = [];
  if (mode === "interval" && (!Number.isInteger(minutesNum) || minutesNum < 5 || minutesNum > 10080)) problems.push("The interval must be 5 to 10080 minutes.");
  if (mode === "cron" && !expr.trim()) problems.push("Enter a cron expression.");
  if (mode === "cron" && preview && "error" in preview) problems.push(preview.error);
  if (!steps.length) problems.push("Add at least one step.");
  steps.forEach((s, i) => {
    if (s.action === "command" && !s.command.trim()) problems.push(`Step ${i + 1}: enter a command.`);
    if (s.action === "wait" && !(Number.isInteger(Number(s.seconds)) && Number(s.seconds) >= 1 && Number(s.seconds) <= 3600)) problems.push(`Step ${i + 1}: wait 1 to 3600 seconds.`);
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (problems.length) return;
    setBusy(true);
    setError("");
    try {
      const tasks = steps.map((s) => (s.action === "wait" ? { action: "wait", seconds: Number(s.seconds) } : s.action === "command" ? { action: "command", command: s.command.trim() } : s));
      const body = { name: name.trim(), ...(mode === "cron" ? { cron: expr.trim() } : { intervalMinutes: minutesNum }), timezone: tz, tasks, missed, enabled };
      await json(existing ? "PATCH" : "POST", existing ? `/servers/${serverId}/schedules/${existing.id}` : `/servers/${serverId}/schedules`, body);
      toast({ tone: "ok", title: existing ? "Schedule saved" : "Schedule created" });
      onSaved();
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const fmtRun = (iso: string) => {
    try {
      return new Date(iso).toLocaleString([], { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
    } catch {
      return fmtTime(iso);
    }
  };

  return (
    <form className="form" onSubmit={save} noValidate>
      <label className="field">
        <span className="field__label">Name <span className="faint">(optional)</span></span>
        <input className="input" value={name} maxLength={60} placeholder="Nightly restart" onChange={(e) => setName(e.target.value)} />
      </label>

      <section className="form-section" aria-labelledby="sch-when">
        <h3 id="sch-when">When</h3>
        <Segmented
          label="Trigger"
          value={mode}
          onChange={setMode}
          options={[
            { value: "cron", label: "Cron schedule" },
            { value: "interval", label: "Every N minutes" },
          ]}
        />
        {mode === "interval" ? (
          <label className="field">
            <span className="field__label">Every</span>
            <div className="input-unit">
              <input className="input" inputMode="numeric" value={minutes} aria-invalid={mode === "interval" && problems.some((p) => p.startsWith("The interval"))} onChange={(e) => setMinutes(e.target.value)} />
              <span aria-hidden="true">minutes</span>
            </div>
            <span className="field__hint">At least 5 minutes. {Number.isInteger(minutesNum) && minutesNum >= 5 ? `That’s ${describeInterval(minutesNum).toLowerCase()}.` : ""}</span>
          </label>
        ) : (
          <>
            <div className="form-grid">
              <label className="field">
                <span className="field__label">Preset</span>
                <select className="input select" value={preset} onChange={(e) => applyPreset(e.target.value as Preset | "custom")}>
                  <option value="custom">Custom expression</option>
                  <option value="daily">Every day at…</option>
                  <option value="hours">Every N hours</option>
                  <option value="weekdays">Weekdays at…</option>
                  <option value="weekly">Weekly on…</option>
                </select>
              </label>
              {preset === "hours" ? (
                <label className="field">
                  <span className="field__label">Hours between runs</span>
                  <input className="input" type="number" min={1} max={23} value={every} onChange={(e) => { const n = Number(e.target.value) || 1; setEvery(n); applyPreset("hours", time, n, dow); }} />
                </label>
              ) : null}
              {preset === "weekly" ? (
                <label className="field">
                  <span className="field__label">Day</span>
                  <select className="input select" value={dow} onChange={(e) => { const d = Number(e.target.value); setDow(d); applyPreset("weekly", time, every, d); }}>
                    {weekdayNames.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {preset === "daily" || preset === "weekdays" || preset === "weekly" || preset === "hours" ? (
                <label className="field">
                  <span className="field__label">{preset === "hours" ? "At minute" : "At"}</span>
                  <input className="input" type="time" value={time} onChange={(e) => { setTime(e.target.value); applyPreset(preset, e.target.value, every, dow); }} />
                </label>
              ) : null}
            </div>
            <div className="form-grid">
              <label className="field">
                <span className="field__label">Cron expression</span>
                <input
                  className="input mono"
                  value={expr}
                  spellCheck={false}
                  aria-invalid={!!preview && "error" in preview}
                  onChange={(e) => {
                    setExpr(e.target.value);
                    setPreset("custom");
                  }}
                />
                <span className="field__hint">Minute, hour, day of month, month, day of week.</span>
              </label>
              <label className="field">
                <span className="field__label">Time zone</span>
                <select className="input select" value={tz} onChange={(e) => setTz(e.target.value)}>
                  {zoneList.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="sched-preview" aria-live="polite">
              {preview && "error" in preview ? (
                <span className="inline-error">{preview.error}</span>
              ) : preview ? (
                <>
                  <strong className="small">{describeCron(expr, tz)}</strong>
                  <span className="small faint">Next runs</span>
                  <ol>
                    {preview.next.map((n) => (
                      <li key={n} className="small num">
                        {fmtRun(n)}
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <span className="small faint">Checking…</span>
              )}
            </div>
          </>
        )}
      </section>

      <section className="form-section" aria-labelledby="sch-steps">
        <h3 id="sch-steps">Steps</h3>
        <ol className="sched-steps">
          {steps.map((s, i) => (
            <li key={i} className="sched-step">
              <span className="sched-step__n" aria-hidden="true">{i + 1}</span>
              <div className="sched-step__body">
                {s.action === "power" ? (
                  <label className="field">
                    <span className="field__label">Power</span>
                    <select className="input select" value={s.power} onChange={(e) => setStep(i, { action: "power", power: e.target.value as "start" })}>
                      {(Object.keys(powerLabel) as (keyof typeof powerLabel)[]).map((p) => (
                        <option key={p} value={p}>
                          {powerLabel[p]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : s.action === "command" ? (
                  <label className="field">
                    <span className="field__label">Console command</span>
                    <input className="input mono" value={s.command} maxLength={1024} placeholder="say Restarting in 5 minutes" onChange={(e) => setStep(i, { action: "command", command: e.target.value.replace(/[\r\n]/g, "") })} />
                  </label>
                ) : s.action === "wait" ? (
                  <label className="field">
                    <span className="field__label">Wait</span>
                    <div className="input-unit">
                      <input className="input" inputMode="numeric" value={s.seconds} onChange={(e) => setStep(i, { action: "wait", seconds: e.target.value })} />
                      <span aria-hidden="true">seconds</span>
                    </div>
                  </label>
                ) : (
                  <div className="field">
                    <span className="field__label">Back up</span>
                    <span className="small muted">Takes a backup and waits for it to finish before the next step.</span>
                  </div>
                )}
              </div>
              <div className="sched-step__tools">
                <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </button>
                <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown />
                </button>
                <button type="button" className="btn btn--ghost btn--icon btn--sm tpl-remove" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))}>
                  <X />
                </button>
              </div>
            </li>
          ))}
        </ol>
        <div className="btn-group" role="group" aria-label="Add a step">
          <Button size="sm" disabled={steps.length >= 20} onClick={() => setSteps((xs) => [...xs, { action: "power", power: "restart" }])}>
            <Power /> Power
          </Button>
          <Button size="sm" disabled={steps.length >= 20} onClick={() => setSteps((xs) => [...xs, { action: "command", command: "" }])}>
            <Terminal /> Command
          </Button>
          <Button size="sm" disabled={steps.length >= 20 || !backupOk} onClick={() => setSteps((xs) => [...xs, { action: "backup" }])} title={backupOk ? undefined : "Backups need object storage"}>
            <Archive /> Backup
          </Button>
          <Button size="sm" disabled={steps.length >= 20} onClick={() => setSteps((xs) => [...xs, { action: "wait", seconds: "30" }])}>
            <Timer /> Wait
          </Button>
        </div>
        {!backupOk && <p className="small faint">Backup steps are unavailable because object storage is off. An administrator can turn it on in Settings.</p>}
        {steps.length >= 20 && <p className="small faint">A schedule can have up to 20 steps.</p>}
      </section>

      <section className="form-section" aria-labelledby="sch-more">
        <h3 id="sch-more">If the panel was down at run time</h3>
        <Segmented
          label="Missed runs"
          value={missed}
          onChange={setMissed}
          options={[
            { value: "skip", label: "Skip it" },
            { value: "run", label: "Run once when it’s back" },
          ]}
        />
        <div className="toggle-row">
          <div>
            <strong>Turned on</strong>
            <small>Paused schedules don’t run until you turn them on.</small>
          </div>
          <Switch label="Turned on" checked={enabled} onChange={setEnabled} />
        </div>
      </section>

      {problems.length > 0 && (
        <div className="tpl-issues" role="status">
          <strong>Fix these before saving</strong>
          <ul>
            {problems.slice(0, 4).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNotice message={error} />
      <div className="form__actions">
        <Button type="submit" variant="primary" busy={busy} disabled={problems.length > 0}>
          {existing ? "Save changes" : "Create schedule"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/* ---------- Run history ---------- */

function RunHistory({ serverId, schedule, onClose }: { serverId: string; schedule: Schedule | null; onClose: () => void }) {
  const [shown, setShown] = useState(schedule);
  useEffect(() => {
    if (schedule) setShown(schedule);
  }, [schedule]);
  return (
    <Drawer open={!!schedule} onOpenChange={(o) => !o && onClose()} title="History" description={shown ? scheduleName(shown) : undefined} wide>
      {shown ? <RunList key={shown.id} serverId={serverId} schedule={shown} /> : null}
    </Drawer>
  );
}

function RunList({ serverId, schedule }: { serverId: string; schedule: Schedule }) {
  const { data, error, loading, reload } = useLoad<ScheduleRun[]>(`/servers/${serverId}/schedules/${schedule.id}/runs?limit=25`);
  const runs = Array.isArray(data) ? data : [];
  const running = runs.some((r) => r.state === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [running, reload]);
  return (
    <>
      <div className="toolbar">
        <span className="small faint">{running ? "Running now…" : "Most recent first"}</span>
        <Button size="sm" onClick={() => void reload()}>
          Refresh
        </Button>
      </div>
      <State loading={loading} error={error} rows={4}>
        {runs.length ? (
          <ul className="run-list">
            {runs.map((r) => (
              <li key={r.id} className="run">
                <div className="run__head">
                  <Status tone={r.state === "succeeded" ? "ok" : r.state === "failed" ? "bad" : r.state === "running" ? "busy" : "neutral"} label={r.state === "succeeded" ? "Succeeded" : r.state === "failed" ? "Failed" : r.state === "running" ? "Running" : "Skipped"} />
                  <span className="small faint">{r.trigger === "manual" ? "Started by hand" : "On schedule"}</span>
                  <time className="small faint" dateTime={r.startedAt} title={fmtTime(r.startedAt)}>
                    {fmtAgo(r.startedAt)}
                  </time>
                </div>
                {r.error ? <p className="small sched__error">{r.error}</p> : null}
                {r.results?.length ? (
                  <ol className="run__steps">
                    {r.results.map((x, i) => (
                      <li key={i} className={x.ok ? "" : "is-bad"}>
                        {x.ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                        <span>
                          <span className="muted">Step {x.step + 1}</span> · {x.detail}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No runs yet">Runs appear here once this schedule has fired or you’ve used Run now.</Empty>
        )}
      </State>
    </>
  );
}

/* ---------- Crash protection ---------- */

const modeCopy = {
  off: "A crashed server stays down until someone starts it.",
  "on-failure": "Restarts the server when it stops unexpectedly, such as a crash or running out of memory.",
  always: "Also restarts the server when it stops by itself, even without an error. Stopping it from the panel still works.",
} as const;

function CrashProtection({ id }: { id: string }) {
  const toast = useToast();
  const info = useLoad<CrashInfo>(`/servers/${id}/crash-policy`);
  const events = useLoad<ServerEvent[]>(`/servers/${id}/events?limit=20`);
  const [mode, setMode] = useState<CrashPolicy["mode"]>("off"),
    [max, setMax] = useState("3"),
    [window_, setWindow] = useState("10"),
    [pauses, setPauses] = useState("5, 15, 60"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loopCleared, setLoopCleared] = useState(false);
  const data = info.data;
  const fill = (p: CrashPolicy) => {
    setMode(p.mode);
    setMax(String(p.maxRestarts));
    setWindow(String(p.windowMinutes));
    setPauses(p.backoffSeconds.join(", "));
  };
  useEffect(() => {
    if (data) fill(data.policy);
  }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    const backoff = pauses.split(/[\s,]+/).filter(Boolean).map(Number);
    const bad = (n: number, lo: number, hi: number) => !Number.isInteger(n) || n < lo || n > hi;
    if (bad(Number(max), 1, 20)) return setError("Restarts must be a whole number from 1 to 20.");
    if (bad(Number(window_), 1, 1440)) return setError("The time window must be 1 to 1440 minutes.");
    if (!backoff.length || backoff.length > 10 || backoff.some((n) => bad(n, 5, 3600))) return setError("Pauses are 1 to 10 numbers between 5 and 3600 seconds, separated by commas.");
    setBusy(true);
    try {
      const r = (await json("PUT", `/servers/${id}/crash-policy`, { mode, maxRestarts: Number(max), windowMinutes: Number(window_), backoffSeconds: backoff })) as CrashInfo;
      fill(r.policy);
      setLoopCleared(true);
      toast({ tone: "ok", title: "Crash protection saved" });
      void info.reload();
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const exit = data?.lastExit;
  return (
    <>
      <Card title="Crash protection" description="What happens when the server stops unexpectedly.">
        <State loading={info.loading} error={info.error} rows={3}>
          {data ? (
            <form className="form" onSubmit={save} noValidate>
              {data.loop && !loopCleared ? (
                <Notice tone="bad" title="Restarts paused">
                  Automatic restarts stopped after repeated crashes. Start the server to try again.
                </Notice>
              ) : null}
              <Segmented
                label="Crash protection"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "off", label: "Off" },
                  { value: "on-failure", label: "Restart after crashes" },
                  { value: "always", label: "Always restart" },
                ]}
              />
              <p className="small muted">{modeCopy[mode]}</p>
              {mode !== "off" && (
                <>
                  <div className="form-grid">
                    <label className="field">
                      <span className="field__label">Restarts allowed</span>
                      <input className="input" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
                      <span className="field__hint">Stops trying after this many.</span>
                    </label>
                    <label className="field">
                      <span className="field__label">Within</span>
                      <div className="input-unit">
                        <input className="input" inputMode="numeric" value={window_} onChange={(e) => setWindow(e.target.value)} />
                        <span aria-hidden="true">minutes</span>
                      </div>
                    </label>
                  </div>
                  <label className="field">
                    <span className="field__label">Pauses between restarts (seconds)</span>
                    <input className="input mono" value={pauses} onChange={(e) => setPauses(e.target.value)} />
                    <span className="field__hint">Each restart waits the next number; the last one repeats. For example 5, 15, 60.</span>
                  </label>
                </>
              )}
              {data.restartsInWindow > 0 && mode !== "off" ? (
                <p className="small faint">
                  {data.restartsInWindow} automatic {data.restartsInWindow === 1 ? "restart" : "restarts"} in the current window.
                </p>
              ) : null}
              <ErrorNotice message={error} />
              <div className="form__actions">
                <Button type="submit" variant="primary" busy={busy}>
                  Save
                </Button>
              </div>
            </form>
          ) : null}
          {exit ? (
            <div className="crash-exit">
              <strong className="small">Last exit</strong>
              <p className="small muted">
                {exit.oomKilled ? "Out of memory" : exit.code === 0 ? "Stopped cleanly" : `Exit code ${exit.code ?? "unknown"}`}
                {exit.code !== undefined && exit.code !== null && (exit.oomKilled || exit.code === 0) ? ` (code ${exit.code})` : ""}
                {exit.finishedAt ? (
                  <>
                    {" "}
                    ·{" "}
                    <time dateTime={exit.finishedAt} title={fmtTime(exit.finishedAt)}>
                      {fmtAgo(exit.finishedAt)}
                    </time>
                  </>
                ) : null}
              </p>
              {exit.logTail ? (
                <details className="addon-details">
                  <summary>Last log lines</summary>
                  <pre className="code-block">{exit.logTail}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </State>
      </Card>
      <Card title="Recent events" description="Crashes and automatic restarts." flush>
        <State loading={events.loading} error={events.error} rows={3}>
          {Array.isArray(events.data) && events.data.length ? (
            <ul className="event-list">
              {events.data.map((ev) => {
                const Icon = { crash: CircleAlert, crashloop: TriangleAlert, restart: RotateCw, recovered: CircleCheck }[ev.kind as "crash"] || CircleAlert;
                const tone = ev.kind === "recovered" ? "ok" : ev.kind === "restart" ? "busy" : "bad";
                return (
                  <li key={ev.id} className={`event event--${tone}`}>
                    <Icon aria-hidden="true" />
                    <span>{ev.message}</span>
                    <time className="small faint" dateTime={ev.at} title={fmtTime(ev.at)}>
                      {fmtAgo(ev.at)}
                    </time>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty title="Nothing to report">Crashes and automatic restarts will be listed here.</Empty>
          )}
        </State>
      </Card>
    </>
  );
}

