"use client";
import {
items,
json,
type Node,
type Server,
type Template
} from "@/lib/api";
import {
ChevronRight,
Plus
} from "lucide-react";
import Link from "next/link";
import {
useState
} from "react";

import { Modal } from "./feedback";
import {
Badge,
Button,
Empty,
ErrorBox,
Field,
Form,
Heading,
Notice,
Pager,
Row,
Section,
Select,
State,
useLoad
} from "./shared";
export default function Servers({ admin }: { admin: boolean }) {
  const [offset, setOffset] = useState(0),
    [filter, setFilter] = useState(""),
    [create, setCreate] = useState(false),
    [status, setStatus] = useState("all");
  const { data, error, loading, reload } = useLoad<Server[]>(
    `/servers?limit=50&offset=${offset}`,
    12000,
  );
  const {
    data: templates,
    error: templateError,
    loading: templateLoading,
  } = useLoad<Template[]>(admin ? "/templates" : null);
  const {
    data: customers,
    error: customerError,
    loading: customerLoading,
  } = useLoad<Row[]>(admin ? "/customers?limit=100" : null);
  const {
    data: nodes,
    error: nodeError,
    loading: nodeLoading,
  } = useLoad<Node[]>(admin ? "/nodes" : null);
  const [created, setCreated] = useState<Row | null>(null);
  const list = items(data).filter(
    (s) =>
      `${s.name} ${s.id} ${s.location}`
        .toLowerCase()
        .includes(filter.toLowerCase()) &&
      (status === "all" || s.status === status),
  );
  return (
    <>
      <Heading
        eyebrow="Workspace / Servers"
        title="Servers"
        subtitle={
          admin
            ? "Manage customer servers, placement, and lifecycle."
            : "Your servers and shared instances."
        }
        action={
          admin ? (
            <Button className="primary" onClick={() => setCreate(!create)}>
              <Plus size={16} /> Create server
            </Button>
          ) : undefined
        }
      />
      {admin && (
        <Modal
          open={create}
          onOpenChange={setCreate}
          title="Create a server"
          description="Choose a game, assign an owner, and set its resource limits. Available capacity determines placement."
        >
          {templateError || customerError || nodeError ? (
            <ErrorBox
              message={[templateError, customerError, nodeError]
                .filter(Boolean)
                .join(" · ")}
            />
          ) : templateLoading || customerLoading || nodeLoading ? (
            <div className="skeleton" />
          ) : (
            <Form
              submit="Start provisioning"
              onSubmit={async (v) => {
                const result = (await json("POST", "/servers", {
                  name: v.name,
                  ownerId: v.ownerId,
                  templateId: v.templateId,
                  location: v.location || undefined,
                  nodeId: v.nodeId || undefined,
                  memoryMb: Number(v.memoryMb),
                  cpuPercent: Number(v.cpuPercent),
                  diskMb: Number(v.diskMb),
                  port: v.port ? Number(v.port) : undefined,
                })) as Row;
                setCreated(result);
                reload();
              }}
            >
              <div className="form-grid">
                <Field label="Server name" name="name" required />
                <Select label="Customer" name="ownerId">
                  <option value="">Select customer</option>
                  {items(customers).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.email}
                    </option>
                  ))}
                </Select>
                <Select label="Game template" name="templateId">
                  <option value="">Select template</option>
                  {items(templates).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <Select label="Node" name="nodeId" required={false}>
                  <option value="">Place automatically</option>
                  {items(nodes)
                    .filter((n) => n.status === "connected" && !n.draining)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} · {n.location}
                      </option>
                    ))}
                </Select>
                <Field label="Location (optional)" name="location" />
                <Field
                  label="RAM (MB)"
                  name="memoryMb"
                  type="number"
                  min={1}
                  defaultValue={2048}
                  required
                />
                <Field
                  label="CPU (%)"
                  name="cpuPercent"
                  type="number"
                  min={1}
                  defaultValue={100}
                  required
                />
                <Field
                  label="Disk (MB)"
                  name="diskMb"
                  type="number"
                  min={1}
                  defaultValue={10240}
                  required
                />
                <Field
                  label="Port (optional)"
                  name="port"
                  type="number"
                  min={1024}
                />
              </div>
            </Form>
          )}
          {created && (
            <Notice>
              Provisioning queued · Job{" "}
              {created.job?.id || created.jobId || created.id} · Node{" "}
              {created.placement?.selected}.{" "}
              {created.placement?.rejected?.length
                ? `${created.placement.rejected.length} candidates rejected.`
                : ""}
            </Notice>
          )}
        </Modal>
      )}
      <div className="filter-toolbar">
        <div className="segmented" aria-label="Filter server status">
          {["all", "running", "stopped", "unreachable"].map((value) => (
            <button
              key={value}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {value === "all" ? "All statuses" : value}
            </button>
          ))}
        </div>
        <span className="muted small">{list.length} shown on this page</span>
      </div>
      <Section
        title="Server fleet"
        description="Status refreshes every 12 seconds."
        className="server-fleet-table"
        action={
          <input
            className="search"
            aria-label="Search servers"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search this page…"
          />
        }
      >
        <State loading={loading} error={error}>
          {!list.length ? (
            <Empty>
              {filter || status !== "all"
                ? "No matching servers on this page."
                : "No servers found."}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Server</th>
                    <th>Status</th>
                    <th>Location / node</th>
                    <th>Resources</th>
                    <th>Port</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link className="strong-link" href={`/servers/${s.id}`}>
                          {s.name}
                        </Link>
                        <div className="muted small">{s.templateId}</div>
                      </td>
                      <td>
                        <Badge value={s.status} />
                        {s.status === "unreachable" && (
                          <div className="muted small">
                            Last observed: {s.observedStatus}
                          </div>
                        )}
                      </td>
                      <td>
                        {s.location}
                        <div className="muted small">{s.nodeName}</div>
                      </td>
                      <td>
                        {s.memoryMb} MB <span className="muted">·</span>{" "}
                        {s.cpuPercent}% CPU
                      </td>
                      <td className="mono">{s.port}</td>
                      <td>
                        <Link
                          href={`/servers/${s.id}`}
                          aria-label={`${s.name} open`}
                        >
                          <ChevronRight size={17} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {
            <Pager
              offset={offset}
              setOffset={setOffset}
              count={items(data).length}
            />
          }
        </State>
      </Section>
    </>
  );
}
