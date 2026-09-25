"use client";
import { json,request,type User } from "@/lib/api";
import { ArrowUpRight,LoaderCircle,ShieldCheck,X } from "lucide-react";
import { useEffect,useRef,useState,type FormEvent } from "react";
import { Notice } from "./shared";

export default function Auth({
  existing,
  onSuccess,
}: {
  existing?: User;
  onSuccess: (u: User) => void;
}) {
  const [mode, setMode] = useState<
    "loading" | "login" | "bootstrap" | "setup" | "recover"
  >(existing ? "setup" : "loading");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState(""),
    [uri, setUri] = useState(""),
    [challenge, setChallenge] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    started = useRef(false);
  async function setup() {
    const s = await json("POST", "/auth/2fa/setup");
    setSecret(s.secret);
    setUri(s.uri);
    setMode("setup");
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (existing) setup().catch((e) => setError(e.message));
    else
      request<{ needsSetup: boolean }>("/auth/status")
        .then((s) => setMode(s.needsSetup ? "bootstrap" : "login"))
        .catch((e) => setError(e.message));
  }, [existing]);
  useEffect(() => {
    if (challenge) dialog.current?.showModal();
    else dialog.current?.close();
  }, [challenge]);
  async function complete() {
    const me = await request<User>("/auth/me");
    if (me.role === "admin" && !me.has2fa) await setup();
    else onSuccess(me);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (mode === "recover") {
        await json("POST", "/auth/recover", {
          email: f.email,
          password: f.password,
          recoveryCode: f.recoveryCode,
        });
        setMode("login");
        setError(
          "Account recovered. Sign in with your new password and configure your authenticator again.",
        );
        return;
      }
      if (mode === "setup") {
        await json("POST", "/auth/2fa/confirm", { code: f.code });
        await complete();
      } else {
        const r = await json("POST", `/auth/${mode}`, {
          email: f.email,
          password: f.password,
          stepwise: true,
        });
        if (r.requires2fa) setChallenge(r.challenge);
        else await complete();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await json("POST", "/auth/challenge", {
        challenge,
        code: new FormData(e.currentTarget).get("code"),
      });
      setChallenge("");
      await complete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title =
    mode === "recover"
      ? "Recover your account"
      : mode === "bootstrap"
        ? "Create your workspace"
        : mode === "setup"
          ? "Secure your account"
          : "Welcome back.";
  return (
    <main className="auth-layout">
      <section className="auth-left">
        <a className="auth-logo" href="/">
          <img src="/fledge-symbol.png" alt="" /> Fledge
          <span>CONTROL PANEL</span>
        </a>
        <div className="auth-form-wrap">
          <div className="eyebrow">
            {mode === "bootstrap"
              ? "FLEDGE / FIRST ADMINISTRATOR"
              : mode === "setup"
                ? "FLEDGE / ACCOUNT SECURITY"
                : "FLEDGE / CONTROL PANEL"}
          </div>
          <h1>{title}</h1>
          <p className="auth-intro">
            {mode === "recover"
              ? "Use a saved recovery code to reset your access."
              : mode === "bootstrap"
                ? "Create the first administrator to open your workspace."
                : mode === "setup"
                  ? "Connect an authenticator app to keep your workspace secure."
                  : "Sign in to manage your servers and connected hosts."}
          </p>
          {mode === "loading" ? (
            <div className="loading-state">
              <LoaderCircle className="spin" />
              <span>{error || "Opening your workspace…"}</span>
              {error && (
                <button className="btn" onClick={() => location.reload()}>
                  Retry
                </button>
              )}
            </div>
          ) : (
            <form onSubmit={submit} className="form">
              {mode === "setup" ? (
                <>
                  <div className="secret">
                    <span>Authenticator setup key</span>
                    <code>{secret || "Loading…"}</code>
                  </div>
                  <a className="link" href={uri}>
                    Open in your authenticator <ArrowUpRight size={14} />
                  </a>
                  <label className="field">
                    <span>Verification code</span>
                    <input
                      name="code"
                      required
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      autoComplete="one-time-code"
                      placeholder="000000"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Email address</span>
                    <input
                      name="email"
                      type="email"
                      required
                      autoComplete="username"
                      placeholder="you@yourcompany.com"
                    />
                  </label>
                  <label className="field">
                    <span>
                      {mode === "recover" ? "New password" : "Password"}
                    </span>
                    <input
                      name="password"
                      type="password"
                      required
                      minLength={mode !== "login" ? 12 : undefined}
                      autoComplete={
                        mode !== "login" ? "new-password" : "current-password"
                      }
                      placeholder={
                        mode !== "login"
                          ? "At least 12 characters"
                          : "Enter your password"
                      }
                    />
                  </label>
                  {mode === "recover" && (
                    <label className="field">
                      <span>Saved recovery code</span>
                      <input name="recoveryCode" required autoComplete="off" />
                    </label>
                  )}
                </>
              )}
              {error && !challenge && <Notice status="danger">{error}</Notice>}
              <button
                className="btn primary auth-submit"
                disabled={busy || (mode === "setup" && !secret)}
              >
                {busy ? <LoaderCircle size={18} className="spin" /> : null}
                {mode === "recover"
                  ? "Reset account access"
                  : mode === "bootstrap"
                    ? "Create workspace"
                    : mode === "setup"
                      ? "Enable protection"
                      : "Continue"}
                <ArrowUpRight size={18} />
              </button>
              <div className="auth-secure">
                <ShieldCheck size={14} />{" "}
                {mode === "login"
                  ? "A second verification step follows sign-in."
                  : "Protect this workspace with two-step verification."}
              </div>
            </form>
          )}
          {(mode === "login" || mode === "recover") && (
            <button
              className="text-button recovery-link"
              onClick={() => {
                setMode(mode === "login" ? "recover" : "login");
                setError("");
              }}
            >
              {mode === "login"
                ? "Lost access? Use a recovery code"
                : "Back to sign in"}
            </button>
          )}
        </div>
        <footer className="auth-bottom">
          <a href="/install">Getting started</a>
          <span>Server and host management</span>
          <span>© {new Date().getFullYear()}</span>
        </footer>
      </section>
      <aside className="auth-art">
        <div className="art-top">
          <span>FLEDGE / CONTROL PANEL</span>
          <img src="/fledge-symbol.png" alt="Fledge mark" />
        </div>
        <div className="auth-art-content">
          <h2>Keep the whole fleet in view.</h2>
          <p>Manage game servers, connected hosts, and maintenance from one workspace.</p>
          <div className="auth-feature-list">
            <div><strong>Servers</strong><small>Console, files, backups</small></div>
            <div><strong>Hosts</strong><small>Connections and capacity</small></div>
            <div><strong>Operations</strong><small>Jobs, activity, updates</small></div>
          </div>
        </div>
        <div className="auth-art-foot"><span>FLEDGE</span><span>SELF-HOSTED GAME SERVERS</span></div>
      </aside>
      <dialog
        ref={dialog}
        className="auth-dialog"
        onCancel={() => {
          setChallenge("");
          setError("");
        }}
        aria-labelledby="verification-title"
      >
        <button
          className="dialog-close"
          aria-label="Close verification"
          onClick={() => {
            setChallenge("");
            setError("");
          }}
        >
          <X size={20} />
        </button>
        <ShieldCheck size={28} />
        <div className="eyebrow">Security / Verification</div>
        <h2 id="verification-title">Verify your identity</h2>
        <p className="muted">
          Enter the six-digit code from your authenticator app.
        </p>
        <form onSubmit={verify} className="form">
          <label className="field">
            <span>Verification code</span>
            <input
              name="code"
              className="otp-input"
              required
              pattern="[0-9]{6}"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              autoFocus
            />
          </label>
          {error && <Notice status="danger">{error}</Notice>}
          <button className="btn primary" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}Verify
            and sign in
          </button>
        </form>
      </dialog>
    </main>
  );
}
