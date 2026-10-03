"use client";

import { API, items, type Node, type Server, type User } from "@/lib/api";
import { fmtAction, fmtClock, fmtTime, shortId } from "@/lib/format";
import { Download, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useToast } from "./toast";
import { Button, Card, Empty, PageHeader, Pager, Row, SearchInput, Segmented, State, Toolbar, useLoad } from "./shared";

function dayLabel(value: string) {
  const d = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

/** Action prefixes the API understands (`action=server.` matches server.start, server.stop, …). */
const groups: { value: string; label: string }[] = [
  { value: "", label: "All activity" },
  { value: "server.", label: "Servers" },
  { value: "backup.", label: "Backups" },
  { value: "restore.", label: "Restores" },
  { value: "schedule.", label: "Schedules" },
  { value: "addon.", label: "Mods and add-ons" },
  { value: "plugin.", label: "Plugins" },
  { value: "template.", label: "Templates" },
  { value: "customer.", label: "Customers" },
  { value: "node.", label: "Nodes" },
  { value: "settings.", label: "Settings" },
  { value: "notification.", label: "Notifications" },
  { value: "login", label: "Sign-ins" },
  { value: "session.", label: "Sessions" },
  { value: "passkey.", label: "Passkeys" },
  { value: "password.", label: "Passwords" },
  { value: "token.", label: "API tokens" },
];

/** A local calendar day boundary as an ISO timestamp. */
function dayBound(value: string, end: boolean) {
  if (!value) return "";
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
  return date.toISOString();
}

export default function ActivityPage() {
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"changes" | "all">("changes");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [actor, setActor] = useState<{ id: string; label: string } | null>(null);
  const [exporting, setExporting] = useState<"" | "csv" | "json">("");

  // Typing waits a moment so the log isn't re-queried on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setOffset(0), [search, action, from, to, actor]);

  const filterQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (action) p.set("action", action);
    if (actor) p.set("actor", actor.id);
    const f = dayBound(from, false),
      t = dayBound(to, true);
    if (f) p.set("from", f);
    if (t) p.set("to", t);
    return p;
  }, [search, action, actor, from, to]);
  const filtered = filterQuery.size > 0;
  const rangeBad = !!from && !!to && from > to;

  const { data, error, loading } = useLoad<Row[]>(`/activity?limit=50&offset=${offset}${filtered ? `&${filterQuery}` : ""}`, 15000);
  // Names for the IDs in the audit log; IDs that can't be resolved are shown shortened.
  const { data: me } = useLoad<User>("/auth/me");
  const { data: customers } = useLoad<Row[]>("/customers?limit=100");
  const { data: servers } = useLoad<Server[]>("/servers?limit=100&offset=0");
  const { data: nodes } = useLoad<Node[]>("/nodes");
  const names = useMemo(() => {
    const map: Record<string, string> = {
      ...Object.fromEntries(items(customers).map((c) => [c.id, c.email])),
      ...Object.fromEntries(items(servers).map((s) => [s.id, s.name])),
      ...Object.fromEntries(items(nodes).map((n) => [n.id, n.name])),
    };
    if (me) map[me.id] = me.email;
    return map;
  }, [customers, servers, nodes, me]);
  const serverIds = useMemo(() => new Set(items(servers).map((s) => s.id)), [servers]);

  const when = (e: Row) => e.created_at || e.createdAt || "";
  const actorId = (e: Row) => e.actor_id || e.actorId || "";
  const targetId = (e: Row) => e.target_id || e.entity_id || e.targetId || "";
  const label = (id: string) => (id ? names[id] || shortId(id) : "");
  // Sign-ins are noise next to real changes, unless someone asked for them.
  const hideLogins = scope === "changes" && !action;
  const list = items(data).filter((e) => !hideLogins || e.action !== "login");

  function clear() {
    setQuery("");
    setSearch("");
    setAction("");
    setFrom("");
    setTo("");
    setActor(null);
  }

  async function download(format: "csv" | "json") {
    setExporting(format);
    try {
      const p = new URLSearchParams(filterQuery);
      p.set("format", format);
      const response = await fetch(`${API}/api/activity/export?${p}`, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        let message = `The export failed (${response.status}).`;
        try {
          const body = await response.json();
          message = body.message || body.error || message;
        } catch {
          /* not JSON */
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name ? decodeURIComponent(name) : `fledge-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast({ tone: "ok", title: `Exported as ${format.toUpperCase()}`, description: filtered ? "Only entries matching your filters are included." : "Includes the most recent 50,000 entries." });
    } catch (e) {
      toast({ tone: "bad", title: "Couldn’t export the log", description: (e as Error).message });
    } finally {
      setExporting("");
    }
  }

  return (
    <>
      <PageHeader
        title="Activity"
        actions={
          <span className="btn-group">
            <Button size="sm" busy={exporting === "csv"} disabled={!!exporting} onClick={() => void download("csv")}>
              <Download /> Export CSV
            </Button>
            <Button size="sm" busy={exporting === "json"} disabled={!!exporting} onClick={() => void download("json")}>
              <Download /> Export JSON
            </Button>
          </span>
        }
      />
      <Toolbar>
        <Segmented
          label="Show"
          value={scope}
          onChange={setScope}
          options={[
            { value: "changes", label: "Changes" },
            { value: "all", label: "Everything" },
          ]}
        />
        <SearchInput label="Search activity" placeholder="Search activity" value={query} onChange={setQuery} />
      </Toolbar>
      <div className="activity-filters" role="group" aria-label="Filter activity">
        <label className="activity-filters__item">
          <span className="sr-only">Type of activity</span>
          <select className="input select" value={action} onChange={(e) => setAction(e.target.value)}>
            {groups.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="activity-filters__item">
          <span className="activity-filters__label">From</span>
          <input className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="activity-filters__item">
          <span className="activity-filters__label">To</span>
          <input className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        {actor ? (
          <button type="button" className="chip" aria-label={`Remove filter: ${actor.label}`} onClick={() => setActor(null)}>
            By {actor.label} <X aria-hidden="true" className="chip__x" />
          </button>
        ) : null}
        {filtered || query ? (
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </div>
      {rangeBad ? <p className="inline-error">The “from” date is after the “to” date, so nothing can match.</p> : null}
      <Card flush>
        <State loading={loading} error={error} rows={8}>
          {list.length ? (
            <div className="log">
              {list.map((e, i) => {
                const day = dayLabel(when(e));
                const target = targetId(e);
                const by = actorId(e);
                const byName = e.actor_email || (by ? label(by) : "");
                return (
                  <Fragment key={String(e.id || when(e))}>
                    {i === 0 || dayLabel(when(list[i - 1])) !== day ? <div className="log__day">{day}</div> : null}
                    <div className="log__row" style={{ ["--i" as string]: i }}>
                      <time dateTime={when(e)} title={fmtTime(when(e))}>
                        {fmtClock(when(e))}
                      </time>
                      <span className="log__what" title={e.action}>
                        {fmtAction(e.action)}
                        {target ? (
                          serverIds.has(target) ? (
                            <Link href={`/servers/${target}`}>{label(target)}</Link>
                          ) : (
                            <span className={names[target] ? "log__target" : "log__target mono"}>{label(target)}</span>
                          )
                        ) : null}
                      </span>
                      <span className="log__by">
                        {byName && by !== target ? (
                          by ? (
                            <button
                              type="button"
                              className="log__actor"
                              title="Show only this person’s activity"
                              onClick={() => setActor({ id: by, label: byName })}
                            >
                              {by === me?.id ? "You" : byName}
                            </button>
                          ) : (
                            byName
                          )
                        ) : null}
                      </span>
                    </div>
                  </Fragment>
                );
              })}
            </div>
          ) : (
            <Empty
              title={filtered ? "Nothing matches your filters" : "No activity yet"}
              action={
                filtered ? (
                  <Button size="sm" onClick={clear}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              {filtered ? "Try a wider date range or a different type of activity." : undefined}
            </Empty>
          )}
          <Pager offset={offset} setOffset={setOffset} count={items(data).length} />
        </State>
      </Card>
    </>
  );
}
