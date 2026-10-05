"use client";
import { json } from "@/lib/api";
import { fmtDay } from "@/lib/format";
import { cpuText, memText, type LimitsView, type SelfOptions } from "@/lib/commerce";
import { Check, ChevronRight, Cpu, HardDrive, Lock, MapPin, MemoryStick, Plus, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Drawer } from "./feedback";
import { LimitUsage } from "./LimitsUI";
import { Button, Card, ErrorNotice, Notice, State, btn, useLoad } from "./shared";
import { useToast } from "./toast";

type Opt = SelfOptions["templates"][number];
const STEPS = ["Choose", "Set up", "Review"] as const;
const initials = (name: string) =>
  name
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "S";
/** A steady tint per kind of server, mixed into the theme's own colours so every theme stays readable. */
const hueOf = (id: string) => [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);

function Spec({ t, mem, cpu, disk }: { t: Opt; mem?: number; cpu?: number; disk?: number }) {
  return (
    <span className="mk-spec">
      <span>
        <MemoryStick aria-hidden="true" /> {memText(mem ?? t.memoryMb)}
      </span>
      <span>
        <Cpu aria-hidden="true" /> {cpuText(cpu ?? t.cpuPercent)}
      </span>
      <span>
        <HardDrive aria-hidden="true" /> {memText(disk ?? t.diskMb)}
      </span>
    </span>
  );
}

function Slide({ label, value, min, max, step, onChange, text, hint }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void; text: string; hint?: string }) {
  const hi = Math.max(min, max);
  const v = Math.min(Math.max(value, min), hi);
  return (
    <div className="mk-slide">
      <div className="mk-slide__top">
        <span className="field__label">{label}</span>
        <strong>{text}</strong>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={hi}
        step={step}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--fill" as string]: `${hi === min ? 100 : ((v - min) / (hi - min)) * 100}%` }}
      />
      {hint ? <small className="mk-slide__hint">{hint}</small> : null}
    </div>
  );
}

/** Why the customer cannot create a server right now, in plain words. */
function CannotCreate({ data }: { data: SelfOptions }) {
  const text: Record<string, string> = {
    off: "Your host sets servers up for you. Get in touch if you need one.",
    "store-only": "Servers on this panel come from the store. Pick one that fits and it is set up for you.",
    "plan-required": "Creating servers needs an active account plan that includes it.",
    denied: "Your plan or your host's settings do not let you create servers yourself.",
    inactive: "This account cannot create servers right now.",
    unverified: "Confirm your email address first. The link is in the message we sent you.",
  };
  const storeLink = data.why === "store-only" || data.why === "plan-required" || data.why === "denied";
  return (
    <div className="mk-empty">
      <span className="mk-empty__icon">
        <Lock aria-hidden="true" />
      </span>
      <strong>You cannot create a server yet</strong>
      <p>{text[data.why ?? "denied"] ?? text.denied}</p>
      {storeLink ? (
        <Link className={btn("primary", "sm")} href="/store">
          Look at the store
        </Link>
      ) : null}
    </div>
  );
}

/** A customer creating a server for themselves, within their limits: choose, set up, review. */
export function CreateMyServer({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading } = useLoad<SelfOptions>(open ? "/me/servers/options" : null);
  const [picked, setPicked] = useState("");
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [mem, setMem] = useState<number | null>(null),
    [cpu, setCpu] = useState<number | null>(null),
    [disk, setDisk] = useState<number | null>(null);
  const [location, setLocation] = useState("");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  const kinds = data?.templates ?? [];
  const single = kinds.length === 1;
  const [sshKeys,setSSHKeys]=useState('');
  const t = kinds.find((x) => x.id === picked) ?? (single ? kinds[0] : undefined);
  const first = single ? 1 : 0;
  const at = t ? Math.max(step, first) : 0;
  const custom = !!data?.customResources;
  const needName = data?.allowRename !== false;
  const rowOf = (k: string) => data?.limits?.rows.find((r) => r.key === k);
  /** The most one new server may take: the per-server cap, what is left of the total, and the hard ceiling. */
  const room = (perServer: string, total: string, ceil: number) => {
    const per = rowOf(perServer)?.limit ?? null;
    const tot = rowOf(total);
    const left = tot && tot.limit !== null && tot.used !== null ? Math.max(0, tot.limit - tot.used) : null;
    return Math.min(ceil, per ?? ceil, left ?? ceil);
  };
  const memMax = room("maxServerMemoryMb", "memoryMb", data?.ceilings?.memoryMb ?? 262144);
  const cpuMax = room("maxServerCpuPercent", "cpuPercent", data?.ceilings?.cpuPercent ?? 6400);
  const diskMax = room("maxServerDiskMb", "diskMb", data?.ceilings?.diskMb ?? 4194304);
  const size = t ? { mem: mem ?? t.memoryMb, cpu: cpu ?? t.cpuPercent, disk: disk ?? t.diskMb } : { mem: 0, cpu: 0, disk: 0 };
  // Sliders stay usable: with no limit they stop at a sensible size, and never below the template's own size.
  const cap = (limit: number, soft: number, own: number) => Math.max(own, Math.min(limit, soft));
  const allowance = data?.limits && !data.limits.hidden && data.limits.enabled ? data.limits.rows.filter((r) => !r.unlimited && ["servers", "memoryMb", "diskMb", "cpuPercent"].includes(r.key)) : [];
  const nameOk = !needName || name.trim().length > 0;
  const reset = () => {
    setPicked("");
    setStep(0);
    setName("");
    setMem(null);
    setCpu(null);
    setDisk(null);
    setLocation("");
    setVars({});
    setErr("");
    setBusy(false);
  };
  const choose = (x: Opt) => {
    setPicked(x.id);
    setVars({});
    setMem(null);
    setCpu(null);
    setDisk(null);
    setErr("");
    setStep(1);
  };
  async function create() {
    if (!t) return;
    setBusy(true);
    setErr("");
    try {
      const changed = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== ""));
      const r = (await json("POST", "/me/servers", {
        templateId: t.id,
        vm:t.runtime==='vm'?{sshKeys:sshKeys.split('\n').map(k=>k.trim()).filter(Boolean)}:undefined,
        name: needName ? name.trim() : undefined,
        ...(custom ? { memoryMb: size.mem, cpuPercent: size.cpu, diskMb: size.disk } : {}),
        location: location || undefined,
        variables: Object.keys(changed).length ? changed : undefined,
      })) as { id: string };
      toast({ tone: "ok", title: "Your server is on its way", description: needName ? name.trim() : t.name });
      onCreated();
      onOpenChange(false);
      reset();
      router.push(`/servers/${r.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  const ready = !!data && data.canCreate && kinds.length > 0;
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      wide
      title="Create your server"
      description="Choose what you want to run, make it yours, and it is ready in a minute or two."
    >
      <State loading={loading} error={error}>
        {data && !data.canCreate ? <CannotCreate data={data} /> : null}
        {data && data.canCreate && kinds.length === 0 ? (
          <div className="mk-empty">
            <span className="mk-empty__icon">
              <Sparkles aria-hidden="true" />
            </span>
            <strong>Nothing to choose from yet</strong>
            <p>Your host has not released a kind of server to create. Check back soon or ask them.</p>
          </div>
        ) : null}
        {ready ? (
          <form
            className="mk"
            onSubmit={(e) => {
              e.preventDefault();
              if (at === 2) void create();
            }}
          >
            <ol className="mk-steps" aria-label="Progress">
              {STEPS.map((label, i) => (
                <li key={label} className={i === at ? "is-now" : i < at ? "is-done" : ""} aria-current={i === at ? "step" : undefined}>
                  <span>{i < at ? <Check aria-hidden="true" /> : i + 1}</span>
                  {label}
                </li>
              ))}
            </ol>

            {at === 0 ? (
              <section className="mk-pane" aria-label="Choose a kind of server">
                <div className="mk-kinds" role="radiogroup" aria-label="Kind of server">
                  {kinds.map((x) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={picked === x.id}
                      key={x.id}
                      className={`mk-kind${picked === x.id ? " is-picked" : ""}`}
                      style={{ ["--hue" as string]: hueOf(x.id) }}
                      onClick={() => choose(x)}
                    >
                      <span className="mk-kind__mark" aria-hidden="true">
                        {initials(x.name)}
                      </span>
                      <span className="mk-kind__text">
                        <strong>{x.name}</strong>
                        {x.description ? <small>{x.description}</small> : null}
                      </span>
                      <Spec t={x} />
                      <ChevronRight className="mk-kind__go" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {at === 1 && t ? (
              <section className="mk-pane" aria-label="Set up your server">
                <div className="mk-chosen" style={{ ["--hue" as string]: hueOf(t.id) }}>
                  <span className="mk-kind__mark" aria-hidden="true">
                    {initials(t.name)}
                  </span>
                  <span className="mk-kind__text">
                    <strong>{t.name}</strong>
                    {t.description ? <small>{t.description}</small> : null}
                  </span>
                  {!single ? (
                    <button type="button" className="text-button" onClick={() => setStep(0)}>
                      Change
                    </button>
                  ) : null}
                </div>
                {needName ? (
                  <label className="field">
                    <span className="field__label">Name your server</span>
                    <input className="input mk-name" autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Our survival world" />
                    <span className="field__hint">Only you and the people you share it with see this.</span>
                  </label>
                ) : null}
                {custom ? (
                  <div className="mk-sizes">
                    <Slide label="Memory" value={size.mem} min={256} max={cap(memMax, 16384, t.memoryMb)} step={256} onChange={setMem} text={memText(size.mem)} hint={memMax < 16384 ? `Up to ${memText(memMax)} with your allowance` : undefined} />
                    <Slide label="CPU" value={size.cpu} min={25} max={cap(cpuMax, 800, t.cpuPercent)} step={25} onChange={setCpu} text={cpuText(size.cpu)} hint={cpuMax < 800 ? `Up to ${cpuText(cpuMax)} with your allowance` : undefined} />
                    <Slide label="Disk" value={size.disk} min={512} max={cap(diskMax, 102400, t.diskMb)} step={512} onChange={setDisk} text={memText(size.disk)} hint={diskMax < 102400 ? `Up to ${memText(diskMax)} with your allowance` : undefined} />
                  </div>
                ) : (
                  <div className="mk-fixed">
                    <span>Included size</span>
                    <Spec t={t} />
                  </div>
                )}
                {data.locations.length > 1 ? (
                  <div className="field">
                    <span className="field__label">Where should it run?</span>
                    <div className="mk-places" role="radiogroup" aria-label="Location">
                      {["", ...data.locations].map((l) => (
                        <button type="button" role="radio" aria-checked={location === l} key={l || "auto"} className={`mk-place${location === l ? " is-picked" : ""}`} onClick={() => setLocation(l)}>
                          <MapPin aria-hidden="true" />
                          {l || "Best available"}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {t.runtime==='vm'&&<label className="field"><span>SSH provisioning keys</span><textarea className="input mono" value={sshKeys} onChange={e=>setSSHKeys(e.target.value)} rows={4} placeholder="ssh-ed25519 ..."/><small>Required for Linux cloud images. ISO installation uses the console.</small></label>}
                {t.variables.length ? (
                  <fieldset className="mk-options">
                    <legend>Options</legend>
                    {t.variables.map((v) => (
                      <label className="field" key={v.key}>
                        <span className="field__label">{v.label}</span>
                        {v.type === "select" && v.options ? (
                          <select className="input select" value={vars[v.key] ?? ""} onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })}>
                            <option value="">Default</option>
                            {v.options.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input className="input" type={v.type === "number" ? "number" : "text"} value={vars[v.key] ?? ""} placeholder="Default" onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })} />
                        )}
                        {v.description ? <span className="field__hint">{v.description}</span> : null}
                      </label>
                    ))}
                  </fieldset>
                ) : null}
              </section>
            ) : null}

            {at === 2 && t ? (
              <section className="mk-pane" aria-label="Review">
                <div className="mk-review" style={{ ["--hue" as string]: hueOf(t.id) }}>
                  <span className="mk-kind__mark mk-kind__mark--big" aria-hidden="true">
                    {initials(t.name)}
                  </span>
                  <div>
                    <small>{t.name}</small>
                    <h3>{needName ? name.trim() : t.name}</h3>
                  </div>
                  <Spec t={t} mem={size.mem} cpu={size.cpu} disk={size.disk} />
                  <dl>
                    <div>
                      <dt>Location</dt>
                      <dd>{location || "Best available"}</dd>
                    </div>
                    {Object.entries(vars)
                      .filter(([, v]) => v !== "")
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt>{t.variables.find((d) => d.key === k)?.label ?? k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                  </dl>
                </div>
                {allowance.length ? (
                  <Card title="Your allowance" description="Creating this server uses part of it.">
                    <LimitUsage view={{ ...data.limits!, rows: allowance }} />
                  </Card>
                ) : null}
                <ul className="mk-next">
                  <li>
                    <Check aria-hidden="true" /> It is placed on a node with room and starts by itself.
                  </li>
                  <li>
                    <Check aria-hidden="true" /> You land on its page, where the console shows the first start.
                  </li>
                </ul>
              </section>
            ) : null}

            <ErrorNotice message={err} />
            <div className="mk-foot">
              {at > first ? (
                <Button
                  onClick={() => {
                    setErr("");
                    setStep(at - 1);
                  }}
                >
                  Back
                </Button>
              ) : (
                <Button onClick={() => onOpenChange(false)}>Cancel</Button>
              )}
              {at === 1 ? (
                <Button variant="primary" disabled={!t || !nameOk} onClick={() => setStep(2)}>
                  Review
                </Button>
              ) : null}
              {at === 2 ? (
                <Button type="submit" variant="primary" busy={busy}>
                  Create server
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </State>
    </Drawer>
  );
}

/** The first thing a new customer sees when they can create a server and have none yet. */
export function FirstServer({ onStart, store }: { onStart: () => void; store: boolean }) {
  return (
    <div className="mk-hero">
      <div className="mk-hero__glow" aria-hidden="true" />
      <span className="mk-hero__badge">
        <Sparkles aria-hidden="true" /> Welcome
      </span>
      <h2>Let’s start your first server</h2>
      <p>It takes about a minute. You choose what to run, give it a name, and it is set up for you.</p>
      <ol className="mk-hero__steps">
        <li>
          <span>1</span>
          <strong>Choose</strong>
          <small>Pick the kind of server</small>
        </li>
        <li>
          <span>2</span>
          <strong>Make it yours</strong>
          <small>Name, size and place</small>
        </li>
        <li>
          <span>3</span>
          <strong>Play</strong>
          <small>It starts on its own</small>
        </li>
      </ol>
      <div className="btn-group">
        <Button variant="primary" onClick={onStart}>
          <Plus /> Create my server
        </Button>
        {store ? (
          <Link className={btn("secondary")} href="/store">
            Browse the store
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** A short summary of what the customer uses, above their servers. */
export function UsageStrip() {
  const { data } = useLoad<LimitsView>("/limits/me", 60000);
  if (!data || data.hidden || !data.enabled) return null;
  const limited = data.rows.filter((r) => !r.unlimited && ["servers", "memoryMb", "diskMb", "cpuPercent"].includes(r.key));
  if (!limited.length) return null;
  return (
    <Card className="usage-strip" title="Your usage" actions={<Link href="/settings" className="text-button">Details</Link>}>
      <LimitUsage view={{ ...data, rows: limited }} />
    </Card>
  );
}

/** Shown on a server whose owner asked to delete it: lets them change their mind. */
export function PendingDelete({ server, onChange }: { server: { id: string; name: string; pendingDeleteAt: string | null }; onChange: () => void }) {
  const toast = useToast();
  if (!server.pendingDeleteAt) return null;
  return (
    <Notice
      tone="warn"
      title={`${server.name} will be deleted on ${fmtDay(server.pendingDeleteAt)}`}
      action={
        <Button
          size="sm"
          onClick={async () => {
            try {
              await json("POST", `/me/servers/${server.id}/restore`);
              toast({ tone: "ok", title: "Deletion cancelled", description: "The server is starting again." });
              onChange();
            } catch (e) {
              toast({ tone: "bad", title: "Could not restore", description: (e as Error).message });
            }
          }}
        >
          Keep it
        </Button>
      }
    >
      The server is stopped. Until then you can still restore it.
    </Notice>
  );
}
void btn;
