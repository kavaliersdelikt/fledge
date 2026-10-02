"use client";

import { items, type Node, type Server, type User } from "@/lib/api";
import { fmtAction, fmtClock, fmtTime, shortId } from "@/lib/format";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { Card, Empty, PageHeader, Pager, Row, SearchInput, Segmented, State, Toolbar, useLoad } from "./shared";

function dayLabel(value: string) {
  const d = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

export default function ActivityPage() {
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"changes" | "all">("changes");
  const { data, error, loading } = useLoad<Row[]>(`/activity?limit=50&offset=${offset}`, 15000);
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
  const actor = (e: Row) => e.actor_id || e.actorId || "";
  const targetId = (e: Row) => e.target_id || e.entity_id || e.targetId || "";
  const label = (id: string) => (id ? names[id] || shortId(id) : "");
  const list = items(data).filter(
    (e) =>
      (scope === "all" || e.action !== "login") &&
      `${fmtAction(e.action)} ${e.action} ${label(targetId(e))} ${label(actor(e))}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <PageHeader title="Activity" />
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
      <Card flush>
        <State loading={loading} error={error} rows={8}>
          {list.length ? (
            <div className="log">
              {list.map((e, i) => {
                const day = dayLabel(when(e));
                const target = targetId(e);
                const by = actor(e);
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
                      <span className="log__by">{by && by !== target && by !== me?.id ? label(by) : null}</span>
                    </div>
                  </Fragment>
                );
              })}
            </div>
          ) : (
            <Empty title={query ? "Nothing matches your search" : "No activity yet"} />
          )}
          <Pager offset={offset} setOffset={setOffset} count={items(data).length} />
        </State>
      </Card>
    </>
  );
}
