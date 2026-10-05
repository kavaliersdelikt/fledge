"use client";
import { useState, type ComponentProps } from "react";
import Link from "next/link";
import { json } from "@/lib/api";
import { useFeatures } from "@/lib/commerce";
import { useBrand } from "@/lib/brand";
import { fmtTime } from "@/lib/format";
import { Button, Card, Form, Notice, Switch, State, useLoad } from "./shared";
import { Modal } from "./feedback";
import { reasons, SuspensionPreview, type Suspension } from "./SuspendedShell";
type AdminSuspension = Suspension & {
  internalNote: string;
  events: {
    id: string;
    kind: string;
    created_at: string;
    data: Record<string, unknown>;
    reference?: string;
  }[];
};
export default function CustomerSuspension({
  id,
  onChange,
}: {
  id: string;
  onChange: () => void;
}) {
  const features = useFeatures(),
    canSuspend =
      features.isSuper || features.permissions?.includes("customers.suspend");
  const defaults = useLoad<any>(
    canSuspend ? "/support/suspension-settings" : null,
  );
  const { brand } = useBrand(),
    {
      data: s,
      error,
      loading,
      reload,
    } = useLoad<AdminSuspension | null>(`/customers/${id}/suspension`);
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState("billing"),
    [message, setMessage] = useState(reasons[0].message),
    [note, setNote] = useState(""),
    [stop, setStop] = useState(true),
    [backups, setBackups] = useState(false),
    [deletion, setDeletion] = useState(true),
    [notify, setNotify] = useState(true),
    [payment, setPayment] = useState(true),
    [until, setUntil] = useState(""),
    [edit, setEdit] = useState(false),
    [problem, setProblem] = useState("");
  function launch(editing = false) {
    setEdit(editing);
    if (editing && s) {
      setReason(s.reason);
      setMessage(s.message);
      setNote(s.internalNote);
      setBackups(s.allowBackupDownload);
      setDeletion(s.allowAccountDeletion);
      setPayment(s.liftOnPayment);
      setUntil(
        s.until
          ? new Date(
              new Date(s.until).getTime() -
                new Date(s.until).getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16)
          : "",
      );
    } else {
      setReason("billing");
      setMessage(reasons[0].message);
      setNote("");
      setStop(defaults.data?.defaultServers ?? true);
      setBackups(false);
      setDeletion(true);
      setNotify(true);
      setPayment(true);
      setUntil("");
    }
    setOpen(true);
  }
  return (
    <Card
      title="Account suspension"
      actions={
        canSuspend && (
          <Button onClick={() => launch(!!s && !s.liftedAt)}>
            {s && !s.liftedAt ? "Edit suspension" : "Suspend account"}
          </Button>
        )
      }
    >
      <State loading={loading} error={error}>
        {null}
      </State>
      {s ? (
        <>
          <div className="btn-group">
            <span className="tag">
              {s.liftedAt
                ? "Restored"
                : reasons.find((r) => r.value === s.reason)?.label}
            </span>
            <code>{s.reference}</code>
          </div>
          <blockquote className="mews-quote">{s.message}</blockquote>
          {s.internalNote && (
            <Notice tone="warn" title="Internal note">
              {s.internalNote}
            </Notice>
          )}
          <ol className="mews-timeline">
            {s.events.map((e) => (
              <li key={e.id}>
                <strong>{e.kind.replaceAll("_", " ")}</strong>
                <small>{e.reference}</small>
                <span>{fmtTime(e.created_at)}</span>
                {typeof e.data.message === "string" && <p>{e.data.message}</p>}
                {typeof e.data.internalNote === "string" &&
                  e.data.internalNote && (
                    <Notice tone="warn" title="Internal note">
                      {e.data.internalNote}
                    </Notice>
                  )}
              </li>
            ))}
          </ol>
          <div className="btn-group">
            {canSuspend && !s.liftedAt && (
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await json("DELETE", `/customers/${id}/suspension`, {
                      note: "Lifted by administrator",
                    });
                    reload();
                    onChange();
                  } catch (e) {
                    setProblem((e as Error).message);
                  }
                }}
              >
                Lift suspension
              </Button>
            )}
            {s.ticketId && (
              <Link className="btn" href={`/support/${s.ticketId}`}>
                Open appeal
              </Link>
            )}
          </div>
        </>
      ) : (
        <p className="muted">
          Pause access with a reason and a message. The customer can still sign
          in to resolve the issue.
        </p>
      )}
      {problem && <Notice tone="bad">{problem}</Notice>}
      <Modal
        className="mews-suspension-dialog"
        wide
        open={open}
        onOpenChange={setOpen}
        title={edit ? "Edit suspension" : "Suspend account"}
      >
        <div className="mews-suspend-form">
          <Form
            submit={edit ? "Save changes" : "Suspend account"}
            onSubmit={async () => {
              await json(
                edit ? "PATCH" : "POST",
                `/customers/${id}/${edit ? "suspension" : "suspend"}`,
                edit
                  ? {
                      message,
                      internalNote: note,
                      allowBackupDownload: backups,
                      allowAccountDeletion: deletion,
                      liftOnPayment: reason === "billing" && payment,
                      until: until ? new Date(until).toISOString() : null,
                    }
                  : {
                      reason,
                      message,
                      internalNote: note,
                      stopServers: stop,
                      allowBackupDownload: backups,
                      allowAccountDeletion: deletion,
                      notify,
                      liftOnPayment: reason === "billing" && payment,
                      until: until ? new Date(until).toISOString() : null,
                    },
              );
              setOpen(false);
              reload();
              onChange();
            }}
          >
            <div className="mews-reasons" role="group" aria-label="Reason">
              {reasons.map((r) => (
                <button
                  disabled={edit}
                  type="button"
                  key={r.value}
                  aria-pressed={reason === r.value}
                  onClick={() => {
                    setReason(r.value);
                    setMessage(r.message);
                  }}
                >
                  <r.icon size={18} />
                  {r.label}
                </button>
              ))}
            </div>
            <label className="field">
              <span>Message the customer will read</span>
              <textarea
                className="input"
                maxLength={2000}
                rows={4}
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Internal note</span>
              <textarea
                className="input"
                maxLength={2000}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            {!edit && (
              <>
                <Toggle
                  label="Stop servers after a safe save"
                  checked={stop}
                  onChange={setStop}
                />
                <Toggle
                  label="Send email"
                  checked={notify}
                  onChange={setNotify}
                />
              </>
            )}
            <Toggle
              label="Allow backup downloads"
              checked={backups}
              onChange={setBackups}
            />
            <Toggle
              label="Allow account deletion"
              checked={deletion}
              onChange={setDeletion}
            />
            {reason === "billing" && (
              <Toggle
                label="Lift when outstanding invoices are paid"
                checked={payment}
                onChange={setPayment}
              />
            )}
            <label className="field">
              <span>Scheduled lift (optional)</span>
              <input
                type="datetime-local"
                className="input"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </label>
          </Form>
          <SuspensionPreview
            reason={reason}
            message={message}
            host={brand.identity.name}
          />
        </div>
      </Modal>
    </Card>
  );
}

function Toggle(props: ComponentProps<typeof Switch>) {
  return (
    <div className="mews-setting">
      <span>{props.label}</span>
      <Switch {...props} />
    </div>
  );
}
