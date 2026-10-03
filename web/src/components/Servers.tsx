"use client";
import { ApiError, items, json, type Node, type Server, type Template } from "@/lib/api";
import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Drawer } from "./feedback";
import { useFeatures } from "@/lib/commerce";
import { CreateMyServer, UsageStrip } from "./SelfServer";
import { CpuCell, MemoryCell, liveUsage } from "./ServerUsage";
import {
  Button,
  Card,
  Empty,
  ErrorNotice,
  Notice,
  PageHeader,
  Pager,
  Row,
  SearchInput,
  Segmented,
  Skeleton,
  State,
  Status,
  Toolbar,
  UnitField,
  btn,
  useLoad,
} from "./shared";

type Filter = "all" | "running" | "stopped" | "attention";
const needsAttention = (s: Server) => ["failed", "unreachable", "missing"].includes(s.status);

export default function Servers({ admin }: { admin: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [offset, setOffset] = useState(0),
    [query, setQuery] = useState("");
  const status = (["running", "stopped", "attention"].includes(params.get("status") || "")
    ? params.get("status")
    : "all") as Filter;
  const features = useFeatures();
  const canCreateOwn = !admin && features.selfService.mode === "custom";
  const canStore = !admin && (features.store.enabled || features.selfService.mode === "presets");
  const creating = (admin || canCreateOwn) && params.get("new") === "1";
  const setParams = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) v === null ? p.delete(k) : p.set(k, v);
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const { data, error, loading, reload } = useLoad<Server[]>(
    `/servers?limit=50&offset=${offset}`,
    12000,
  );
  const all = items(data);
  const count = (f: Filter) =>
    f === "all" ? all.length : f === "attention" ? all.filter(needsAttention).length : all.filter((s) => s.status === f).length;
  const list = all.filter(
    (s) =>
      `${s.name} ${s.id} ${s.nodeName || ""} ${s.location || ""} ${s.templateId}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (status === "all" || (status === "attention" ? needsAttention(s) : s.status === status)),
  );

  const mixedGames = new Set(all.map((s) => s.templateId)).size > 1;
  const showFilters = all.length > 4 || status !== "all";
  const showSearch = all.length > 8 || !!query;
  const columns: DataColumn<Server>[] = [
    {
      id: "name",
      header: "Name",
      value: (s) => s.name,
      render: (s) => (
        <div className="cell-main">
          <Link href={`/servers/${s.id}`}>{s.name}</Link>
          {mixedGames ? <small>{s.templateId}</small> : null}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      value: (s) => s.status,
      render: (s) => (
        <div className="cell-main">
          {s.pendingDeleteAt ? <Status tone="warn" label="Deleting soon" /> : s.suspended && s.suspendedReason === "billing" ? <Status tone="warn" label="Payment overdue" /> : <Status value={s.suspended ? "suspended" : s.status} />}
          {s.status === "unreachable" ? <small>Last seen {s.observedStatus}</small> : null}
        </div>
      ),
    },
    {
      id: "node",
      header: "Node",
      value: (s) => s.nodeName || "",
      optional: true,
      render: (s) => <span className={s.nodeName ? undefined : "faint"}>{s.nodeName || "Unassigned"}</span>,
    },
    { id: "cpu", header: "CPU", optional: true, width: "150px", value: (s) => liveUsage(s)?.cpu ?? -1, render: (s) => <CpuCell server={s} /> },
    { id: "memory", header: "Memory", optional: true, width: "170px", value: (s) => liveUsage(s)?.mem ?? -1, render: (s) => <MemoryCell server={s} /> },
    { id: "port", header: "Port", align: "end", optional: true, value: (s) => s.port, render: (s) => <span className="num muted">{s.port}</span> },
  ];

  return (
    <>
      <PageHeader
        nav="servers"
        title="Servers"
        actions={
          admin || canCreateOwn ? (
            <span className="btn-group">
              {canStore ? <Link className={btn("secondary")} href="/store">{features.store.title || "Store"}</Link> : null}
              <Button variant="primary" onClick={() => setParams({ new: "1" })}>
                <Plus /> New server
              </Button>
            </span>
          ) : canStore ? (
            <Link className={btn("primary")} href="/store">
              <Plus /> Get a server
            </Link>
          ) : undefined
        }
      />
      {!admin && features.limits.showUsage ? <UsageStrip /> : null}
      {showFilters || showSearch ? (
      <Toolbar>
        {showFilters ? (
        <Segmented
          label="Filter by status"
          value={status}
          onChange={(v) => setParams({ status: v === "all" ? null : v })}
          options={(["all", "running", "stopped", "attention"] as Filter[]).map((f) => ({
            value: f,
            label: (
              <>
                {f === "all" ? "All" : f === "attention" ? "Needs attention" : f[0].toUpperCase() + f.slice(1)}
                <span className="count">{count(f)}</span>
              </>
            ),
          }))}
        />
        ) : <span />}
        {showSearch ? <SearchInput label="Search servers" placeholder="Search servers" value={query} onChange={setQuery} /> : null}
      </Toolbar>
      ) : null}
      <Card flush>
        <State loading={loading} error={error} rows={5}>
          {list.length ? (
            <DataTable data={list} rowKey={(s) => s.id} rowHref={(s) => `/servers/${s.id}`} columns={columns} />
          ) : all.length ? (
            <Empty title="No matching servers">Try another filter or search term.</Empty>
          ) : (
            <Empty
              title="No servers yet"
              action={admin || canCreateOwn ? <Button size="sm" onClick={() => setParams({ new: "1" })}>Create a server</Button> : canStore ? <Link className={btn("primary", "sm")} href="/store">Get a server</Link> : undefined}
            >
              {admin
                ? "Servers are placed on a connected node with enough free capacity."
                : canCreateOwn || canStore
                  ? "Create your first server in a minute."
                  : "Servers you own or are invited to will appear here."}
            </Empty>
          )}
          <Pager offset={offset} setOffset={setOffset} count={all.length} />
        </State>
      </Card>
      {admin && (
        <CreateServer
          open={creating}
          onOpenChange={(open) => setParams({ new: open ? "1" : null })}
          onCreated={reload}
        />
      )}
      {canCreateOwn && <CreateMyServer open={creating} onOpenChange={(open) => setParams({ new: open ? "1" : null })} onCreated={reload} />}
    </>
  );
}

function CreateServer({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const templates = useLoad<Template[]>(open ? "/templates" : null);
  const customers = useLoad<Row[]>(open ? "/customers?limit=100" : null);
  const nodes = useLoad<Node[]>(open ? "/nodes" : null);
  const [resources, setResources] = useState({ memoryGb: 2, cores: 1, diskGb: 10 });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [created, setCreated] = useState<Row | null>(null),
    [overLimit, setOverLimit] = useState("");
  const payload = useRef<Record<string, unknown> | null>(null);
  const loading = templates.loading || customers.loading || nodes.loading;
  const loadError = [templates.error, customers.error, nodes.error].filter(Boolean).join(" · ");
  const usable = items(nodes.data).filter((n) => n.status === "connected" && !n.draining);
  const customerList = items(customers.data).filter((c) => !c.disabled);

  async function send(force: boolean) {
    if (!payload.current) return;
    setBusy(true);
    setError("");
    setOverLimit("");
    try {
      const result = (await json("POST", "/servers", force ? { ...payload.current, force: true } : payload.current)) as Row;
      setCreated(result);
      onCreated();
    } catch (ex) {
      // A customer's plan limit can be exceeded on purpose by an administrator.
      if (ex instanceof ApiError && ex.status === 409 && ex.message.includes("limit of")) setOverLimit(ex.message);
      else setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    payload.current = {
      name: v.name,
      ownerId: v.ownerId,
      templateId: v.templateId,
      location: v.location || undefined,
      nodeId: v.nodeId || undefined,
      memoryMb: Math.round(Number(v.memoryGb) * 1024),
      cpuPercent: Math.round(Number(v.cores) * 100),
      diskMb: Math.round(Number(v.diskGb) * 1024),
      port: v.port ? Number(v.port) : undefined,
    };
    await send(false);
  }

  const createdId = created?.id;
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setCreated(null);
          setError("");
          setOverLimit("");
        }
      }}
      title="New server"
    >
      {created ? (
        <>
          <Notice tone="ok" title="Provisioning started">
            {created.placement?.selected
              ? `Placed on ${items(nodes.data).find((n) => n.id === created.placement.selected)?.name || "a node"}. `
              : ""}
            The server appears as provisioning until its node finishes setting it up.
          </Notice>
          <div className="form__actions">
            {createdId ? (
              <Link href={`/servers/${createdId}`} className={btn("primary")}>
                Open server
              </Link>
            ) : null}
            <Button onClick={() => setCreated(null)}>Create another</Button>
          </div>
        </>
      ) : loading ? (
        <Skeleton rows={6} />
      ) : loadError ? (
        <ErrorNotice message={loadError} />
      ) : (
        <form className="form" onSubmit={submit}>
          <div className="form-group">
            <label className="field">
              <span className="field__label">Name</span>
              <input className="input" name="name" required maxLength={100} placeholder="Survival world" autoFocus />
            </label>
            <label className="field">
              <span className="field__label">Owner</span>
              <select className="input select" name="ownerId" required defaultValue="">
                <option value="" disabled>
                  {customerList.length ? "Choose a customer" : "No customers — create one first"}
                </option>
                {customerList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Template</span>
              <select
                className="input select"
                name="templateId"
                required
                defaultValue=""
                onChange={(e) => {
                  const t = items(templates.data).find((x) => x.id === e.target.value);
                  if (t) setResources({ memoryGb: t.memoryMb / 1024, cores: t.cpuPercent / 100, diskGb: t.diskMb / 1024 });
                }}
              >
                <option value="" disabled>
                  Choose a game
                </option>
                {items(templates.data).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-group">
            <div className="form-grid">
              <label className="field">
                <span className="field__label">Node</span>
                <select className="input select" name="nodeId" defaultValue="">
                  <option value="">Automatic</option>
                  {usable.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} · {n.location}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field__label">Location</span>
                <input className="input" name="location" placeholder="Any" />
              </label>
            </div>
            {!usable.length ? (
              <Notice tone="warn">No node is online and accepting servers right now.</Notice>
            ) : null}
          </div>
          <div className="form-group">
            <div className="form-grid">
              <UnitField label="Memory" name="memoryGb" unit="GB" step={0.5} value={resources.memoryGb} onChange={(n) => setResources((r) => ({ ...r, memoryGb: n }))} />
              <UnitField label="CPU" name="cores" unit="cores" step={0.25} value={resources.cores} onChange={(n) => setResources((r) => ({ ...r, cores: n }))} />
              <UnitField label="Disk" name="diskGb" unit="GB" step={1} value={resources.diskGb} onChange={(n) => setResources((r) => ({ ...r, diskGb: n }))} />
              <label className="field">
                <span className="field__label">Port</span>
                <input className="input" name="port" type="number" min={1024} max={65535} placeholder="Automatic" />
              </label>
            </div>
          </div>
          <ErrorNotice message={error} />
          {overLimit ? (
            <Notice
              tone="warn"
              title="This is over the customer’s limit"
              action={
                <Button size="sm" busy={busy} onClick={() => void send(true)}>
                  Create anyway
                </Button>
              }
            >
              {overLimit}
            </Notice>
          ) : null}
          <div className="form__actions">
            <Button type="submit" variant="primary" busy={busy}>
              Create server
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
