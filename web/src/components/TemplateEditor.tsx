"use client";
import { json, type TemplateFull, type VariableDef } from "@/lib/api";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Drawer } from "./feedback";
import { Button, ErrorNotice, Notice, Switch } from "./shared";

/* ---------- Draft (what the form edits) ---------- */

type VarRow = {
  key: string;
  label: string;
  description: string;
  type: VariableDef["type"];
  options: { value: string; label: string }[];
  min: string;
  max: string;
  pattern: string;
  secret: boolean;
  userEditable: boolean;
  required: boolean;
};
export type Draft = {
  id: string;
  name: string;
  description: string;
  image: string;
  startup: string;
  stopCommand: string;
  ports: { container: string; offset: string; protocol: "tcp" | "udp" }[];
  env: { key: string; value: string }[];
  memoryMb: string;
  cpuPercent: string;
  diskMb: string;
  variables: VarRow[];
  quick: { label: string; command: string }[];
  addonsOn: boolean;
  addonsJson: string;
};
/** Anything a draft can start from: a saved template, a duplicate, an egg conversion. */
export type Seed = Partial<TemplateFull>;

const KEY = /^[A-Z_][A-Z0-9_]*$/;
const emptyVar = (): VarRow => ({ key: "", label: "", description: "", type: "string", options: [], min: "", max: "", pattern: "", secret: false, userEditable: true, required: false });

export function toDraft(t: Seed): Draft {
  const defs: VariableDef[] = t.variables?.length
    ? t.variables
    : (t.editableVariables || []).map((key) => ({ key, label: key, type: "string" as const, userEditable: true }));
  return {
    id: t.id || "",
    name: t.name || "",
    description: t.description || "",
    image: t.image || "",
    startup: t.startup || "",
    stopCommand: t.stopCommand || "",
    ports: (t.internalPorts?.length ? t.internalPorts : [{ container: 25565, offset: 0, protocol: "tcp" as const }]).map((p) => ({ container: String(p.container), offset: String(p.offset), protocol: p.protocol })),
    env: Object.entries(t.env || {}).map(([key, value]) => ({ key, value })),
    memoryMb: String(t.memoryMb ?? 2048),
    cpuPercent: String(t.cpuPercent ?? 100),
    diskMb: String(t.diskMb ?? 10240),
    variables: defs.map((d) => ({
      key: d.key,
      label: d.label === d.key ? "" : d.label || "",
      description: d.description || "",
      type: d.type,
      options: (d.options || []).map((o) => ({ ...o })),
      min: d.min === undefined ? "" : String(d.min),
      max: d.max === undefined ? "" : String(d.max),
      pattern: d.pattern || "",
      secret: !!d.secret,
      userEditable: d.userEditable,
      required: !!d.required,
    })),
    quick: (t.quickCommands || []).map((q) => ({ ...q })),
    addonsOn: !!t.addons,
    addonsJson: t.addons ? JSON.stringify(t.addons, null, 2) : "",
  };
}

const whole = (v: string) => /^\d+$/.test(v.trim());

function addonsProblem(d: Draft): string {
  if (!d.addonsOn) return "";
  if (!d.addonsJson.trim()) return "Add-on rules are empty. Use the preset or paste the rules as JSON.";
  try {
    const v = JSON.parse(d.addonsJson);
    if (!v || typeof v !== "object" || Array.isArray(v) || !v.types || typeof v.types !== "object" || Array.isArray(v.types)) return "Expected an object with a “types” object.";
    for (const [type, rule] of Object.entries<any>(v.types)) {
      if (!/^[A-Z0-9_]{1,40}$/.test(type)) return `“${type.slice(0, 40)}” isn’t a valid type name (CAPITAL_LETTERS).`;
      if (!rule || !/^[a-z][a-z0-9-]{0,30}$/.test(String(rule.kind))) return `${type}: “kind” should be a short lowercase word such as mod or plugin.`;
      if (!/^\/[A-Za-z0-9_./-]{1,100}$/.test(String(rule.dir)) || String(rule.dir).includes("..")) return `${type}: “dir” should be a folder like /mods.`;
      if (!Array.isArray(rule.loaders) || rule.loaders.length > 12 || rule.loaders.some((l: unknown) => !/^[a-z0-9-]{1,30}$/.test(String(l)))) return `${type}: “loaders” should be a list of lowercase names.`;
    }
    for (const f of ["versionVar", "typeVar"]) if (v[f] !== undefined && !KEY.test(String(v[f]))) return `“${f}” should be a variable name like VERSION.`;
    return "";
  } catch (e) {
    return (e as Error).message.replace(/^JSON\.parse: /, "");
  }
}

/** Everything wrong with a draft, in the order the form shows it. */
export function problems(d: Draft, isNew: boolean): string[] {
  const out: string[] = [];
  if (isNew && !/^[a-z0-9][a-z0-9-]*$/.test(d.id)) out.push("The ID needs lowercase letters, numbers and hyphens, starting with a letter or number.");
  if (!d.name.trim()) out.push("Give the template a name.");
  if (!d.image.trim() || !/^[\w./:@-]+$/.test(d.image.trim()) || d.image.includes("..")) out.push("Enter a valid Docker image, such as itzg/minecraft-server:java21.");
  if (!d.ports.length) out.push("Add at least one port.");
  d.ports.forEach((p, i) => {
    if (!whole(p.container) || +p.container < 1 || +p.container > 65535) out.push(`Port ${i + 1}: the container port must be 1–65535.`);
    if (!whole(p.offset) || +p.offset > 100) out.push(`Port ${i + 1}: the offset must be 0–100.`);
  });
  const seen = new Set<string>();
  for (const e of d.env) {
    if (!KEY.test(e.key)) out.push(`Environment: “${e.key.slice(0, 30) || "(empty)"}” isn’t a valid name (CAPITAL_LETTERS_AND_DIGITS).`);
    else if (seen.has(e.key)) out.push(`Environment: ${e.key} appears twice.`);
    seen.add(e.key);
  }
  for (const [label, v] of [["Memory", d.memoryMb], ["CPU", d.cpuPercent], ["Disk", d.diskMb]] as const) if (!whole(v) || +v < 1) out.push(`${label} must be a whole number above zero.`);
  const keys = new Set<string>();
  d.variables.forEach((v) => {
    const name = v.key || "(empty)";
    if (!KEY.test(v.key)) out.push(`Variable ${name}: use CAPITAL_LETTERS_AND_DIGITS for the name.`);
    else if (keys.has(v.key)) out.push(`Variable ${v.key} is defined twice.`);
    keys.add(v.key);
    if (v.type === "select" && (!v.options.length || v.options.some((o) => !o.value))) out.push(`Variable ${name}: add at least one option, each with a value.`);
    for (const f of ["min", "max"] as const) if (v[f] !== "" && !Number.isFinite(Number(v[f]))) out.push(`Variable ${name}: ${f} must be a number.`);
    if (v.pattern) {
      try {
        new RegExp(v.pattern);
      } catch {
        out.push(`Variable ${name}: the pattern isn’t a valid regular expression.`);
      }
    }
  });
  d.quick.forEach((q, i) => {
    if (!q.label.trim() || !q.command.trim()) out.push(`Quick command ${i + 1} needs both a label and a command.`);
  });
  const a = addonsProblem(d);
  if (a) out.push(`Add-on support: ${a}`);
  return out;
}

export function toBody(d: Draft, isNew: boolean) {
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  return {
    ...(isNew ? { id: d.id } : {}),
    name: d.name.trim(),
    description: d.description.trim(),
    image: d.image.trim(),
    startup: d.startup.trim() || null,
    stopCommand: d.stopCommand.trim() || null,
    internalPorts: d.ports.map((p) => ({ container: Number(p.container), offset: Number(p.offset), protocol: p.protocol })),
    env: Object.fromEntries(d.env.map((e) => [e.key, e.value])),
    memoryMb: Number(d.memoryMb),
    cpuPercent: Number(d.cpuPercent),
    diskMb: Number(d.diskMb),
    // Every variable lives in `variables` now, so the legacy list is emptied.
    editableVariables: [] as string[],
    variables: d.variables.map((v) => ({
      key: v.key,
      label: v.label.trim() || v.key,
      ...(v.description.trim() ? { description: v.description.trim() } : {}),
      type: v.type,
      ...(v.type === "select" ? { options: v.options.map((o) => ({ value: o.value, label: o.label.trim() || o.value })) } : {}),
      ...(v.type === "number" || v.type === "string" ? { ...(num(v.min) !== undefined ? { min: num(v.min) } : {}), ...(num(v.max) !== undefined ? { max: num(v.max) } : {}) } : {}),
      ...(v.type === "string" && v.pattern ? { pattern: v.pattern } : {}),
      ...(v.secret ? { secret: true } : {}),
      ...(v.required ? { required: true } : {}),
      userEditable: v.userEditable,
    })),
    quickCommands: d.quick.map((q) => ({ label: q.label.trim(), command: q.command.trim() })),
    addons: d.addonsOn && d.addonsJson.trim() ? JSON.parse(d.addonsJson) : null,
  };
}

/** What Fledge seeds for the Minecraft Java templates; used if the live one can't be found. */
export const fallbackAddons = {
  versionVar: "VERSION",
  typeVar: "TYPE",
  types: {
    PAPER: { kind: "plugin", dir: "/plugins", loaders: ["paper", "spigot", "bukkit"] },
    PURPUR: { kind: "plugin", dir: "/plugins", loaders: ["purpur", "paper", "spigot", "bukkit"] },
    FOLIA: { kind: "plugin", dir: "/plugins", loaders: ["folia"] },
    SPIGOT: { kind: "plugin", dir: "/plugins", loaders: ["spigot", "bukkit"] },
    BUKKIT: { kind: "plugin", dir: "/plugins", loaders: ["bukkit"] },
    PUFFERFISH: { kind: "plugin", dir: "/plugins", loaders: ["paper", "spigot", "bukkit"] },
    FABRIC: { kind: "mod", dir: "/mods", loaders: ["fabric"] },
    QUILT: { kind: "mod", dir: "/mods", loaders: ["quilt", "fabric"] },
    FORGE: { kind: "mod", dir: "/mods", loaders: ["forge"] },
    NEOFORGE: { kind: "mod", dir: "/mods", loaders: ["neoforge"] },
  },
};

/* ---------- Editor ---------- */

export default function TemplateEditor({
  open,
  existing,
  seed,
  warnings,
  addonPreset,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The template being edited, or null when creating one. */
  existing: TemplateFull | null;
  seed: Seed;
  warnings: string[];
  addonPreset: object;
  onClose: () => void;
  onSaved: (saved: TemplateFull, previousVersion: number | null) => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? `Edit ${existing.name}` : "New template"}
      description={existing ? `Version ${existing.version}${existing.official ? " · included with Fledge" : ""}` : "Set up what a new game server is made of."}
      wide
    >
      {open ? <EditorForm key={existing?.id || seed.id || "new"} existing={existing} seed={seed} warnings={warnings} addonPreset={addonPreset} onClose={onClose} onSaved={onSaved} /> : null}
    </Drawer>
  );
}

function EditorForm({ existing, seed, warnings, addonPreset, onClose, onSaved }: Omit<Parameters<typeof TemplateEditor>[0], "open">) {
  const isNew = !existing;
  const [d, setD] = useState(() => toDraft(existing || seed));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const issues = useMemo(() => problems(d, isNew), [d, isNew]);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const update = <K extends "ports" | "env" | "variables" | "quick">(k: K, i: number, patch: Partial<Draft[K][number]>) =>
    setD((x) => ({ ...x, [k]: (x[k] as any[]).map((row, j) => (j === i ? { ...row, ...patch } : row)) }));
  const remove = (k: "ports" | "env" | "variables" | "quick", i: number) => setD((x) => ({ ...x, [k]: (x[k] as any[]).filter((_, j) => j !== i) }));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (issues.length) return;
    setBusy(true);
    setError("");
    try {
      const body = toBody(d, isNew);
      const saved = (await json(isNew ? "POST" : "PUT", isNew ? "/templates" : `/templates/${existing!.id}`, body)) as TemplateFull;
      onSaved(saved, existing?.version ?? null);
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const addonError = addonsProblem(d);
  return (
    <form className="form tpl-form" onSubmit={save} noValidate>
      {warnings.length > 0 && (
        <Notice tone="warn" title="Check these before saving">
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <section className="form-section" aria-labelledby="t-basics">
        <h3 id="t-basics">Basics</h3>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Name</span>
            <input className="input" value={d.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">ID</span>
            <input className="input mono" value={d.id} disabled={!isNew} placeholder="my-game" onChange={(e) => set({ id: e.target.value.toLowerCase() })} />
            <span className="field__hint">{isNew ? "Lowercase letters, numbers and hyphens. Can’t be changed later." : "IDs can’t be changed."}</span>
          </label>
        </div>
        <label className="field">
          <span className="field__label">Description <span className="faint">(optional)</span></span>
          <input className="input" value={d.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} />
        </label>
      </section>

      <section className="form-section" aria-labelledby="t-start">
        <h3 id="t-start">Image and commands</h3>
        <label className="field">
          <span className="field__label">Docker image</span>
          <input className="input mono" value={d.image} spellCheck={false} onChange={(e) => set({ image: e.target.value })} />
          <span className="field__hint">Must be on your panel’s image allowlist.</span>
        </label>
        <label className="field">
          <span className="field__label">Startup command <span className="faint">(optional)</span></span>
          <textarea className="input" rows={3} spellCheck={false} value={d.startup} onChange={(e) => set({ startup: e.target.value })} placeholder="Leave empty to use the image’s own command" />
        </label>
        <label className="field">
          <span className="field__label">Stop command <span className="faint">(optional)</span></span>
          <input className="input mono" value={d.stopCommand} maxLength={256} spellCheck={false} onChange={(e) => set({ stopCommand: e.target.value })} placeholder="stop" />
          <span className="field__hint">Sent to the console when the server is stopped. Use ^C for Ctrl+C.</span>
        </label>
      </section>

      <section className="form-section" aria-labelledby="t-ports">
        <h3 id="t-ports">Ports</h3>
        <div className="tpl-rows">
          {d.ports.map((p, i) => (
            <div className="tpl-row tpl-row--ports" key={i}>
              <label className="field">
                <span className="field__label">Container port</span>
                <input className="input" inputMode="numeric" value={p.container} onChange={(e) => update("ports", i, { container: e.target.value })} />
              </label>
              <label className="field">
                <span className="field__label">Offset</span>
                <input className="input" inputMode="numeric" value={p.offset} onChange={(e) => update("ports", i, { offset: e.target.value })} />
              </label>
              <label className="field">
                <span className="field__label">Protocol</span>
                <select className="input select" value={p.protocol} onChange={(e) => update("ports", i, { protocol: e.target.value as "tcp" | "udp" })}>
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </select>
              </label>
              <RemoveButton label={`Remove port ${i + 1}`} disabled={d.ports.length <= 1} onClick={() => remove("ports", i)} />
            </div>
          ))}
        </div>
        <div className="form__actions">
          <Button size="sm" disabled={d.ports.length >= 10} onClick={() => set({ ports: [...d.ports, { container: "", offset: String(d.ports.length), protocol: "tcp" }] })}>
            <Plus /> Add port
          </Button>
          <span className="small faint">Offset 0 is the server’s main port; 1 is the next one up, and so on.</span>
        </div>
      </section>

      <section className="form-section" aria-labelledby="t-env">
        <h3 id="t-env">Environment</h3>
        <div className="tpl-rows">
          {d.env.map((e, i) => (
            <div className="tpl-row tpl-row--env" key={i}>
              <input className="input mono" aria-label={`Name ${i + 1}`} placeholder="NAME" value={e.key} spellCheck={false} onChange={(ev) => update("env", i, { key: ev.target.value.toUpperCase() })} />
              <input className="input mono" aria-label={`Value ${i + 1}`} placeholder="value" value={e.value} spellCheck={false} onChange={(ev) => update("env", i, { value: ev.target.value })} />
              <RemoveButton label={`Remove ${e.key || `variable ${i + 1}`}`} onClick={() => remove("env", i)} />
            </div>
          ))}
        </div>
        <div className="form__actions">
          <Button size="sm" onClick={() => set({ env: [...d.env, { key: "", value: "" }] })}>
            <Plus /> Add variable
          </Button>
        </div>
      </section>

      <section className="form-section" aria-labelledby="t-res">
        <h3 id="t-res">Default resources</h3>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Memory (MB)</span>
            <input className="input" inputMode="numeric" value={d.memoryMb} onChange={(e) => set({ memoryMb: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">CPU (100 = one core)</span>
            <input className="input" inputMode="numeric" value={d.cpuPercent} onChange={(e) => set({ cpuPercent: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Disk (MB)</span>
            <input className="input" inputMode="numeric" value={d.diskMb} onChange={(e) => set({ diskMb: e.target.value })} />
          </label>
        </div>
      </section>

      <section className="form-section" aria-labelledby="t-vars">
        <h3 id="t-vars">Variables</h3>
        <p className="small faint">Describe the environment variables you want to type or limit. Turn on “Owners can edit” to let server owners change one; its default comes from Environment above.</p>
        <div className="tpl-vars">
          {d.variables.map((v, i) => (
            <fieldset className="tpl-var" key={i}>
              <legend className="sr-only">Variable {v.key || i + 1}</legend>
              <div className="tpl-var__top">
                <label className="field">
                  <span className="field__label">Name</span>
                  <input className="input mono" value={v.key} placeholder="MAX_PLAYERS" spellCheck={false} onChange={(e) => update("variables", i, { key: e.target.value.toUpperCase() })} />
                </label>
                <label className="field">
                  <span className="field__label">Label</span>
                  <input className="input" value={v.label} maxLength={80} placeholder="Maximum players" onChange={(e) => update("variables", i, { label: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field__label">Type</span>
                  <select className="input select" value={v.type} onChange={(e) => update("variables", i, { type: e.target.value as VariableDef["type"], ...(e.target.value === "select" && !v.options.length ? { options: [{ value: "", label: "" }] } : {}) })}>
                    <option value="string">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">On / off</option>
                    <option value="select">Choice</option>
                  </select>
                </label>
                <RemoveButton label={`Remove variable ${v.key || i + 1}`} onClick={() => remove("variables", i)} />
              </div>
              <label className="field">
                <span className="field__label">Description <span className="faint">(optional)</span></span>
                <input className="input" value={v.description} maxLength={300} onChange={(e) => update("variables", i, { description: e.target.value })} />
              </label>
              {v.type === "select" && (
                <div className="field">
                  <span className="field__label">Options</span>
                  <div className="tpl-rows">
                    {v.options.map((o, j) => (
                      <div className="tpl-row tpl-row--env" key={j}>
                        <input className="input mono" aria-label={`Option ${j + 1} value`} placeholder="value" value={o.value} onChange={(e) => update("variables", i, { options: v.options.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)) })} />
                        <input className="input" aria-label={`Option ${j + 1} label`} placeholder="Label" value={o.label} onChange={(e) => update("variables", i, { options: v.options.map((x, k) => (k === j ? { ...x, label: e.target.value } : x)) })} />
                        <RemoveButton label={`Remove option ${j + 1}`} disabled={v.options.length <= 1} onClick={() => update("variables", i, { options: v.options.filter((_, k) => k !== j) })} />
                      </div>
                    ))}
                  </div>
                  <div>
                    <Button size="sm" disabled={v.options.length >= 60} onClick={() => update("variables", i, { options: [...v.options, { value: "", label: "" }] })}>
                      <Plus /> Add option
                    </Button>
                  </div>
                </div>
              )}
              {(v.type === "number" || v.type === "string") && (
                <div className="form-grid">
                  <label className="field">
                    <span className="field__label">{v.type === "number" ? "Minimum" : "Minimum length"}</span>
                    <input className="input" inputMode="decimal" value={v.min} onChange={(e) => update("variables", i, { min: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="field__label">{v.type === "number" ? "Maximum" : "Maximum length"}</span>
                    <input className="input" inputMode="decimal" value={v.max} onChange={(e) => update("variables", i, { max: e.target.value })} />
                  </label>
                  {v.type === "string" && (
                    <label className="field">
                      <span className="field__label">Pattern (regex)</span>
                      <input className="input mono" value={v.pattern} placeholder="^[A-Za-z0-9_ -]{1,40}$" spellCheck={false} onChange={(e) => update("variables", i, { pattern: e.target.value })} />
                    </label>
                  )}
                </div>
              )}
              <div className="tpl-var__toggles">
                <label className="check-line">
                  <input type="checkbox" checked={v.userEditable} onChange={(e) => update("variables", i, { userEditable: e.target.checked })} />
                  <span>Owners can edit</span>
                </label>
                <label className="check-line">
                  <input type="checkbox" checked={v.required} onChange={(e) => update("variables", i, { required: e.target.checked })} />
                  <span>Required</span>
                </label>
                <label className="check-line">
                  <input type="checkbox" checked={v.secret} onChange={(e) => update("variables", i, { secret: e.target.checked })} />
                  <span>Secret</span>
                </label>
              </div>
            </fieldset>
          ))}
        </div>
        <div className="form__actions">
          <Button size="sm" disabled={d.variables.length >= 40} onClick={() => set({ variables: [...d.variables, emptyVar()] })}>
            <Plus /> Add variable definition
          </Button>
        </div>
      </section>

      <section className="form-section" aria-labelledby="t-quick">
        <h3 id="t-quick">Quick commands</h3>
        <p className="small faint">Buttons shown above the console for servers on this template.</p>
        <div className="tpl-rows">
          {d.quick.map((q, i) => (
            <div className="tpl-row tpl-row--env" key={i}>
              <input className="input" aria-label={`Quick command ${i + 1} label`} placeholder="Label" maxLength={40} value={q.label} onChange={(e) => update("quick", i, { label: e.target.value })} />
              <input className="input mono" aria-label={`Quick command ${i + 1} command`} placeholder="Command" maxLength={256} value={q.command} spellCheck={false} onChange={(e) => update("quick", i, { command: e.target.value.replace(/[\r\n]/g, "") })} />
              <RemoveButton label={`Remove quick command ${i + 1}`} onClick={() => remove("quick", i)} />
            </div>
          ))}
        </div>
        <div className="form__actions">
          <Button size="sm" disabled={d.quick.length >= 20} onClick={() => set({ quick: [...d.quick, { label: "", command: "" }] })}>
            <Plus /> Add quick command
          </Button>
        </div>
      </section>

      <section className="form-section" aria-labelledby="t-addons">
        <h3 id="t-addons">Add-on support</h3>
        <div className="toggle-row">
          <div>
            <strong>Mods and plugins</strong>
            <small>Lets servers on this template install mods or plugins from a catalog plugin.</small>
          </div>
          <Switch
            label="Add-on support"
            checked={d.addonsOn}
            onChange={(on) => set({ addonsOn: on, ...(on && !d.addonsJson.trim() ? { addonsJson: JSON.stringify(addonPreset, null, 2) } : {}) })}
          />
        </div>
        {d.addonsOn && (
          <>
            <div className="form__actions">
              <Button size="sm" onClick={() => set({ addonsJson: JSON.stringify(addonPreset, null, 2) })}>
                Minecraft Java (mods &amp; plugins)
              </Button>
              <span className="small faint">Fills in the rules Fledge uses for its Minecraft templates.</span>
            </div>
            <label className="field">
              <span className="field__label">Rules (advanced, JSON)</span>
              <textarea className="input" rows={12} spellCheck={false} aria-invalid={!!addonError} value={d.addonsJson} onChange={(e) => set({ addonsJson: e.target.value })} />
              <span className="field__hint" style={addonError ? { color: "var(--bad)" } : undefined}>
                {addonError || "Valid. Maps the server type (for example PAPER or FABRIC) to a folder and compatible loaders."}
              </span>
            </label>
          </>
        )}
      </section>

      <Notice tone="neutral">
        Changing the image, command, ports or environment creates a new version. Servers stay on their current version until you apply the update.
      </Notice>
      {issues.length > 0 && (
        <div className="tpl-issues" role="status">
          <strong>Fix these before saving</strong>
          <ul>
            {issues.slice(0, 6).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
            {issues.length > 6 ? <li>…and {issues.length - 6} more</li> : null}
          </ul>
        </div>
      )}
      <ErrorNotice message={error} />
      <div className="form__actions tpl-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={issues.length > 0}>
          {isNew ? "Create template" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="btn btn--ghost btn--icon btn--sm tpl-remove" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Trash2 />
    </button>
  );
}
