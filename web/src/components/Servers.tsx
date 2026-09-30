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

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import DataTable, { type DataColumn } from "./DataTable";
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
        <Sheet
          open={create}
          onOpenChange={setCreate}
        >
          <SheetContent className="form-sheet" side="right">
            <SheetHeader>
              <SheetTitle>Create a server</SheetTitle>
              <SheetDescription>Choose a game, assign an owner, and set resource limits. Fledge checks available capacity before placement.</SheetDescription>
            </SheetHeader>
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
          </SheetContent>
        </Sheet>
      )}
      <div className="filter-toolbar">
        <div className="segmented" aria-label="Filter server status">
          {["all", "running", "stopped", "unreachable"].map((value) => (
            <button
              key={value}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {value === "all" ? `All · ${items(data).length}` : `${value} · ${items(data).filter((server) => server.status === value).length}`}
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
            <DataTable
              data={list}
              rowKey={(server) => server.id}
              columns={[
                { id: "name", header: "Server", value: (server) => server.name, render: (server) => <div className="table-entity"><Link className="strong-link" href={`/servers/${server.id}`}>{server.name}</Link><small>{server.templateId}</small></div> },
                { id: "status", header: "Status", value: (server) => server.status, render: (server) => <div><Badge value={server.status} />{server.status === "unreachable" && <small className="table-subline">Last observed: {server.observedStatus}</small>}</div> },
                { id: "location", header: "Host", value: (server) => server.nodeName || server.location, render: (server) => <div>{server.nodeName || "Unassigned"}<small className="table-subline">{server.location || "No location"}</small></div> },
                { id: "memory", header: "Resources", value: (server) => server.memoryMb, render: (server) => <span className="mono">{server.memoryMb} MB · {server.cpuPercent}% CPU</span> },
                { id: "port", header: "Port", value: (server) => server.port, render: (server) => <span className="mono">{server.port}</span> },
                { id: "open", header: "", value: () => "", sortable: false, render: (server) => <Link href={`/servers/${server.id}`} className="table-open-link" aria-label={`Open ${server.name}`}><ChevronRight size={16} /></Link> },
              ] as DataColumn<Server>[]}
              empty="No matching servers on this page."
            />
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
