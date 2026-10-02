"use client";
import { items, json, request, type AgentReleases, type Node, type Server } from "@/lib/api";
import { fmtAgo, fmtCpu, fmtCpuPair, fmtMb, fmtMbPair, fmtTime } from "@/lib/format";
import { ArrowUpCircle, MoreHorizontal, Pause, Pencil, Play, Plug, Plus, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import NodeConnector from "./NodeConnector";
import { StackedBar } from "./charts";
import { useToast } from "./toast";
import { Drawer, useConfirm } from "./feedback";
import {
  Button,
  Empty,
  ErrorNotice,
  Field,
  Form,
  Meter,
  PageHeader,
  SearchInput,
  Skeleton,
  Status,
  Toolbar,
  UnitField,
  btn,
  useLoad,
} from "./shared";

export default function Nodes() {
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(""),
    [registering, setRegistering] = useState(false),
    [editing, setEditing] = useState<Node | null>(null);
  const connecting = params.get("connect");
  const setConnecting = (nodeId: string | null) =>
    router.replace(nodeId ? `${pathname}?connect=${nodeId}` : pathname, { scroll: false });
  const { data, error, loading, reload } = useLoad<Node[]>("/nodes", 12000);
  const { data: servers } = useLoad<Server[]>("/servers?limit=100&offset=0", 30000);
  const { data: releases, reload: reloadReleases } = useLoad<AgentReleases>("/agent-releases", 20000);
  const release = (id: string) => releases?.nodes.find((r) => r.id === id);
  const outdated = releases?.nodes.filter((r) => r.available && !r.blocker && !r.pending).length || 0;
  const all = items(data);
  const list = all.filter((n) => `${n.name} ${n.location}`.toLowerCase().includes(query.toLowerCase()));

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast({ tone: "ok", title: done });
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  }

  return (
    <>
      <PageHeader
        title="Nodes"
        actions={
          <>
            {outdated > 0 ? (
              <Button
                onClick={() =>
                  void act(async () => {
                    await json("POST", "/nodes/agent-update");
                    reloadReleases();
                  }, `Updating ${outdated} ${outdated === 1 ? "agent" : "agents"} to ${releases?.latest}`)
                }
              >
                <ArrowUpCircle /> Update {outdated} {outdated === 1 ? "agent" : "agents"}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setRegistering(true)}>
              <Plus /> Add node
            </Button>
          </>
        }
      />
      {all.length > 6 && (
        <Toolbar>
          <span />
          <SearchInput label="Search nodes" placeholder="Search nodes" value={query} onChange={setQuery} />
        </Toolbar>
      )}
      {loading ? (
        <Skeleton rows={4} />
      ) : error ? (
        <ErrorNotice message={error} />
      ) : !all.length ? (
        <div className="card">
          <Empty
            title="No nodes yet"
            action={
              <Button variant="primary" size="sm" onClick={() => setRegistering(true)}>
                Add your first node
              </Button>
            }
          >
            A node is a Linux host with Docker. Add it here, then run the connector on it.
          </Empty>
        </div>
      ) : (
        <div className="node-grid">
          {list.map((n, index) => {
            const online = n.status === "connected";
            const waiting = !online && !n.lastSeenAt;
            const hosted = items(servers).filter((s) => s.nodeId === n.id);
            return (
              <article className="node" key={n.id} style={{ ["--i" as string]: index }}>
                <div className="node__head">
                  <div className="node__title">
                    <h2>{n.name}</h2>
                    <p>{n.location}</p>
                  </div>
                  <div className="btn-group">
                    {waiting ? (
                      <Status value="waiting" tone="neutral" label="Waiting for agent" />
                    ) : (
                      <Status value={online && n.draining ? "draining" : n.status} />
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger className={btn("ghost", "icon", "btn--sm")} aria-label={`Actions for ${n.name}`}>
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="menu">
                        <DropdownMenuItem onClick={() => setConnecting(n.id)}>
                          <Plug /> Connect agent
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditing(n)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={async () => {
                            if (
                              await confirm(
                                n.draining
                                  ? `New servers can be placed on ${n.name} again.`
                                  : `No new servers are placed on ${n.name}. Existing servers keep running.`,
                                { danger: false, confirmLabel: n.draining ? "Resume placement" : "Pause placement" },
                              )
                            )
                              void act(
                                () => json("PATCH", `/nodes/${n.id}`, { draining: !n.draining }),
                                n.draining ? "Placement resumed" : "Placement paused",
                              );
                          }}
                        >
                          {n.draining ? <Play /> : <Pause />} {n.draining ? "Resume placement" : "Pause placement"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="is-danger"
                          onClick={async () => {
                            if (
                              await confirm(`Only nodes without servers can be removed. Its agent stops working.`, {
                                title: `Remove ${n.name}?`,
                                confirmLabel: "Remove node",
                              })
                            )
                              void act(() => request(`/nodes/${n.id}`, { method: "DELETE" }), `${n.name} removed`);
                          }}
                        >
                          <Trash2 /> Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                {hosted.length ? (
                  <div className="node__metrics">
                    <div className="metric">
                      <header>
                        <span>
                          Memory <strong>{fmtMbPair(n.reserved.memoryMb, n.capacity.memoryMb)}</strong>
                        </span>
                        <span>
                          {hosted.length} {hosted.length === 1 ? "server" : "servers"}
                        </span>
                      </header>
                      <StackedBar
                        total={n.capacity.memoryMb}
                        label={`Memory reserved on ${n.name}`}
                        segments={hosted.map((s) => ({
                          key: s.id,
                          value: s.memoryMb,
                          label: s.name,
                          detail: fmtMb(s.memoryMb),
                        }))}
                      />
                    </div>
                    <div className="metric">
                      <header>
                        <span>
                          CPU <strong>{fmtCpuPair(n.reserved.cpuPercent, n.capacity.cpuPercent)}</strong>
                        </span>
                      </header>
                      <Meter value={n.reserved.cpuPercent} max={n.capacity.cpuPercent} label={`CPU reserved on ${n.name}`} />
                    </div>
                    <div className="metric">
                      <header>
                        <span>
                          Disk <strong>{fmtMbPair(n.reserved.diskMb, n.capacity.diskMb)}</strong>
                        </span>
                      </header>
                      <Meter value={n.reserved.diskMb} max={n.capacity.diskMb} label={`Disk reserved on ${n.name}`} />
                    </div>
                  </div>
                ) : (
                  <p className="node__empty">
                    No servers · {fmtMb(n.capacity.memoryMb)}, {fmtCpu(n.capacity.cpuPercent)}, {fmtMb(n.capacity.diskMb)} disk
                  </p>
                )}
                {online && n.agent?.quota ? (
                  <p className="node__note" title={n.agent.quota.reason}>
                    {n.agent.quota.enforced ? "Disk limits enforced by the kernel" : `Disk limits are not enforced${n.agent.quota.reason ? ` — ${n.agent.quota.reason}` : ""}`}
                  </p>
                ) : null}
                <div className="node__foot">
                  {waiting ? (
                    <Button size="sm" onClick={() => setConnecting(n.id)}>
                      <Plug /> Connect agent
                    </Button>
                  ) : (
                    <span title={n.lastSeenAt ? fmtTime(n.lastSeenAt) : undefined}>
                      Agent {n.version || "unknown"} · seen {fmtAgo(n.lastSeenAt)}
                    </span>
                  )}
                  {(() => {
                    const r = release(n.id);
                    if (!r?.available) return null;
                    if (r.pending) return <Status value="busy" tone="busy" label={`Updating to ${releases?.latest}`} />;
                    return (
                      <Button
                        size="sm"
                        disabled={!!r.blocker}
                        title={r.blocker || undefined}
                        onClick={() =>
                          void act(async () => {
                            await json("POST", `/nodes/${n.id}/agent-update`);
                            reloadReleases();
                          }, `Updating ${n.name} to ${releases?.latest}`)
                        }
                      >
                        <ArrowUpCircle /> Update to {releases?.latest}
                      </Button>
                    );
                  })()}
                </div>
              </article>
            );
          })}
          {!list.length && <Empty title="No matching nodes" />}
        </div>
      )}

      <Drawer open={registering} onOpenChange={setRegistering} title="Add node">
        <Form
          submit="Add and connect"
          success={false}
          onSubmit={async (v) => {
            const node = (await json("POST", "/nodes", {
              name: v.name,
              location: v.location,
              memoryMb: Math.round(Number(v.memoryGb) * 1024),
              cpuPercent: Math.round(Number(v.cores) * 100),
              diskMb: Math.round(Number(v.diskGb) * 1024),
              headroomMb: Math.round(Number(v.headroomGb) * 1024),
            })) as { id?: string };
            reload();
            setRegistering(false);
            setConnecting(node?.id || "");
          }}
        >
          <div className="form-grid">
            <Field label="Name" name="name" required placeholder="fra-01" />
            <Field label="Location" name="location" required placeholder="Frankfurt" />
          </div>
          <div className="form-grid">
            <UnitField label="Memory for servers" name="memoryGb" unit="GB" step={1} />
            <UnitField label="CPU for servers" name="cores" unit="cores" step={0.5} />
            <UnitField label="Disk for servers" name="diskGb" unit="GB" step={1} />
            <UnitField label="Kept free for the host" name="headroomGb" unit="GB" step={0.5} min={0} defaultValue={0.5} />
          </div>
        </Form>
      </Drawer>

      <Drawer open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={editing ? `Edit ${editing.name}` : "Edit node"}>
        {editing && (
          <Form
            submit="Save"
            onSubmit={async (v) => {
              await json("PATCH", `/nodes/${editing.id}`, {
                name: v.name,
                location: v.location,
                headroomMb: Math.round(Number(v.headroomGb) * 1024),
                publicHost: String(v.publicHost || "").trim() || null,
              });
              reload();
            }}
          >
            <Field label="Name" name="name" defaultValue={editing.name} required />
            <Field label="Location" name="location" defaultValue={editing.location} required />
            <UnitField label="Kept free for the host" name="headroomGb" unit="GB" step={0.5} min={0} defaultValue={editing.headroomMb / 1024} />
            <Field
              label="Public address"
              name="publicHost"
              defaultValue={editing.publicHost || ""}
              placeholder="play.example.com"
              hint="Shown to players next to SFTP credentials. Leave empty to show the panel’s address."
            />
          </Form>
        )}
      </Drawer>

      <Drawer open={connecting !== null} onOpenChange={(o) => !o && setConnecting(null)} title="Connect an agent" wide>
        <NodeConnector initialNodeId={connecting || undefined} onIssued={reload} />
      </Drawer>
    </>
  );
}
