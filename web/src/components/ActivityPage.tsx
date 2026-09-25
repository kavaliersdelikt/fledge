"use client";
import {
fmtDate,
items
} from "@/lib/api";
import {
useState
} from "react";

import {
Empty,
Heading,
Pager,
Row,
Section,
State,
useLoad
} from "./shared";
export default function ActivityPage() {
  const [offset, setOffset] = useState(0),
    [filter, setFilter] = useState("");
  const { data, error, loading } = useLoad<Row[]>(
    `/activity?limit=50&offset=${offset}`,
    15000,
  );
  return (
    <>
      <Heading
        eyebrow="Workspace / Activity"
        title="Activity"
        subtitle="Auditable actions by administrators and customers."
      />
      <Section
        title="Audit trail"
        description="Actions are recorded automatically. Search applies to the current page."
        action={
          <input
            className="search"
            aria-label="Search activity"
            placeholder="Search actions…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        }
      >
        <State loading={loading} error={error}>
          {!items(data).filter((a) =>
            String(a.action).toLowerCase().includes(filter.toLowerCase()),
          ).length ? (
            <Empty>No events yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Object</th>
                    <th>Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {items(data)
                    .filter((a) =>
                      String(a.action)
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((a, i) => (
                      <tr key={a.id || i}>
                        <td>{fmtDate(a.created_at || a.createdAt)}</td>
                        <td className="mono">{a.action}</td>
                        <td>
                          {a.target_type ||
                            a.entity_type ||
                            a.targetType ||
                            "—"}{" "}
                          <span className="muted small mono">
                            {a.target_id || a.entity_id || a.targetId || ""}
                          </span>
                        </td>
                        <td className="mono small">
                          {a.actor_id || a.actorId || "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager
            offset={offset}
            setOffset={setOffset}
            count={items(data).length}
          />
        </State>
      </Section>
    </>
  );
}
