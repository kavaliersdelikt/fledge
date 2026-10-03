"use client";
import Addons, { addonsLabel } from "@/components/Addons";
import BackupManager from "@/components/BackupManager";
import LiveConsole from "@/components/LiveConsole";
import ServerFiles from "@/components/ServerFiles";
import Automation from "@/components/Automation";
import CloneDialog from "@/components/CloneDialog";
import { ConnectLine, NetworkCard } from "@/components/NetworkCard";
import { StartupCard, StartupVariables } from "@/components/StartupPanel";
import UsageHistory from "@/components/UsageHistory";
import {
  items,
  json,
  request,
  type AddonOverview,
  type Job,
  type Server,
  type ServerPermission,
  type ServerPorts,
  type ServerStartup,
  type TemplateFull,
} from "@/lib/api";
import { fmtAgo, fmtBytes, fmtCpu, fmtMb, fmtTime } from "@/lib/format";
import { ArrowLeft, CircleStop, Copy, MoreHorizontal, Play, Plus, RotateCw, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Sparkline } from "./charts";
import DataTable, { type DataColumn } from "./DataTable";
import { Modal, useConfirm } from "./feedback";
import { Num } from "./motion";
import { useToast } from "./toast";
import { useFeatures } from "@/lib/commerce";
import { PendingDelete } from "./SelfServer";
import { useLiveServer, type Sample } from "./useLiveServer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Button,
  Card,
  CheckChip,
  Empty,
  ErrorNotice,
  Form,
  Meter,
  Notice,
  PageHeader,
  Skeleton,
  State,
  Status,
  Toolbar,
  UnitField,
  btn,
  useLoad,
  type Row,
} from "./shared";

const tabs: Array<{ key: string; label: string; permission: ServerPermission }> = [
  { key: "console", label: "Console", permission: "console" },
  { key: "files", label: "Files", permission: "files" },
  { key: "addons", label: "Add-ons", permission: "files" },
  { key: "backups", label: "Backups", permission: "backups" },
  { key: "schedules", label: "Automation", permission: "manage" },
  { key: "access", label: "Access", permission: "manage" },
  { key: "jobs", label: "Jobs", permission: "view" },
  { key: "settings", label: "Settings", permission: "manage" },
];

const actionCopy: Record<string, [pending: string, done: string]> = {
  start: ["Starting", "Start queued"],
  restart: ["Restarting", "Restart queued"],
  stop: ["Stopping", "Stop queued"],
  kill: ["Force stopping", "Force stop queued"],
  suspend: ["Suspending", "Server suspended"],
  unsuspend: ["Unsuspending", "Server unsuspended"],
  reinstall: ["Reinstalling", "Reinstall queued"],
  restore: ["Restoring", "Restore queued"],
};

/** What the server is doing, from what was requested vs. what the node last saw. */
function transition(s: Server) {
  if (s.status === "unreachable" || !s.desiredStatus || s.desiredStatus === s.observedStatus) return null;
  if (s.desiredStatus === "running" && ["stopped", "provisioning", "starting"].includes(s.observedStatus)) return "Starting";
  if (s.desiredStatus === "stopped" && s.observedStatus === "running") return "Stopping";
  return null;
}

const STALE_MS = 60_000;

export default function ServerDetail({
  id,
  admin,
  actorId,
  tab,
}: {
  id: string;
  admin: boolean;
  actorId: string;
  tab: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const { data: s, error, loading, reload } = useLoad<Server>(`/servers/${id}`, 12000);
  const permissions = new Set<ServerPermission>(s?.effectivePermissions || []);
  const canManage = admin || s?.ownerId === actorId || permissions.has("manage");
  const can = (p: ServerPermission) => p === "view" || canManage || permissions.has(p);
  // Mods/Plugins tab: only for people with file access, and only on servers that support add-ons.
  const addons = useLoad<AddonOverview>(s && can("files") ? `/servers/${id}/addons` : null);
  const addonData = addons.data?.capability.supported ? addons.data : null;
  const ports = useLoad<ServerPorts>(s ? `/servers/${id}/ports` : null);
  const [cloning, setCloning] = useState(false);
  // Quick commands come with the template.
  const templates = useLoad<TemplateFull[]>(s && can("console") ? "/templates" : null);
  const quickCommands = items(templates.data).find((t) => t.id === s?.templateId)?.quickCommands || [];
  const visibleTabs = tabs
    .filter(({ key, permission }) => can(permission) && (key !== "addons" || !!addonData))
    .map((t) => (t.key === "addons" ? { ...t, label: addonsLabel(addonData?.capability.kind) } : t));
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : visibleTabs[0]?.key;
  const reachable = !!s && s.status !== "unreachable";
  const live = useLiveServer(id, reachable && can("console"));
  const [acting, setActing] = useState("");

  // Samples the node reported with its heartbeat also feed the charts.
  const usage = s?.usage;
  const { addSample } = live;
  useEffect(() => {
    if (usage?.sampledAt && typeof usage.cpuPercent === "number" && typeof usage.memoryBytes === "number" && usage.memoryLimitBytes)
      addSample({ t: Date.parse(usage.sampledAt), cpu: usage.cpuPercent, mem: usage.memoryBytes, memLimit: usage.memoryLimitBytes });
  }, [usage?.sampledAt, usage?.cpuPercent, usage?.memoryBytes, usage?.memoryLimitBytes, addSample]);

  async function action(kind: string, extra: Record<string, unknown> = {}) {
    const prompts: Record<string, [string, string]> = {
      kill: ["The process ends immediately without saving. Unsaved world data may be lost.", "Force stop"],
      reinstall: ["Every file on the server is deleted and it’s set up from its template again.", "Reinstall"],
      restore: ["All files on the server are replaced with the backup.", "Restore"],
      suspend: ["The server stops and its owner can’t start it until you unsuspend it.", "Suspend"],
    };
    if (
      prompts[kind] &&
      !(await confirm(prompts[kind][0], { title: `${prompts[kind][1]} ${s?.name || "this server"}?`, confirmLabel: prompts[kind][1] }))
    )
      return;
    setActing(kind);
    try {
      await json("POST", `/servers/${id}/actions`, {
        action: kind,
        ...extra,
        ...(["restore", "reinstall"].includes(kind) ? { confirm: true } : {}),
      });
      toast({ tone: "ok", title: actionCopy[kind]?.[1] || "Done" });
      reload();
    } catch (e) {
      toast({ tone: "bad", title: `Couldn’t ${kind === "kill" ? "force stop" : kind}`, description: (e as Error).message });
    } finally {
      setActing("");
    }
  }

  if (loading && !s) return <Skeleton rows={6} />;
  if (!s)
    return (
      <Empty
        title="Server unavailable"
        action={
          <Link href="/servers" className={btn("secondary", "sm")}>
            Back to servers
          </Link>
        }
      >
        {error || "This server doesn’t exist or you no longer have access to it."}
      </Empty>
    );

  const blocked = !!acting || !reachable || s.suspended;
  const moving = acting ? actionCopy[acting]?.[0] : transition(s);

  return (
    <>
      <PageHeader
        crumb={
          <Link href="/servers" className="crumb">
            <ArrowLeft /> Servers
          </Link>
        }
        title={
          <>
            {s.name}
            <Status
              pill
              live
              value={moving ? "pending" : s.suspended ? "suspended" : s.status}
              label={moving || undefined}
            />
          </>
        }
        meta={
          <>
            <span>{s.templateId}</span>
            <span className="sep">·</span>
            <span>
              {s.nodeName || "No node"}
              {s.location ? <span className="faint"> {s.location}</span> : null}
            </span>
            <span className="sep">·</span>
            <ConnectLine ports={ports.data} fallbackPort={s.port} />
          </>
        }
        actions={
          canManage ? (
            <div className="joined" role="group" aria-label="Power">
              {s.status === "running" ? (
                <Button disabled={blocked} busy={acting === "stop"} onClick={() => action("stop")}>
                  {acting === "stop" ? null : <Square />}
                  Stop
                </Button>
              ) : (
                <Button className="btn--go" disabled={blocked} busy={acting === "start"} onClick={() => action("start")}>
                  {acting === "start" ? null : <Play />}
                  Start
                </Button>
              )}
              <Button disabled={blocked} busy={acting === "restart"} onClick={() => action("restart")}>
                {acting === "restart" ? null : <RotateCw />}
                Restart
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger className={btn("ghost", "icon")} aria-label="More power actions" disabled={blocked}>
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="menu">
                  {admin ? (
                    <DropdownMenuItem onClick={() => setCloning(true)}>
                      <Copy /> Clone…
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem className="is-danger" onClick={() => action("kill")}>
                    <CircleStop /> Force stop
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : undefined
        }
      />

      {s.status === "unreachable" && (
        <Notice tone="warn" title={`${s.nodeName || "The node"} is offline`}>
          Last reported as {s.observedStatus}. The server may still be running; power actions are paused until the node reconnects.
        </Notice>
      )}
      {s.pendingDeleteAt ? <PendingDelete server={{ id: s.id, name: s.name, pendingDeleteAt: s.pendingDeleteAt }} onChange={reload} /> : null}
      {s.suspended && !s.pendingDeleteAt && (
        <Notice
          tone="warn"
          title={s.suspendedReason === "billing" ? "Suspended: a payment is overdue" : "Suspended"}
          action={!admin && s.suspendedReason === "billing" ? <Link className={btn("primary", "sm")} href="/billing">Open billing</Link> : undefined}
        >
          {admin
            ? s.suspendedReason === "billing"
              ? "Held because the subscription is unpaid or ended. It starts again by itself when a payment arrives, or open the subscription in Billing."
              : "The owner can’t start this server until you unsuspend it in Settings."
            : s.suspendedReason === "billing"
              ? "Your files are safe. Pay the open invoice and the server starts again by itself."
              : "An administrator suspended this server."}
        </Notice>
      )}

      <Vitals server={s} samples={live.samples} />
      <UsageHistory server={s} samples={live.samples} />

      {activeTab ? (
        <Tabs
          value={activeTab}
          onValueChange={(value: string) => router.replace(`/servers/${id}?tab=${value}`, { scroll: false })}
        >
          <TabsList aria-label="Server sections">
            {visibleTabs.map(({ key, label }) => (
              <TabsTrigger key={key} value={key}>
                {label}
              </TabsTrigger>
            ))}
            <TabsIndicator />
          </TabsList>
          <TabsContent value={activeTab} key={activeTab}>
            {activeTab === "console" ? (
              <LiveConsole id={id} live={live} minecraft={!!s.supportsRcon} reachable={reachable} quickCommands={quickCommands} canManage={canManage} />
            ) : activeTab === "files" ? (
              <ServerFiles id={id} />
            ) : activeTab === "addons" && addonData ? (
              <Addons id={id} admin={admin} canManage={canManage} initial={addonData} />
            ) : activeTab === "backups" ? (
              <BackupManager id={id} canManage={canManage} canRestore={canManage} />
            ) : activeTab === "schedules" ? (
              <Automation id={id} />
            ) : activeTab === "access" ? (
              <Access id={id} />
            ) : activeTab === "jobs" ? (
              <Jobs id={id} />
            ) : (
              <ServerSettings id={id} server={s} admin={admin} owner={s.ownerId === actorId} reload={reload} action={action} ports={ports.data} reloadPorts={ports.reload} />
            )}
          </TabsContent>
        </Tabs>
      ) : null}
      {admin ? <CloneDialog server={s} open={cloning} onClose={() => setCloning(false)} /> : null}
    </>
  );
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 2 : 1)}`;

/** Live CPU and memory from the node's samples, plus disk use. */
function Vitals({ server: s, samples }: { server: Server; samples: Sample[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const last = samples[samples.length - 1];
  const fresh = !!last && s.status === "running" && now - last.t < STALE_MS;
  const recent = fresh ? samples.filter((p) => now - p.t < 5 * 60_000) : [];
  const quiet = s.status === "unreachable" ? "Node unreachable" : s.status !== "running" ? "Not running" : "No recent samples";
  const cpuShare = fresh ? (last.cpu / Math.max(1, s.cpuPercent)) * 100 : 0;
  const memLimit = fresh ? last.memLimit : s.memoryMb * 1024 * 1024;
  const diskUsed = s.usage?.diskBytes;
  const diskLimit = s.diskMb * 1024 * 1024;
  return (
    <section className="vitals" aria-label="Resources">
      <div className="vital">
        <div className="vital__head">CPU</div>
        <div className="vital__value">
          {fresh ? <Num value={cpuShare} format={(n) => `${Math.round(n)}%`} /> : <span className="faint">—</span>}
          <small>of {fmtCpu(s.cpuPercent)}</small>
        </div>
        <div className="vital__chart">
          <Sparkline
            points={recent.map((p) => ({ t: p.t, v: p.cpu }))}
            max={s.cpuPercent}
            label="CPU"
            empty={fresh ? "" : quiet}
            format={(v) => `${Math.round((v / Math.max(1, s.cpuPercent)) * 100)}%`}
          />
        </div>
      </div>
      <div className="vital">
        <div className="vital__head">Memory</div>
        <div className="vital__value">
          {fresh ? <Num value={last.mem} format={(n) => `${gb(n)} GB`} /> : <span className="faint">—</span>}
          <small>of {fmtBytes(memLimit)}</small>
        </div>
        <div className="vital__chart">
          <Sparkline
            points={recent.map((p) => ({ t: p.t, v: p.mem }))}
            max={memLimit}
            label="Memory"
            empty={fresh ? "" : quiet}
            format={(v) => `${gb(v)} GB`}
          />
        </div>
      </div>
      <div className="vital">
        <div className="vital__head">Disk</div>
        <div className="vital__value">
          {diskUsed !== undefined ? <DiskValue bytes={Number(diskUsed)} /> : <span className="faint">—</span>}
          <small>
            of {fmtMb(s.diskMb)}
            {s.usage?.diskEnforced === true ? " · hard limit" : ""}
          </small>
        </div>
        <div className="vital__meter">
          {diskUsed !== undefined ? <Meter value={diskUsed} max={diskLimit} label="Disk used" /> : null}
        </div>
      </div>
    </section>
  );
}

/** Animated disk use that keeps one unit while it rolls. */
function DiskValue({ bytes }: { bytes: number }) {
  const [div, unit] = bytes >= 1024 ** 3 ? [1024 ** 3, "GB"] : bytes >= 1024 ** 2 ? [1024 ** 2, "MB"] : [1024, "KB"];
  return <Num value={bytes / div} format={(n) => `${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")} ${unit}`} />;
}

type JobGroup = Job & { count: number };

/** Collapses runs of identical jobs (e.g. repeated file listings) into one row. */
function groupJobs(list: Job[]) {
  const out: JobGroup[] = [];
  for (const j of list) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === j.kind && prev.state === j.state && !prev.error && !j.error) prev.count++;
    else out.push({ ...j, count: 1 });
  }
  return out;
}

function Jobs({ id }: { id: string }) {
  const { data, error, loading } = useLoad<Job[]>(`/jobs?serverId=${id}&limit=50`, 8000);
  const columns: DataColumn<JobGroup>[] = [
    {
      id: "kind",
      header: "Job",
      value: (j) => j.kind,
      render: (j) => (
        <div className="cell-main">
          <strong className="mono" style={{ fontWeight: 400 }}>
            {j.kind}
            {j.count > 1 ? <span className="faint"> ×{j.count}</span> : null}
          </strong>
          {j.error ? <small style={{ color: "var(--bad)" }}>{j.error}</small> : null}
        </div>
      ),
    },
    { id: "state", header: "State", value: (j) => j.state, render: (j) => <Status value={j.state} tone={j.state === "running" ? "busy" : undefined} /> },
    {
      id: "created",
      header: "When",
      align: "end",
      value: (j) => j.createdAt,
      render: (j) => (
        <time className="muted num" dateTime={j.createdAt} title={fmtTime(j.createdAt)}>
          {fmtAgo(j.createdAt)}
        </time>
      ),
    },
  ];
  return (
    <Card flush>
      <State loading={loading} error={error}>
        <DataTable data={groupJobs(items(data))} columns={columns} rowKey={(j) => j.id} empty="No jobs have run for this server yet." />
      </State>
    </Card>
  );
}

const permissionLabels: Record<ServerPermission, string> = {
  view: "View",
  console: "Console",
  files: "Files",
  backups: "Backups",
  manage: "Manage",
};

function Access({ id }: { id: string }) {
  const confirm = useConfirm();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Row[]>(`/servers/${id}/collaborators`);
  const [open, setOpen] = useState(false);
  const columns: DataColumn<Row>[] = [
    { id: "email", header: "Person", value: (c) => c.email || "", render: (c) => <strong style={{ fontWeight: 500 }}>{c.email}</strong> },
    {
      id: "permissions",
      header: "Can use",
      value: (c) => (c.permissions || []).join(", "),
      render: (c) => (
        <span className="muted">{(c.permissions || []).map((p: ServerPermission) => permissionLabels[p] || p).join(", ")}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (c) => (
        <Button
          size="sm"
          variant="ghost"
          className="row-hover"
          onClick={async () => {
            if (!(await confirm("They lose access to this server immediately.", { title: `Remove ${c.email}?`, confirmLabel: "Remove" }))) return;
            try {
              await request(`/servers/${id}/collaborators/${c.userId}`, { method: "DELETE" });
              toast({ tone: "ok", title: `Removed ${c.email}` });
              reload();
            } catch (e) {
              toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
            }
          }}
        >
          Remove
        </Button>
      ),
    },
  ];
  return (
    <>
      <Toolbar>
        <span />
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          <Plus /> Invite
        </Button>
      </Toolbar>
      <Card flush>
        <State loading={loading} error={error}>
          <DataTable data={items(data)} rowKey={(c) => String(c.userId)} columns={columns} empty="Only the owner and administrators can use this server." />
        </State>
      </Card>
      <Modal open={open} onOpenChange={setOpen} title="Invite to this server" description="They need an existing customer account. No email is sent.">
        <Form
          submit="Invite"
          success="Access granted"
          onSubmit={async (v) => {
            const permissions = (Object.keys(permissionLabels) as ServerPermission[]).filter((p) => v[p]);
            if (!permissions.length) throw new Error("Choose at least one permission.");
            await json("POST", `/servers/${id}/collaborators`, { email: v.email, permissions });
            setOpen(false);
            reload();
          }}
        >
          <label className="field">
            <span className="field__label">Email</span>
            <input className="input" name="email" type="email" required autoFocus />
          </label>
          <div className="field">
            <span className="field__label">Can use</span>
            <div className="checks">
              {(Object.keys(permissionLabels) as ServerPermission[]).map((p) => (
                <CheckChip key={p} name={p} label={permissionLabels[p]} defaultChecked={p === "view"} />
              ))}
            </div>
          </div>
        </Form>
      </Modal>
    </>
  );
}

function ServerSettings({
  id,
  server,
  admin,
  owner,
  reload,
  action,
  ports,
  reloadPorts,
}: {
  id: string;
  server: Server;
  admin: boolean;
  owner: boolean;
  reload: () => void;
  action: (kind: string, extra?: Record<string, unknown>) => Promise<void>;
  ports: ServerPorts | null;
  reloadPorts: () => void;
}) {
  const startup = useLoad<ServerStartup>(`/servers/${id}/startup`);
  return (
    <>
      <Card title="Startup variables" description="Saving recreates the container with its files, so the server restarts.">
        <State loading={startup.loading} error={startup.error}>
          {startup.data ? (
            <StartupVariables
              key={startup.data.env.map((e) => `${e.key}=${e.value}`).join("\n")}
              id={id}
              startup={startup.data}
              onSaved={() => {
                void startup.reload();
                reload();
              }}
            />
          ) : null}
        </State>
      </Card>
      {ports ? <NetworkCard id={id} ports={ports} canManage admin={admin} reload={reloadPorts} onRestart={() => void action("restart")} /> : null}
      {startup.data ? <StartupCard startup={startup.data} admin={admin} /> : null}
      {admin && (
        <>
          <Card title="Resources">
            <Form
              submit="Save"
              onSubmit={async (v) => {
                await json("PATCH", `/servers/${id}`, {
                  name: v.name,
                  memoryMb: Math.round(Number(v.memoryGb) * 1024),
                  cpuPercent: Math.round(Number(v.cores) * 100),
                  diskMb: Math.round(Number(v.diskGb) * 1024),
                });
                reload();
              }}
            >
              <div className="form-grid">
                <label className="field">
                  <span className="field__label">Name</span>
                  <input className="input" name="name" defaultValue={server.name} required />
                </label>
                <UnitField label="Memory" name="memoryGb" unit="GB" step={0.5} defaultValue={server.memoryMb / 1024} />
                <UnitField label="CPU" name="cores" unit="cores" step={0.25} defaultValue={server.cpuPercent / 100} />
                <UnitField label="Disk" name="diskGb" unit="GB" step={1} defaultValue={server.diskMb / 1024} />
              </div>
            </Form>
          </Card>
          <Card title="Danger zone" flush>
            <div className="danger-list">
              <div className="danger-row">
                <div>
                  <strong>{server.suspended ? "Unsuspend" : "Suspend"}</strong>
                  <p>
                    {server.suspended
                      ? "Let the owner start and use this server again."
                      : "Stop the server and prevent its owner from starting it."}
                  </p>
                </div>
                <div>
                  <Button size="sm" onClick={() => action(server.suspended ? "unsuspend" : "suspend")}>
                    {server.suspended ? "Unsuspend" : "Suspend"}
                  </Button>
                </div>
              </div>
              <div className="danger-row">
                <div>
                  <strong>Reinstall</strong>
                  <p>Delete all files and set the server up from its template again.</p>
                </div>
                <div>
                  <Button size="sm" variant="danger" onClick={() => action("reinstall")}>
                    Reinstall
                  </Button>
                </div>
              </div>
              <DeleteServer id={id} name={server.name} />
            </div>
          </Card>
        </>
      )}
      {!admin && owner ? <OwnerZone server={server} /> : null}
    </>
  );
}

/** What a customer may do with their own server: delete it, within what the panel allows. */
function OwnerZone({ server }: { server: Server }) {
  const f = useFeatures();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (server.pendingDeleteAt) return null;
  if (server.subscriptionId)
    return (
      <Card title="This server comes with a subscription">
        <p className="muted">It is removed when the subscription ends. To stop paying, cancel it in <Link href="/billing" className="text-button">Billing</Link>.</p>
      </Card>
    );
  if (!f.selfService.canDelete) return null;
  return (
    <Card title="Danger zone" flush>
      <div className="danger-list">
        <div className="danger-row">
          <div>
            <strong>Delete this server</strong>
            <p>{f.selfService.coolingHours ? `It is stopped now and deleted after ${f.selfService.coolingHours} hours. Until then you can bring it back.` : "Its files are removed right away."}</p>
          </div>
          <div>
            <Button
              size="sm"
              variant="danger"
              busy={busy}
              onClick={async () => {
                if (!(await confirm(`${server.name} and all of its files will be deleted.`, { title: `Delete ${server.name}?`, confirmLabel: "Delete server" }))) return;
                setBusy(true);
                try {
                  const r = (await json("DELETE", `/me/servers/${server.id}`, { confirm: true })) as { deleted: boolean };
                  toast({ tone: "ok", title: r.deleted ? "Server is being deleted" : "Server stopped and scheduled for deletion" });
                  if (r.deleted) window.location.assign("/servers");
                  else window.location.reload();
                } catch (e) {
                  toast({ tone: "bad", title: "Could not delete", description: (e as Error).message });
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function DeleteServer({ id, name }: { id: string; name: string }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function remove() {
    if (
      !(await confirm(`${name} and all of its files are deleted from the node. This can’t be undone.`, {
        title: `Delete ${name}?`,
        confirmLabel: "Delete server",
      }))
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { jobId } = await request<{ jobId: string }>(`/servers/${id}?confirm=true`, { method: "DELETE" });
      setMessage("Waiting for the node to remove the server…");
      for (let attempt = 0; attempt < 25; attempt++) {
        const job = items(await request<Job[]>(`/jobs?serverId=${id}&limit=20`)).find((j) => j.id === jobId);
        if (job?.state === "failed") throw new Error(job.error || "The node couldn’t delete this server.");
        if (job?.state === "succeeded") {
          window.location.assign("/servers");
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      setMessage("Deletion is still queued. The server disappears once its node confirms.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="danger-row">
      <div>
        <strong>Delete</strong>
        <p>{message || "Permanently remove the server and its files from the node."}</p>
      </div>
      <div>
        <Button size="sm" variant="danger" busy={busy} onClick={remove}>
          Delete
        </Button>
        {error ? <span className="inline-error">{error}</span> : null}
      </div>
    </div>
  );
}
