"use client";

import { fmtDate, items } from "@/lib/api";
import { Search } from "lucide-react";
import { useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Empty, Heading, Pager, Row, Section, State, useLoad } from "./shared";

export default function ActivityPage() {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState("");
  const { data, error, loading } = useLoad<Row[]>(`/activity?limit=50&offset=${offset}`, 15000);
  const filtered = items(data).filter((event) =>
    `${event.action || ""} ${event.target_type || event.entity_type || ""} ${event.actor_id || ""}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const columns: DataColumn<Row>[] = [
    { id: "time", header: "Time", value: (event) => event.created_at || event.createdAt || "", render: (event) => fmtDate(event.created_at || event.createdAt) },
    { id: "action", header: "Action", value: (event) => event.action || "", render: (event) => <span className="mono">{String(event.action || "—").replaceAll(".", " / ")}</span> },
    { id: "object", header: "Object", value: (event) => event.target_type || event.entity_type || event.targetType || "", render: (event) => <span>{event.target_type || event.entity_type || event.targetType || "—"}<small className="table-subline mono">{event.target_id || event.entity_id || event.targetId || ""}</small></span> },
    { id: "actor", header: "Actor", value: (event) => event.actor_id || event.actorId || "", render: (event) => <span className="mono small">{event.actor_id || event.actorId || "—"}</span> },
  ];

  return (
    <>
      <Heading eyebrow="Workspace / Activity" title="Activity" subtitle="Auditable actions by administrators and customers." />
      <div className="summary-strip" aria-label="Activity context">
        <div><span>Events on this page</span><strong>{items(data).length}</strong></div>
        <div><span>Search matches</span><strong>{filtered.length}</strong></div>
        <div><span>Auto refresh</span><strong>15 sec</strong></div>
      </div>
      <Section
        title="Audit trail"
        description="Search covers the currently loaded page of up to 50 events."
        action={<label className="search-control"><Search size={15} /><input className="search" aria-label="Search activity" placeholder="Search actions, targets, actors…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>}
      >
        <State loading={loading} error={error}>
          {filtered.length ? (
            <DataTable data={filtered} rowKey={(event) => String(event.id || event.created_at || event.createdAt)} columns={columns} empty="No activity on this page." />
          ) : (
            <Empty>{filter ? "No activity matches this search." : "No events yet."}</Empty>
          )}
          <Pager offset={offset} setOffset={setOffset} count={items(data).length} />
        </State>
      </Section>
    </>
  );
}
