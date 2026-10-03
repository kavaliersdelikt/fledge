"use client";

import { items, json, request, type AccountUsage, type AuthSession, type Passkey } from "@/lib/api";
import { fmtAgo, fmtDay, fmtTime, fmtCpu, fmtMb } from "@/lib/format";
import { hasQuota, quotaShare } from "@/lib/quota";
import { deviceLabel, isMobileAgent } from "@/lib/useragent";
import { makePasskey, passkeyProblem, passkeyUnsupportedReason, passkeysSupported } from "@/lib/webauthn";
import { Fingerprint, Monitor, Plus, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "./feedback";
import { useToast } from "./toast";
import { Button, Card, Confirm, Empty, Field, Form, Meter, Notice, State, useLoad } from "./shared";

/** Signed-in browsers for this account, with a way to end any of them. */
export function SessionsCard() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<AuthSession[]>("/auth/sessions");
  const sessions = items(data);
  const others = sessions.filter((s) => !s.current).length;
  return (
    <Card
      title="Signed-in devices"
      description="Browsers that are signed in to your account right now. Sign out any you don’t recognise."
      flush
      actions={
        <Confirm
          size="sm"
          danger={false}
          variant="secondary"
          confirmLabel="Sign out other devices"
          text="Every other browser is signed out and has to sign in again. This device stays signed in."
          onConfirm={async () => {
            const r = (await json("POST", "/auth/sessions/revoke-others")) as { revoked?: number };
            toast({ tone: "ok", title: r?.revoked ? `Signed out ${r.revoked} other ${r.revoked === 1 ? "device" : "devices"}` : "No other devices were signed in" });
            reload();
          }}
        >
          Sign out all other devices
        </Confirm>
      }
    >
      <State loading={loading} error={error} rows={2}>
        {sessions.length ? (
          <ul className="plug-list" aria-label="Signed-in devices">
            {sessions.map((s) => {
              const Icon = isMobileAgent(s.userAgent) ? Smartphone : Monitor;
              return (
                <li className="plug-row" key={s.id}>
                  <Icon className="session-icon" aria-hidden="true" />
                  <div className="plug-row__main">
                    <span className="plug-row__name">
                      <strong>{deviceLabel(s.userAgent)}</strong>
                      {s.current ? <span className="tag tag--accent">This device</span> : null}
                    </span>
                    <span className="plug-row__desc">
                      {s.ip || "Unknown address"} · Active{" "}
                      <time dateTime={s.lastSeenAt || s.createdAt} title={fmtTime(s.lastSeenAt || s.createdAt)}>
                        {fmtAgo(s.lastSeenAt || s.createdAt)}
                      </time>{" "}
                      · Signed in {fmtDay(s.createdAt)}
                    </span>
                  </div>
                  <div className="plug-row__actions">
                    <Confirm
                      variant="ghost"
                      danger={!s.current}
                      confirmLabel="Sign out"
                      text={
                        s.current
                          ? "You’ll be signed out of this browser and taken to the sign-in page."
                          : `${deviceLabel(s.userAgent)} (${s.ip || "unknown address"}) is signed out immediately.`
                      }
                      onConfirm={async () => {
                        await request(`/auth/sessions/${s.id}`, { method: "DELETE" });
                        if (s.current) {
                          location.assign("/");
                          return;
                        }
                        toast({ tone: "ok", title: "Device signed out" });
                        reload();
                      }}
                    >
                      Sign out
                    </Confirm>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title="No sessions found" />
        )}
        {sessions.length > 0 && others === 0 ? <p className="card__foot">This is the only device signed in.</p> : null}
      </State>
    </Card>
  );
}

/** Passkeys: sign in with a fingerprint, screen lock or security key instead of an authenticator code. */
export function PasskeysCard() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Passkey[]>("/auth/passkeys");
  const [adding, setAdding] = useState(false);
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(passkeysSupported()), []);
  const list = items(data);
  return (
    <>
      <Card
        title="Passkeys"
        description="A passkey can be used instead of an authenticator code when you sign in. It lives on your device or security key and can’t be phished."
        flush
        actions={
          <Button size="sm" disabled={!supported} onClick={() => setAdding(true)}>
            <Plus /> Add passkey
          </Button>
        }
      >
        {!supported ? (
          <div className="card__note">
            <Notice tone="warn" title="Passkeys aren’t available in this browser">
              {passkeyUnsupportedReason()}
            </Notice>
          </div>
        ) : null}
        <State loading={loading} error={error} rows={2}>
          {list.length ? (
            <ul className="plug-list" aria-label="Passkeys">
              {list.map((k) => (
                <li className="plug-row" key={k.id}>
                  <Fingerprint className="session-icon" aria-hidden="true" />
                  <div className="plug-row__main">
                    <span className="plug-row__name">
                      <strong>{k.name || "Passkey"}</strong>
                      {k.deviceType === "multiDevice" || k.backedUp ? <span className="tag">Synced</span> : <span className="tag">This device only</span>}
                    </span>
                    <span className="plug-row__desc">
                      Added {fmtDay(k.createdAt)} · {k.lastUsedAt ? `Last used ${fmtAgo(k.lastUsedAt)}` : "Never used"}
                    </span>
                  </div>
                  <div className="plug-row__actions">
                    <Confirm
                      variant="ghost"
                      confirmLabel="Remove passkey"
                      text={`“${k.name || "Passkey"}” can no longer be used to sign in.`}
                      onConfirm={async () => {
                        await request(`/auth/passkeys/${k.id}`, { method: "DELETE" });
                        toast({ tone: "ok", title: "Passkey removed" });
                        reload();
                      }}
                    >
                      Remove
                    </Confirm>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No passkeys yet">Add one to sign in with your fingerprint, face or a security key.</Empty>
          )}
        </State>
      </Card>
      <Modal
        open={adding}
        onOpenChange={setAdding}
        title="Add a passkey"
        description="Give it a name you’ll recognise, then follow your browser’s prompt."
      >
        <Form
          submit="Continue"
          success={false}
          onSubmit={async (v) => {
            const options = await json("POST", "/auth/passkeys/options");
            let response;
            try {
              response = await makePasskey(options);
            } catch (e) {
              throw new Error(passkeyProblem(e, "register").message);
            }
            await json("POST", "/auth/passkeys/verify", { response, name: String(v.name || "").trim() || "Passkey" });
            setAdding(false);
            toast({ tone: "ok", title: "Passkey added", description: "You can use it the next time you sign in." });
            reload();
          }}
        >
          <Field label="Name" name="name" required defaultValue={deviceLabel(typeof navigator === "undefined" ? "" : navigator.userAgent)} placeholder="Work laptop" />
        </Form>
      </Modal>
    </>
  );
}

/** A customer's limits against what they use. Hidden when nothing is limited. */
export function PlanCard() {
  const { data, error, loading } = useLoad<AccountUsage>("/account/usage");
  if (loading || error || !data || !hasQuota(data.quota)) return null;
  const { quota: q, usage: u } = data;
  const rows: { key: string; label: string; used: number; limit: number | null | undefined; text: string }[] = [
    { key: "servers", label: "Servers", used: u.servers, limit: q.maxServers, text: `${u.servers} / ${q.maxServers}` },
    { key: "memory", label: "Memory", used: u.memoryMb, limit: q.maxMemoryMb, text: `${fmtMb(u.memoryMb)} / ${fmtMb(q.maxMemoryMb)}` },
    { key: "cpu", label: "CPU", used: u.cpuPercent, limit: q.maxCpuPercent, text: `${fmtCpu(u.cpuPercent)} / ${fmtCpu(q.maxCpuPercent)}` },
    { key: "disk", label: "Disk", used: u.diskMb, limit: q.maxDiskMb, text: `${fmtMb(u.diskMb)} / ${fmtMb(q.maxDiskMb)}` },
    { key: "backups", label: "Backups", used: u.backups ?? 0, limit: q.maxBackups, text: `${u.backups ?? 0} / ${q.maxBackups}` },
    { key: "ports", label: "Extra ports", used: u.extraPorts ?? 0, limit: q.maxExtraPorts, text: `${u.extraPorts ?? 0} / ${q.maxExtraPorts}` },
  ];
  return (
    <section className="settings__section">
      <div className="settings__intro">
        <h2>Your plan</h2>
        <p>What your account can use. Ask your host if you need more.</p>
      </div>
      <div className="settings__body">
        <Card>
      <ul className="quota-list">
        {rows
          .filter((r) => r.limit !== undefined && r.limit !== null)
          .map((r) => {
            const share = quotaShare(r.used, r.limit) ?? 0;
            return (
              <li key={r.key} className="quota-row">
                <div className="quota-row__text">
                  <span>{r.label}</span>
                  <strong className="num">{r.text}</strong>
                </div>
                <Meter label={`${r.label} in use`} value={Math.min(r.used, r.limit || r.used || 1)} max={r.limit || 1} />
                {share >= 100 ? <small className="quota-row__full">Limit reached</small> : null}
              </li>
            );
          })}
      </ul>
        </Card>
      </div>
    </section>
  );
}
