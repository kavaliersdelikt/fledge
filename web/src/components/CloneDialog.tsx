"use client";
import { ApiError, items, json, type Node, type Server } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Modal } from "./feedback";
import { Button, ErrorNotice, Notice, Skeleton, useLoad, type Row } from "./shared";
import { useToast } from "./toast";

type Backup = { id: string; state: string };

/** Admin-only: copies a server (and optionally its newest backup) to a new one. */
export default function CloneDialog({ server, open, onClose }: { server: Server; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={`Clone ${server.name}`} description="Creates a new server with the same template, resources, variables and ports. The original isn’t touched." wide>
      {open ? <Body server={server} onClose={onClose} /> : null}
    </Modal>
  );
}

function Body({ server, onClose }: { server: Server; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const backups = useLoad<Backup[]>(`/servers/${server.id}/backups`);
  const storage = useLoad<{ enabled: boolean }>("/storage/status");
  const nodes = useLoad<Node[]>("/nodes");
  const customers = useLoad<Row[]>("/customers?limit=100");
  const [name, setName] = useState(`${server.name} copy`),
    [includeData, setIncludeData] = useState<boolean | null>(null),
    [nodeId, setNodeId] = useState(""),
    [ownerId, setOwnerId] = useState(server.ownerId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [overLimit, setOverLimit] = useState(false);
  const ready = !backups.loading && !storage.loading;
  const hasBackup = Array.isArray(backups.data) && backups.data.some((b) => b.state === "succeeded");
  const storageOn = storage.data?.enabled === true;
  const canCopy = hasBackup && storageOn;
  const copy = canCopy && includeData !== false;
  const hint = !storageOn ? "Copying files needs object storage, which is turned off." : !hasBackup ? "This server has no successful backup yet. Take one first to copy its world." : "";
  const usable = items(nodes.data).filter((n) => n.status === "connected" && !n.draining);
  const owners = items(customers.data).filter((c) => !c.disabled);

  async function clone(force: boolean, e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = (await json("POST", `/servers/${server.id}/clone`, {
        name: name.trim(),
        includeData: copy,
        ...(nodeId ? { nodeId } : {}),
        ...(ownerId && ownerId !== server.ownerId ? { ownerId } : {}),
        ...(force ? { force: true } : {}),
      })) as { id: string };
      toast({ tone: "ok", title: "Clone started", description: "The new server appears as provisioning until its node finishes." });
      onClose();
      router.push(`/servers/${created.id}`);
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 409 && ex.message.includes("limit of")) setOverLimit(true);
      else setOverLimit(false);
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <Skeleton rows={4} />;
  return (
    <form className="form" onSubmit={(e) => void clone(false, e)}>
      <label className="field">
        <span className="field__label">Name</span>
        <input className="input" value={name} maxLength={80} required autoFocus onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <label className="check-line">
          <input type="checkbox" checked={copy} disabled={!canCopy} onChange={(e) => setIncludeData(e.target.checked)} />
          <span>Copy world and files from the newest backup</span>
        </label>
        {hint ? <span className="field__hint">{hint}</span> : <span className="field__hint">Takes the newest successful backup; changes since then aren’t included.</span>}
      </div>
      <div className="form-grid">
        <label className="field">
          <span className="field__label">Node</span>
          <select className="input select" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            <option value="">Automatic</option>
            {usable.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} · {n.location}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Owner</span>
          <select className="input select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {!owners.some((c) => c.id === server.ownerId) ? <option value={server.ownerId}>Same owner</option> : null}
            {owners.map((c) => (
              <option key={c.id} value={c.id}>
                {c.email}
                {c.id === server.ownerId ? " (same owner)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {overLimit ? (
        <Notice
          tone="warn"
          title="This is over the customer’s limit"
          action={
            <Button size="sm" busy={busy} onClick={() => void clone(true)}>
              Clone anyway
            </Button>
          }
        >
          {error}
        </Notice>
      ) : (
        <ErrorNotice message={error} />
      )}
      <div className="modal__actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
          Clone server
        </Button>
      </div>
    </form>
  );
}
