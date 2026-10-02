"use client";
import { json, request, type User } from "@/lib/api";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Secret } from "./feedback";
import { Button, Notice } from "./shared";

type Mode = "loading" | "login" | "challenge" | "bootstrap" | "setup" | "recover";

const copy: Record<Mode, [string, string]> = {
  loading: ["Fledge", ""],
  login: ["Sign in", ""],
  challenge: ["Two-factor authentication", "Enter the 6-digit code from your authenticator app."],
  bootstrap: ["Set up Fledge", "Create the first administrator account for this panel."],
  setup: ["Turn on two-factor authentication", "Administrators need an authenticator app. Add this key to yours, then enter the code it shows."],
  recover: ["Recover your account", "Use one of your saved recovery codes to set a new password."],
};

export default function Auth({
  existing,
  onSuccess,
}: {
  existing?: User;
  onSuccess: (u: User) => void;
}) {
  const [mode, setMode] = useState<Mode>(existing ? "setup" : "loading");
  const [error, setError] = useState(""),
    [info, setInfo] = useState(""),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState(""),
    [uri, setUri] = useState(""),
    [challenge, setChallenge] = useState("");
  const started = useRef(false);

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

  async function complete() {
    const me = await request<User>("/auth/me");
    if (me.role === "admin" && !me.has2fa) await setup();
    else onSuccess(me);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (mode === "recover") {
        await json("POST", "/auth/recover", { email: f.email, password: f.password, recoveryCode: f.recoveryCode });
        setMode("login");
        setInfo("Account recovered. Sign in with your new password, then set up your authenticator again.");
      } else if (mode === "challenge") {
        await json("POST", "/auth/challenge", { challenge, code: f.code });
        setChallenge("");
        await complete();
      } else if (mode === "setup") {
        await json("POST", "/auth/2fa/confirm", { code: f.code });
        await complete();
      } else {
        const r = await json("POST", `/auth/${mode}`, { email: f.email, password: f.password, stepwise: true });
        if (r.requires2fa) {
          setChallenge(r.challenge);
          setMode("challenge");
        } else await complete();
      }
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [title, subtitle] = copy[mode];
  const codeInput = (
    <label className="field">
      <span className="field__label">Code</span>
      <input
        className="input otp"
        name="code"
        required
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="one-time-code"
        placeholder="000000"
        autoFocus
      />
    </label>
  );

  return (
    <main className="auth">
      <div className="auth__panel">
        <div className="auth__brand">
          <img src="/fledge-symbol.png" alt="" />
          Fledge
        </div>
        {mode === "loading" ? (
          error ? (
            <>
              <Notice tone="bad" title="Can’t reach the panel API">
                {error}
              </Notice>
              <Button onClick={() => location.reload()}>Try again</Button>
            </>
          ) : (
            <LoaderCircle className="spin faint" />
          )
        ) : (
          <>
            <div className="auth__head">
              <h1>{title}</h1>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
            <form onSubmit={submit} className="form" key={mode}>
              {mode === "setup" ? (
                <>
                  {secret ? <Secret label="Setup key" value={secret} /> : <LoaderCircle className="spin faint" />}
                  {uri ? (
                    <a className="text-button" href={uri}>
                      Open in authenticator app on this device
                    </a>
                  ) : null}
                  {codeInput}
                </>
              ) : mode === "challenge" ? (
                codeInput
              ) : (
                <>
                  <label className="field">
                    <span className="field__label">Email</span>
                    <input className="input" name="email" type="email" required autoComplete="username" autoFocus />
                  </label>
                  <label className="field">
                    <span className="field__label">{mode === "recover" ? "New password" : "Password"}</span>
                    <input
                      className="input"
                      name="password"
                      type="password"
                      required
                      minLength={mode !== "login" ? 12 : undefined}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      placeholder={mode === "login" ? undefined : "At least 12 characters"}
                    />
                  </label>
                  {mode === "recover" && (
                    <label className="field">
                      <span className="field__label">Recovery code</span>
                      <input className="input mono" name="recoveryCode" required autoComplete="off" />
                    </label>
                  )}
                </>
              )}
              {info && <Notice tone="ok">{info}</Notice>}
              {error && <Notice tone="bad">{error}</Notice>}
              <Button type="submit" variant="primary" busy={busy} disabled={mode === "setup" && !secret}>
                {mode === "recover"
                  ? "Reset password"
                  : mode === "bootstrap"
                    ? "Create administrator"
                    : mode === "setup"
                      ? "Turn on"
                      : mode === "challenge"
                        ? "Verify"
                        : "Sign in"}
              </Button>
            </form>
            {(mode === "login" || mode === "recover" || mode === "challenge") && (
              <div className="auth__foot">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setMode(mode === "login" ? "recover" : "login");
                    setChallenge("");
                    setError("");
                    setInfo("");
                  }}
                >
                  {mode === "login" ? "Lost your authenticator?" : "Back to sign in"}
                </button>
                <a href="https://github.com/kavaliersdelikt/fledge#quick-start" target="_blank" rel="noreferrer">
                  Help
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
