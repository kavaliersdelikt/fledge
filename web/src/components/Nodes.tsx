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

import { Modal } from "./feedback";
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
      <Modal
        open={enroll}
        onOpenChange={setEnroll}
        title="Connect an agent"
        description="Enroll a registered host into your infrastructure."
      >
        <NodeConnector />
      </Modal>
      <Modal
        open={register}
        onOpenChange={setRegister}
        title="Register a node"
        description="Set the host capacity, then connect its agent."
      >
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
      </Modal>
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
                  <article className="node-card" key={n.id}>
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
                      <div>
                        <span>RAM</span>
                        <strong>
                          {n.reserved.memoryMb} / {n.capacity.memoryMb} MB
                        </strong>
                      </div>
                      <div>
                        <span>CPU</span>
                        <strong>
                          {n.reserved.cpuPercent} / {n.capacity.cpuPercent}%
                        </strong>
                      </div>
                      <div>
                        <span>Disk</span>
                        <strong>
                          {n.reserved.diskMb} / {n.capacity.diskMb} MB
                        </strong>
                      </div>
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
                  </article>
                ))}
            </div>
          )}
        </State>
      </Section>
    </>
  );
}
