"use client";
import { json, request, type ServerPorts } from "@/lib/api";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { CopyButton, Modal, useConfirm } from "./feedback";
import { Button, Card, ErrorNotice, Notice } from "./shared";
import { useToast } from "./toast";

type Mapping = ServerPorts["mappings"][number];

const addressOf = (ports: ServerPorts, m: Mapping) => (ports.publicHost ? `${ports.publicHost}:${m.hostPort}` : String(m.hostPort));

/** "Connect" line for the top of the server page: the first mapping, with a copy button. */
export function ConnectLine({ ports, fallbackPort }: { ports: ServerPorts | null; fallbackPort: number }) {
  const first = ports?.mappings[0];
  const value = ports && first ? addressOf(ports, first) : String(fallbackPort);
  return (
    <span className="connect">
      <span className="connect__label">{ports?.publicHost ? "Connect" : "Port"}</span>
      <code className="num">{value}</code>
      <CopyButton value={value} size="icon" label={`Copy ${value}`} />
    </span>
  );
}

export function NetworkCard({
  id,
  ports,
  canManage,
  admin,
  reload,
  onRestart,
}: {
  id: string;
  ports: ServerPorts;
  canManage: boolean;
  admin: boolean;
  reload: () => void;
  onRestart: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false),
    [restart, setRestart] = useState(false);

  async function remove(m: Mapping) {
    if (!(await confirm(`${m.protocol.toUpperCase()} port ${m.hostPort} stops forwarding to ${m.container}. Restart the server to apply it.`, { title: `Remove port ${m.hostPort}?`, confirmLabel: "Remove" }))) return;
    try {
      await request(`/servers/${id}/ports/${m.offset}`, { method: "DELETE" });
      toast({ tone: "ok", title: "Port removed", description: "Restart the server to apply it." });
      setRestart(true);
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "Couldn’t remove the port", description: (e as Error).message });
    }
  }

  const columns: DataColumn<Mapping>[] = [
    {
      id: "address",
      header: "Address",
      value: (m) => m.hostPort,
      render: (m) => (
        <span className="connect">
          <code className="num">{addressOf(ports, m)}</code>
          <CopyButton value={addressOf(ports, m)} size="icon" label={`Copy ${addressOf(ports, m)}`} />
        </span>
      ),
    },
    { id: "protocol", header: "Protocol", value: (m) => m.protocol, render: (m) => <span className="tag">{m.protocol.toUpperCase()}</span> },
    {
      id: "container",
      header: "Container port",
      optional: true,
      value: (m) => m.container,
      render: (m) => <span className="mono small muted">{m.container}</span>,
    },
    {
      id: "label",
      header: "Used for",
      optional: true,
      value: (m) => m.label || (m.source === "template" ? "Game" : ""),
      render: (m) => <span className="muted small">{m.label || (m.source === "template" ? "Game" : "Extra port")}</span>,
    },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (m) =>
        m.removable && canManage ? (
          <Button size="sm" variant="ghost" aria-label={`Remove port ${m.hostPort}`} onClick={() => void remove(m)}>
            <Trash2 /> Remove
          </Button>
        ) : null,
    },
  ];

  const limit = ports.quota.limit;
  const hint =
    limit !== null
      ? `${ports.quota.used} of ${limit} extra ports used.`
      : canManage && !admin && !ports.canAdd
        ? "Extra ports are set up by your provider."
        : "";
  return (
    <>
      <Card
        title="Network"
        description={ports.publicHost ? `Players connect through ${ports.publicHost}.` : "Ports this server listens on."}
        actions={
          ports.canAdd ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add port
            </Button>
          ) : undefined
        }
        flush
      >
        {restart && canManage ? (
          <Notice
            tone="warn"
            title="Restart to apply port changes"
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onRestart();
                  setRestart(false);
                }}
              >
                <RotateCw /> Restart
              </Button>
            }
          >
            The new layout takes effect the next time the server starts.
          </Notice>
        ) : null}
        <DataTable data={ports.mappings} columns={columns} rowKey={(m) => `${m.offset}-${m.protocol}`} empty="No ports." />
        {hint ? <p className="node__note">{hint}</p> : null}
      </Card>
      <Modal open={adding} onOpenChange={setAdding} title="Add a port" description="Forward another port to the server, for example for voice chat or a query port.">
        {adding ? (
          <AddPort
            id={id}
            onClose={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              setRestart(true);
              toast({ tone: "ok", title: "Port added", description: "Restart the server to apply it." });
              reload();
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}

function AddPort({ id, onClose, onAdded }: { id: string; onClose: () => void; onAdded: () => void }) {
  const [container, setContainer] = useState(""),
    [protocol, setProtocol] = useState<"tcp" | "udp">("tcp"),
    [label, setLabel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const n = Number(container);
  const valid = Number.isInteger(n) && n >= 1 && n <= 65535;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      await json("POST", `/servers/${id}/ports`, { container: n, protocol, ...(label.trim() ? { label: label.trim() } : {}) });
      onAdded();
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="form-grid">
        <label className="field">
          <span className="field__label">Port inside the server</span>
          <input className="input" inputMode="numeric" autoFocus value={container} aria-invalid={!!container && !valid} placeholder="24454" onChange={(e) => setContainer(e.target.value)} />
          <span className="field__hint">1 to 65535. Fledge picks the public port.</span>
        </label>
        <label className="field">
          <span className="field__label">Protocol</span>
          <select className="input select" value={protocol} onChange={(e) => setProtocol(e.target.value as "tcp" | "udp")}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field__label">Label <span className="faint">(optional)</span></span>
        <input className="input" value={label} maxLength={40} placeholder="Voice chat" onChange={(e) => setLabel(e.target.value)} />
      </label>
      <ErrorNotice message={error} />
      <div className="modal__actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!valid}>
          Add port
        </Button>
      </div>
    </form>
  );
}
