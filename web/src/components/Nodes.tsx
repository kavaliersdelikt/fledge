"use client";
import {
fmtDate,
items,
json,
request,
type Node
} from "@/lib/api";
import {
HardDrive,
Plus
} from "lucide-react";
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
import { Progress } from "@/components/ui/progress";
import { Card } from "@/components/ui/card";
import NodeConnector from "./NodeConnector";
import { Notice } from "./shared";
import {
Badge,
Button,
Confirm,
Empty,
Field,
Form,
Heading,
Row,
Section,
State,
useLoad
} from "./shared";
export default function Nodes() {
  const [filter, setFilter] = useState(""),
    [register, setRegister] = useState(false),
    [enroll, setEnroll] = useState(false);
  const { data, error, loading, reload } = useLoad<Node[]>("/nodes", 12000);
  const [token, setToken] = useState<Row | null>(null);
  return (
    <>
      <Heading
        eyebrow="Workspace / Nodes"
        title="Nodes"
        subtitle="The hosts behind your worlds. Monitor capacity and connect new infrastructure."
        action={
          <div className="actions">
            <Button onClick={() => setEnroll(true)}>Connect agent</Button>
            <Button className="primary" onClick={() => setRegister(true)}>
              <Plus size={16} />
              Register node
            </Button>
          </div>
        }
      />
      <Sheet
        open={enroll}
        onOpenChange={setEnroll}
      >
        <SheetContent className="form-sheet" side="right">
          <SheetHeader><SheetTitle>Connect an agent</SheetTitle><SheetDescription>Enroll a registered host into your infrastructure.</SheetDescription></SheetHeader>
          <NodeConnector />
        </SheetContent>
      </Sheet>
      <Sheet
        open={register}
        onOpenChange={setRegister}
      >
        <SheetContent className="form-sheet" side="right">
          <SheetHeader><SheetTitle>Register a node</SheetTitle><SheetDescription>Set host capacity, then connect its agent.</SheetDescription></SheetHeader>
        <Form
          submit="Register node"
          onSubmit={async (v) => {
            await json("POST", "/nodes", {
              name: v.name,
              location: v.location,
              memoryMb: Number(v.memoryMb),
              cpuPercent: Number(v.cpuPercent),
              diskMb: Number(v.diskMb),
              headroomMb: Number(v.headroomMb),
            });
            reload();
            setRegister(false);
            setEnroll(true);
          }}
        >
          <div className="form-grid">
            <Field label="Name" name="name" required />
            <Field label="Location / pool" name="location" required />
            <Field
              label="RAM (MB)"
              name="memoryMb"
              type="number"
              min={1}
              required
            />
            <Field
              label="CPU budget (%)"
              name="cpuPercent"
              type="number"
              min={1}
              required
            />
            <Field
              label="Disk (MB)"
              name="diskMb"
              type="number"
              min={1}
              required
            />
            <Field
              label="RAM reserve (MB)"
              name="headroomMb"
              type="number"
              min={0}
              defaultValue={512}
              required
            />
          </div>
        </Form>
        </SheetContent>
      </Sheet>
      {token && (
        <Notice status="warning" className="token-notice" title={`Token for ${token.nodeId} · copy now; shown once`}>
          <code>{token.token}</code>
          <span>
            Valid for {token.expiresInSeconds} seconds. Transfer securely to the
            target node.
          </span>
          <Button onClick={() => setToken(null)}>Close</Button>
        </Notice>
      )}
      <div className="summary-strip" aria-label="Node totals">
        <div><span>Registered hosts</span><strong>{items(data).length}</strong></div>
        <div><span>Connected</span><strong>{items(data).filter((node) => node.status === "connected").length}</strong></div>
        <div><span>Placement paused</span><strong>{items(data).filter((node) => node.draining).length}</strong></div>
      </div>
      <Section
        title="Registered nodes"
        action={
          <input
            className="search"
            aria-label="Filter nodes"
            placeholder="Search nodes or locations…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        }
      >
        <State loading={loading} error={error}>
          {!items(data).length ? (
            <Empty>No nodes found.</Empty>
          ) : (
            <div className="card-grid">
              {items(data)
                .filter((n) =>
                  `${n.name} ${n.location} ${n.status}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )
                .map((n) => (
                  <Card role="article" className="node-card" key={n.id}>
                    <div className="node-head">
                      <div className="node-icon">
                        <HardDrive size={20} />
                      </div>
                      <Badge value={n.draining ? "draining" : n.status} />
                    </div>
                    <h3>{n.name}</h3>
                    <p className="muted">
                      {n.location} · Last seen: {fmtDate(n.lastSeenAt)}
                    </p>
                    <div className="node-metrics">
                      {([
                        { label: "Memory reserved", used: n.reserved.memoryMb, total: n.capacity.memoryMb, suffix: "MB" },
                        { label: "CPU reserved", used: n.reserved.cpuPercent, total: n.capacity.cpuPercent, suffix: "%" },
                        { label: "Disk reserved", used: n.reserved.diskMb, total: n.capacity.diskMb, suffix: "MB" },
                      ]).map((metric) => {
                        const percent = metric.total > 0 ? Math.min(100, Math.round(metric.used / metric.total * 100)) : 0;
                        return <div className="node-metric" key={metric.label}>
                          <div><span>{metric.label}</span><strong>{metric.used.toLocaleString()} / {metric.total.toLocaleString()} {metric.suffix}</strong></div>
                          <Progress value={percent} max={100} aria-label={`${metric.label}: ${percent}%`} />
                        </div>;
                      })}
                    </div>
                    <p className="muted small">
                      Agent: {n.version || "Version not reported"} · Reserved
                      headroom: {n.headroomMb} MB
                    </p>
                    <details className="node-edit">
                      <summary>Edit node</summary>
                      <Form
                        submit="Save changes"
                        onSubmit={async (v) => {
                          await json("PATCH", `/nodes/${n.id}`, {
                            name: v.name,
                            location: v.location,
                            headroomMb: Number(v.headroomMb),
                          });
                          reload();
                        }}
                      >
                        <Field
                          label="Name"
                          name="name"
                          defaultValue={n.name}
                          required
                        />
                        <Field
                          label="Location"
                          name="location"
                          defaultValue={n.location}
                          required
                        />
                        <Field
                          label="RAM reserve (MB)"
                          name="headroomMb"
                          type="number"
                          min={0}
                          defaultValue={n.headroomMb}
                          required
                        />
                      </Form>
                    </details>
                    <div className="card-actions">
                      <Confirm
                        danger={false}
                        text="Create a new token? Existing agent credentials will be revoked immediately."
                        onConfirm={async () => {
                          setToken(
                            (await json(
                              "POST",
                              `/nodes/${n.id}/enrollment`,
                            )) as Row,
                          );
                          reload();
                        }}
                      >
                        Generate token
                      </Confirm>
                      <Confirm
                        danger={false}
                        text={`${n.name} for new placements ${n.draining ? "allow" : "block"}?`}
                        onConfirm={async () => {
                          await json("PATCH", `/nodes/${n.id}`, {
                            draining: !n.draining,
                          });
                          reload();
                        }}
                      >
                        {n.draining ? "Allow placement" : "Block placement"}
                      </Confirm>
                      <Confirm
                        text={`Remove node ${n.name}? Only nodes without assigned servers can be removed.`}
                        onConfirm={async () => {
                          await request(`/nodes/${n.id}`, { method: "DELETE" });
                          reload();
                        }}
                      >
                        Remove
                      </Confirm>
                    </div>
                  </Card>
                ))}
            </div>
          )}
        </State>
      </Section>
    </>
  );
}
