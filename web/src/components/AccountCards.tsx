"use client";
import { API, json } from "@/lib/api";
import { fmtDay } from "@/lib/format";
import { useFeatures, type LimitsView } from "@/lib/commerce";
import { Download } from "lucide-react";
import { useState } from "react";
import { Modal } from "./feedback";
import { LimitUsage } from "./LimitsUI";
import { Button, Card, ErrorNotice, Notice, State, btn, useLoad } from "./shared";
import { useToast } from "./toast";

/** What the customer's account can use, with where each limit comes from. Replaces the old plan card. */
export function UsageCard() {
  const { data, error, loading } = useLoad<LimitsView>("/limits/me");
  if (loading || error || !data || data.hidden || data.rows.length === 0) return null;
  const limited = data.rows.some((r) => !r.unlimited);
  if (!limited && !data.rows.some((r) => (r.used ?? 0) > 0)) return null;
  return (
    <section className="settings__section">
      <div className="settings__intro">
        <h2>Your usage</h2>
        <p>What your account can use. Ask your host, or look at the store, if you need more.</p>
      </div>
      <div className="settings__body">
        <Card>
          <LimitUsage view={data} />
        </Card>
      </div>
    </section>
  );
}

/** Email address, data download and account deletion for the signed-in customer. */
export function AccountOptionsCard({ email }: { email: string }) {
  const f = useFeatures();
  const toast = useToast();
  const [mode, setMode] = useState<"email" | "delete" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = f.account.status === "deletion_pending";
  const submit = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError("");
    try {
      await json("POST", path, body);
      toast({ tone: "ok", title: done });
      setMode(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!f.account.allowEmailChange && !f.account.allowExport && !f.account.allowDeletion && !pending) return null;
  return (
    <>
      <Card title="Your data" description="Change your address, download what we hold about you, or close your account.">
        {pending ? (
          <Notice
            tone="warn"
            title="Your account is scheduled for deletion"
            action={
              <Button
                size="sm"
                onClick={async () => {
                  await json("POST", "/account/delete/cancel");
                  toast({ tone: "ok", title: "Deletion cancelled" });
                  location.reload();
                }}
              >
                Keep my account
              </Button>
            }
          >
            Until it happens you can still sign in and cancel it.
          </Notice>
        ) : null}
        <div className="btn-group">
          {f.account.allowEmailChange ? <Button onClick={() => { setError(""); setMode("email"); }}>Change email address</Button> : null}
          {f.account.allowExport ? (
            <a className={btn("secondary")} href={`${API}/api/account/export`}>
              <Download /> Download my data
            </a>
          ) : null}
          {f.account.allowDeletion && !pending ? (
            <Button variant="danger" onClick={() => { setError(""); setMode("delete"); }}>
              Delete my account…
            </Button>
          ) : null}
        </div>
      </Card>
      {mode === "email" ? (
        <Modal open onOpenChange={(o) => !o && setMode(null)} title="Change email address" description={`You sign in with ${email} now. We send a link to the new address; nothing changes until you open it.`}>
          <form className="form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); void submit("/account/email", { email: d.get("email"), password: d.get("password") }, "Check the new address for a link"); }}>
            <label className="field"><span className="field__label">New email address</span><input className="input" name="email" type="email" required autoComplete="email" /></label>
            <label className="field"><span className="field__label">Your password</span><input className="input" name="password" type="password" required autoComplete="current-password" /></label>
            <ErrorNotice message={error} />
            <div className="modal__actions"><Button onClick={() => setMode(null)}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Send the link</Button></div>
          </form>
        </Modal>
      ) : null}
      {mode === "delete" ? (
        <Modal open onOpenChange={(o) => !o && setMode(null)} title="Delete your account" description="Your account and personal data are removed after a waiting time. Servers and subscriptions must be gone first. Invoices stay, without your details.">
          <form className="form" onSubmit={async (e) => { e.preventDefault(); const d = new FormData(e.currentTarget); if (await submit("/account/delete", { password: d.get("password") }, "Deletion scheduled")) location.reload(); }}>
            <label className="field"><span className="field__label">Your password</span><input className="input" name="password" type="password" required autoComplete="current-password" /></label>
            <ErrorNotice message={error} />
            <div className="modal__actions"><Button onClick={() => setMode(null)}>Cancel</Button><Button type="submit" variant="danger" busy={busy}>Delete my account</Button></div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
void State;void fmtDay;
