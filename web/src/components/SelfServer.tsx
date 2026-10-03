"use client";
import { json } from "@/lib/api";
import { fmtDay } from "@/lib/format";
import { cpuText, memText, type LimitsView, type SelfOptions } from "@/lib/commerce";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Drawer } from "./feedback";
import { LimitUsage } from "./LimitsUI";
import { Button, Card, ErrorNotice, Notice, State, btn, useLoad } from "./shared";
import { useToast } from "./toast";

/** A customer creating a server for themselves, within their limits. */
export function CreateMyServer({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading } = useLoad<SelfOptions>(open ? "/me/servers/options" : null);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [mem, setMem] = useState<number | null>(null),
    [cpu, setCpu] = useState<number | null>(null),
    [disk, setDisk] = useState<number | null>(null);
  const [location, setLocation] = useState("");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  const t = data?.templates.find((x) => x.id === (templateId || data?.templates[0]?.id));
  const custom = !!data?.customResources;
  const maxMem = data?.limits?.rows.find((r) => r.key === "maxServerMemoryMb")?.limit ?? null;
  async function create() {
    if (!t) return;
    setBusy(true);
    setErr("");
    try {
      const changed = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== ""));
      const r = (await json("POST", "/me/servers", {
        templateId: t.id,
        name,
        ...(custom ? { memoryMb: mem ?? t.memoryMb, cpuPercent: cpu ?? t.cpuPercent, diskMb: disk ?? t.diskMb } : {}),
        location: location || undefined,
        variables: Object.keys(changed).length ? changed : undefined,
      })) as { id: string };
      toast({ tone: "ok", title: "Creating your server", description: name });
      onCreated();
      onOpenChange(false);
      router.push(`/servers/${r.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="New server" description="Pick a kind of server and how big it should be. It is ready in a minute or two.">
      <State loading={loading} error={error}>
        {data && !data.canCreate ? (
          <Notice tone="warn">You cannot create servers yourself right now.{data.limits?.flags?.selfCreate === false ? " Your plan does not include it." : ""} Look at the store for a plan.</Notice>
        ) : null}
        {data && data.canCreate && data.templates.length === 0 ? <Notice tone="neutral">No kind of server is available yet. Your provider has to release one first.</Notice> : null}
        {data && data.canCreate && t ? (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <label className="field">
              <span className="field__label">Kind of server</span>
              <select className="input select" value={t.id} onChange={(e) => { setTemplateId(e.target.value); setVars({}); setMem(null); setCpu(null); setDisk(null); }}>
                {data.templates.map((x) => (
                  <option key={x.id} value={x.id}>{x.name}</option>
                ))}
              </select>
              {t.description ? <span className="field__hint">{t.description}</span> : null}
            </label>
            <label className="field">
              <span className="field__label">Name</span>
              <input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Our survival world" />
            </label>
            {custom ? (
              <div className="form-grid">
                <label className="field">
                  <span className="field__label">Memory (MB)</span>
                  <input className="input" type="number" min={256} step={256} max={maxMem ?? undefined} value={mem ?? t.memoryMb} onChange={(e) => setMem(Number(e.target.value))} />
                  <span className="field__hint">{memText(mem ?? t.memoryMb)}{maxMem ? ` · at most ${memText(maxMem)}` : ""}</span>
                </label>
                <label className="field">
                  <span className="field__label">CPU (percent of one core)</span>
                  <input className="input" type="number" min={25} step={25} value={cpu ?? t.cpuPercent} onChange={(e) => setCpu(Number(e.target.value))} />
                  <span className="field__hint">{cpuText(cpu ?? t.cpuPercent)}</span>
                </label>
                <label className="field">
                  <span className="field__label">Disk (MB)</span>
                  <input className="input" type="number" min={512} step={1024} value={disk ?? t.diskMb} onChange={(e) => setDisk(Number(e.target.value))} />
                  <span className="field__hint">{memText(disk ?? t.diskMb)}</span>
                </label>
              </div>
            ) : (
              <p className="muted small">Size: {memText(t.memoryMb)} memory, {cpuText(t.cpuPercent)}, {memText(t.diskMb)} disk.</p>
            )}
            {data.locations.length > 1 ? (
              <label className="field">
                <span className="field__label">Location</span>
                <select className="input select" value={location} onChange={(e) => setLocation(e.target.value)}>
                  <option value="">Wherever there is room</option>
                  {data.locations.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {t.variables.map((v) => (
              <label className="field" key={v.key}>
                <span className="field__label">{v.label}</span>
                {v.type === "select" && v.options ? (
                  <select className="input select" value={vars[v.key] ?? ""} onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })}>
                    <option value="">Default</option>
                    {v.options.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input className="input" type={v.type === "number" ? "number" : "text"} value={vars[v.key] ?? ""} placeholder="Default" onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })} />
                )}
                {v.description ? <span className="field__hint">{v.description}</span> : null}
              </label>
            ))}
            {data.limits && !data.limits.hidden ? (
              <Card title="Your allowance" description="Creating this server uses part of it.">
                <LimitUsage view={data.limits} />
              </Card>
            ) : null}
            <ErrorNotice message={err} />
            <div className="form__actions">
              <Button type="submit" variant="primary" busy={busy}>Create server</Button>
              <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            </div>
          </form>
        ) : null}
      </State>
    </Drawer>
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
