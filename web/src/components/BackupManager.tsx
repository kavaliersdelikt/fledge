"use client";
import { API, json, request } from "@/lib/api";
import { fmtAgo, fmtBytes, fmtTime } from "@/lib/format";
import { Download, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { useConfirm } from "./feedback";
import { Button, Card, ErrorNotice, Notice, Skeleton, Status, Switch, Toolbar, btn } from "./shared";
import { useToast } from "./toast";

type Backup = {
  id: string;
  state: string;
  sizeBytes: number | null;
  error?: string;
  createdAt: string;
};
type Verification = { intervalHours: number; latest?: { state: string; error?: string } };

export default function BackupManager({
  id,
  canManage,
  canRestore,
}: {
  id: string;
  canManage: boolean;
  canRestore: boolean;
}) {
  const confirm = useConfirm();
  const [backups, setBackups] = useState<Backup[] | null>(null),
    [retention, setRetention] = useState<number | null>(null),
    [days, setDays] = useState(0),
    [verification, setVerification] = useState<Verification | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [storage, setStorage] = useState<boolean | null>(null);
  useEffect(() => {
    request<{ enabled: boolean }>("/storage/status").then((r) => setStorage(r.enabled), () => setStorage(null));
  }, []);
  const policyLoaded = useRef(false);

  const reload = useCallback(async () => {
    try {
      const [list, policy, verify] = await Promise.all([
        request<Backup[]>(`/servers/${id}/backups`),
        request<{ retentionDays: number }>(`/servers/${id}/backups/policy`),
        request<Verification>(`/servers/${id}/verification`),
      ]);
      setBackups(list);
      setRetention(policy.retentionDays);
      if (!policyLoaded.current) {
        policyLoaded.current = true;
        setDays(policy.retentionDays);
      }
      setVerification(verify);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setBackups((current) => current ?? []);
    }
  }, [id]);
  useEffect(() => {
    void reload();
    const timer = setInterval(reload, 12000);
    return () => clearInterval(timer);
  }, [reload]);

  const toast = useToast();
  async function run(label: string, task: () => Promise<unknown>, message: string) {
    setBusy(label);
    try {
      await task();
      toast({ tone: "ok", title: message });
      await reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    } finally {
      setBusy("");
    }
  }
  async function savePolicy(e: FormEvent) {
    e.preventDefault();
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      toast({ tone: "bad", title: "Enter a number of days from 0 to 3650" });
      return;
    }
    await run("policy", () => json("PATCH", `/servers/${id}/backups/policy`, { retentionDays: days }), "Retention saved");
  }

  const columns: DataColumn<Backup>[] = [
    {
      id: "created",
      header: "Created",
      value: (b) => b.createdAt,
      render: (b) => (
        <div className="cell-main">
          <span title={fmtTime(b.createdAt)}>{fmtTime(b.createdAt)}</span>
          <small>{fmtAgo(b.createdAt)}</small>
        </div>
      ),
    },
    {
      id: "state",
      header: "Status",
      value: (b) => b.state,
      render: (b) => (
        <div className="cell-main">
          <Status value={b.state} tone={b.state === "running" ? "busy" : undefined} />
          {b.error ? <small style={{ color: "var(--bad)" }}>{b.error}</small> : null}
        </div>
      ),
    },
    {
      id: "size",
      header: "Size",
      align: "end",
      value: (b) => b.sizeBytes || 0,
      render: (b) => <span className="num muted">{fmtBytes(b.sizeBytes)}</span>,
    },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (b) => (
        <span className="row-actions">
          {b.state === "succeeded" && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => run("verify", () => json("POST", `/servers/${id}/backups/${b.id}/verify`), "Restore check queued — see the Jobs tab")}
              >
                Verify
              </Button>
              {canRestore && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={async () => {
                    if (await confirm(`Every file on the server is replaced with the backup from ${fmtTime(b.createdAt)}.`, { confirmLabel: "Restore" }))
                      void run(
                        "restore",
                        () => json("POST", `/servers/${id}/actions`, { action: "restore", backupId: b.id, confirm: true }),
                        "Restore queued",
                      );
                  }}
                >
                  Restore
                </Button>
              )}
              <a
                className={btn("ghost", "icon", "btn--sm")}
                href={`${API}/api/servers/${id}/backups/${b.id}/download`}
                target="_blank"
                rel="noreferrer"
                aria-label={`Download backup from ${fmtTime(b.createdAt)}`}
              >
                <Download />
              </a>
            </>
          )}
          {["succeeded", "failed"].includes(b.state) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              onClick={async () => {
                if (await confirm("The backup is deleted from storage. The most recent successful backup is always kept.", { confirmLabel: "Delete backup" }))
                  void run("delete", () => request(`/servers/${id}/backups/${b.id}`, { method: "DELETE" }), "Backup deleted");
              }}
            >
              Delete
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      {error && <ErrorNotice message={error} />}
      {storage === false ? (
        <Notice tone="warn" title="Backups are off">
          Backups are kept in object storage, which isn’t set up yet. An administrator can turn it on in Settings → Panel → Object storage.
        </Notice>
      ) : null}
      <Toolbar>
        <span />
        <Button
          size="sm"
          variant="primary"
          busy={busy === "create"}
          disabled={storage === false}
          onClick={async () => {
            if (await confirm("The server stops cleanly while its files are archived, then starts again.", { danger: false, confirmLabel: "Back up now" }))
              void run("create", () => json("POST", `/servers/${id}/backups`), "Backup queued");
          }}
        >
          {busy === "create" ? null : <Plus />} Back up now
        </Button>
      </Toolbar>
      <Card flush>
        {backups === null ? (
          <Skeleton rows={3} />
        ) : (
          <DataTable data={backups} columns={columns} rowKey={(b) => b.id} empty="No backups yet." />
        )}
      </Card>
      {canManage && (
        <Card title="Retention and verification">
          <div className="stack" style={{ gap: 18 }}>
            <form className="setting-row" onSubmit={savePolicy}>
              <div>
                <strong>Delete old backups</strong>
                <p>
                  {retention ? `After ${retention} days.` : "Off — backups are kept until you delete them."} The latest successful backup is never removed.
                </p>
              </div>
              <div className="btn-group">
                <input
                  className="input"
                  style={{ width: 90 }}
                  type="number"
                  min={0}
                  max={3650}
                  aria-label="Days to keep backups, 0 to keep forever"
                  value={Number.isFinite(days) ? days : ""}
                  onChange={(e) => setDays(e.target.valueAsNumber)}
                  required
                />
                <span className="muted small">days</span>
                <Button size="sm" type="submit" busy={busy === "policy"} disabled={days === retention}>
                  Save
                </Button>
              </div>
            </form>
            <div className="setting-row">
              <div>
                <strong>Daily restore check</strong>
                <p>
                  Restores the latest backup into a temporary folder and validates it. The live server isn’t touched.
                  {verification?.latest ? ` Last check: ${verification.latest.state}${verification.latest.error ? ` — ${verification.latest.error}` : ""}.` : ""}
                </p>
              </div>
              <Switch
                label="Daily restore check"
                checked={!!verification?.intervalHours}
                busy={busy === "verification"}
                disabled={!verification}
                onChange={(on) =>
                  run(
                    "verification",
                    () => json("PATCH", `/servers/${id}/verification`, { intervalHours: on ? 24 : 0 }),
                    on ? "Daily restore check on" : "Daily restore check off",
                  )
                }
              />
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
