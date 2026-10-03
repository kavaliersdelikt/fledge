"use client";

import { items, json, request, type NotificationChannel, type NotificationEvent, type NotificationKind, type Server, type User } from "@/lib/api";
import { fmtAgo, fmtTime } from "@/lib/format";
import { Bell, Mail, Plus, Webhook } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Modal } from "./feedback";
import { useToast } from "./toast";
import { Button, Card, Confirm, Empty, ErrorNotice, Segmented, State, Status, Switch, useLoad, type Tone } from "./shared";

const kindLabel: Record<NotificationKind, string> = {
  discord: "Discord",
  slack: "Slack",
  webhook: "Generic webhook",
  email: "Email",
};
const urlHint: Record<string, string> = {
  discord: "https://discord.com/api/webhooks/…",
  slack: "https://hooks.slack.com/services/…",
  webhook: "https://example.com/hooks/fledge",
};
const tone = (s: NotificationEvent["severity"]): Tone => (s === "bad" ? "bad" : s === "warn" ? "warn" : s === "ok" ? "ok" : "neutral");
const severityWord = { bad: "Critical", warn: "Warning", ok: "Good news", info: "Info" } as const;

type Draft = {
  id: string | null;
  name: string;
  kind: NotificationKind;
  url: string;
  to: string;
  events: Set<string>;
  limited: boolean;
  serverIds: Set<string>;
  enabled: boolean;
  scope: "panel" | "user";
};

export default function NotificationsCard({ user }: { user: User }) {
  const admin = user.role === "admin";
  const toast = useToast();
  const channels = useLoad<NotificationChannel[]>("/notification-channels");
  const events = useLoad<NotificationEvent[]>("/notification-events");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testing, setTesting] = useState("");
  const list = items(channels.data);
  const eventList = items(events.data);

  function create() {
    setDraft({
      id: null,
      name: "",
      kind: "discord",
      url: "",
      to: user.email,
      events: new Set(eventList.filter((e) => e.severity === "bad").map((e) => e.id)),
      limited: false,
      serverIds: new Set(),
      enabled: true,
      scope: admin ? "panel" : "user",
    });
  }
  function edit(c: NotificationChannel) {
    setDraft({
      id: c.id,
      name: c.name,
      kind: c.kind,
      url: "",
      to: c.to || user.email,
      events: new Set(c.events),
      limited: !!c.serverIds,
      serverIds: new Set(c.serverIds || []),
      enabled: c.enabled,
      scope: c.scope,
    });
  }
  async function test(c: NotificationChannel) {
    setTesting(c.id);
    try {
      await json("POST", `/notification-channels/${c.id}/test`);
      toast({ tone: "ok", title: "Test message sent", description: c.kind === "email" ? `Check ${c.to || "your inbox"}.` : `Delivered to ${c.urlHost || c.name}.` });
    } catch (e) {
      toast({ tone: "bad", title: "The test didn’t go through", description: (e as Error).message });
    } finally {
      setTesting("");
      channels.reload();
    }
  }
  async function toggle(c: NotificationChannel, enabled: boolean) {
    try {
      await json("PATCH", `/notification-channels/${c.id}`, { enabled });
      channels.reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  }

  return (
    <>
      <Card
        title="Notification channels"
        description={
          admin
            ? "Get a message in Discord, Slack, any webhook or by email when something needs attention. Panel-wide channels cover every server; personal ones only reach you."
            : "Get a message in Discord, Slack, any webhook or by email when something happens to your servers."
        }
        flush
        actions={
          <Button size="sm" disabled={!eventList.length} onClick={create}>
            <Plus /> Add channel
          </Button>
        }
      >
        <State loading={channels.loading || events.loading} error={channels.error || events.error} rows={2}>
          {list.length ? (
            <ul className="plug-list" aria-label="Notification channels">
              {list.map((c) => {
                const Icon = c.kind === "email" ? Mail : c.kind === "webhook" ? Webhook : Bell;
                return (
                  <li className="plug-row plug-row--top" key={c.id}>
                    <Icon className="session-icon" aria-hidden="true" />
                    <div className="plug-row__main">
                      <span className="plug-row__name">
                        <strong>{c.name}</strong>
                        <span className="tag">{kindLabel[c.kind]}</span>
                        {admin ? <span className="tag">{c.scope === "panel" ? "Whole panel" : "Only me"}</span> : null}
                        {!c.enabled ? <span className="tag">Paused</span> : null}
                      </span>
                      <span className="plug-row__desc">
                        {c.kind === "email" ? c.to : c.urlHost}
                        {" · "}
                        {c.events.length} {c.events.length === 1 ? "event" : "events"}
                        {c.serverIds ? ` · ${c.serverIds.length} ${c.serverIds.length === 1 ? "server" : "servers"}` : ""}
                      </span>
                      <span className="plug-row__status">
                        {c.lastStatus ? (
                          <Status
                            tone={c.lastStatus === "sent" ? "ok" : "bad"}
                            label={`${c.lastStatus === "sent" ? "Last message delivered" : "Last delivery failed"}${c.lastSentAt ? ` ${fmtAgo(c.lastSentAt)}` : ""}`}
                            value={c.lastStatus}
                          />
                        ) : (
                          <span className="faint small">Nothing sent yet</span>
                        )}
                      </span>
                      {c.lastStatus === "failed" && c.lastError ? (
                        <span className="addon-error small" title={c.lastSentAt ? fmtTime(c.lastSentAt) : undefined}>
                          {c.lastError}
                        </span>
                      ) : null}
                    </div>
                    <div className="plug-row__actions">
                      <Switch label={`${c.enabled ? "Pause" : "Resume"} ${c.name}`} checked={c.enabled} onChange={(v) => void toggle(c, v)} />
                      <Button size="sm" busy={testing === c.id} onClick={() => void test(c)}>
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => edit(c)}>
                        Edit
                      </Button>
                      <Confirm
                        variant="ghost"
                        confirmLabel="Delete channel"
                        text={`“${c.name}” stops receiving messages.`}
                        onConfirm={async () => {
                          await request(`/notification-channels/${c.id}`, { method: "DELETE" });
                          channels.reload();
                        }}
                      >
                        Delete
                      </Confirm>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty
              title="No channels yet"
              action={
                eventList.length ? (
                  <Button size="sm" onClick={create}>
                    Add a channel
                  </Button>
                ) : undefined
              }
            >
              Add a Discord, Slack, webhook or email channel to hear about crashes, failed backups and more.
            </Empty>
          )}
        </State>
      </Card>
      {draft && (
        <ChannelEditor
          key={draft.id || "new"}
          draft={draft}
          user={user}
          events={eventList}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            channels.reload();
          }}
        />
      )}
    </>
  );
}

function ChannelEditor({
  draft: initial,
  user,
  events,
  onClose,
  onSaved,
}: {
  draft: Draft;
  user: User;
  events: NotificationEvent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const admin = user.role === "admin";
  const toast = useToast();
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("");
  const editing = !!d.id;
  const servers = useLoad<Server[]>(d.limited ? "/servers?limit=100&offset=0" : null);
  const serverList = items(servers.data).filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()));
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));
  const flip = (key: "events" | "serverIds", id: string) =>
    setD((p) => {
      const next = new Set(p[key]);
      if (!next.delete(id)) next.add(id);
      return { ...p, [key]: next };
    });
  const groups: { id: "server" | "panel"; title: string; items: NotificationEvent[] }[] = [
    { id: "server" as const, title: "Server events", items: events.filter((e) => e.scope === "server") },
    { id: "panel" as const, title: "Panel events", items: events.filter((e) => e.scope === "panel") },
  ].filter((g) => g.items.length);
  const hasServerEvents = events.some((e) => e.scope === "server" && d.events.has(e.id));

  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!d.events.size) return setError("Pick at least one event to be told about.");
    if (d.limited && !d.serverIds.size) return setError("Pick at least one server, or turn off the server limit.");
    const body: Record<string, unknown> = {
      name: d.name.trim(),
      events: [...d.events],
      serverIds: d.limited ? [...d.serverIds] : null,
      enabled: d.enabled,
    };
    if (!editing) {
      body.kind = d.kind;
      if (admin) body.scope = d.scope;
    }
    if (d.kind === "email") body.to = d.to.trim();
    else if (d.url.trim()) body.url = d.url.trim();
    else if (!editing) return setError("Paste the webhook address to send messages to.");
    setBusy(true);
    try {
      if (editing) await json("PATCH", `/notification-channels/${d.id}`, body);
      else await json("POST", "/notification-channels", body);
      toast({ tone: "ok", title: editing ? "Channel saved" : "Channel added" });
      onSaved();
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={editing ? "Edit channel" : "Add a channel"}
      description="Choose where messages go and which events trigger them."
    >
      <form className="form" onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Name</span>
            <input className="input" required maxLength={80} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ops channel" autoFocus />
          </label>
          <label className="field">
            <span className="field__label">Type</span>
            <select className="input select" value={d.kind} disabled={editing} onChange={(e) => set({ kind: e.target.value as NotificationKind })}>
              {(Object.keys(kindLabel) as NotificationKind[]).map((k) => (
                <option key={k} value={k}>
                  {kindLabel[k]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {d.kind === "email" ? (
          <label className="field">
            <span className="field__label">Send to</span>
            <input
              className="input"
              type="email"
              required
              value={d.to}
              readOnly={!admin}
              onChange={(e) => set({ to: e.target.value })}
            />
            <span className="field__hint">
              {admin ? "Needs email to be set up under Settings → Email." : "Messages go to your account’s address."}
            </span>
          </label>
        ) : (
          <label className="field">
            <span className="field__label">Webhook address</span>
            <input
              className="input mono"
              type="url"
              value={d.url}
              required={!editing}
              autoComplete="off"
              spellCheck={false}
              placeholder={editing ? "Leave empty to keep the saved address" : urlHint[d.kind]}
              onChange={(e) => set({ url: e.target.value })}
            />
            <span className="field__hint">
              {admin ? "Stored encrypted and never shown again." : "Must be an https:// address. Stored encrypted and never shown again."}
            </span>
          </label>
        )}

        {admin && (
          <div className="field">
            <span className="field__label" id="scope-label">
              Who it’s for
            </span>
            {editing ? (
              <span className="small muted">{d.scope === "panel" ? "Whole panel" : "Only me"} (can’t be changed)</span>
            ) : (
              <Segmented
                label="Who it’s for"
                value={d.scope}
                onChange={(scope) => set({ scope })}
                options={[
                  { value: "panel", label: "Whole panel" },
                  { value: "user", label: "Only me" },
                ]}
              />
            )}
            <span className="field__hint">
              {d.scope === "panel" ? "Reports events across every server and node." : "Only reports on servers you own or can access."}
            </span>
          </div>
        )}

        <fieldset className="chan-events">
          <legend className="field__label">Tell me when</legend>
          {groups.map((g) => (
            <div key={g.id} className="chan-group">
              <div className="chan-group__head">
                <strong>{g.title}</strong>
                <span className="btn-group">
                  <button type="button" className="text-button" onClick={() => set({ events: new Set([...d.events, ...g.items.map((i) => i.id)]) })}>
                    All
                  </button>
                  <button type="button" className="text-button" onClick={() => set({ events: new Set([...d.events].filter((id) => !g.items.some((i) => i.id === id))) })}>
                    None
                  </button>
                </span>
              </div>
              <div className="chan-list">
                {g.items.map((ev) => (
                  <label className="check-line chan-event" key={ev.id}>
                    <input type="checkbox" checked={d.events.has(ev.id)} onChange={() => flip("events", ev.id)} />
                    <Status tone={tone(ev.severity)} label={ev.label} value={ev.severity} />
                    <span className="sr-only">({severityWord[ev.severity] || ev.severity})</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </fieldset>

        {hasServerEvents && (
          <div className="chan-group">
            <div className="toggle-row">
              <div>
                <strong>Only for these servers</strong>
                <small>Off means every server you can see.</small>
              </div>
              <Switch label="Limit to specific servers" checked={d.limited} onChange={(limited) => set({ limited })} />
            </div>
            {d.limited && (
              <State loading={servers.loading} error={servers.error} rows={2}>
                {items(servers.data).length > 8 && (
                  <input className="input input--search" type="search" aria-label="Filter servers" placeholder="Filter servers" value={filter} onChange={(e) => setFilter(e.target.value)} />
                )}
                <div className="chan-list chan-list--scroll">
                  {serverList.map((s) => (
                    <label className="check-line" key={s.id}>
                      <input type="checkbox" checked={d.serverIds.has(s.id)} onChange={() => flip("serverIds", s.id)} />
                      {s.name}
                    </label>
                  ))}
                  {!serverList.length && <span className="faint small">No servers match.</span>}
                </div>
              </State>
            )}
          </div>
        )}

        <div className="toggle-row">
          <div>
            <strong>Enabled</strong>
            <small>Paused channels keep their settings but send nothing.</small>
          </div>
          <Switch label="Channel enabled" checked={d.enabled} onChange={(enabled) => set({ enabled })} />
        </div>

        <ErrorNotice message={error} />
        <div className="modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>
            {editing ? "Save channel" : "Add channel"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
