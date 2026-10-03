"use client";
import { ApiError, json, request, type User } from "@/lib/api";
import { askPasskey, passkeyProblem, passkeysSupported } from "@/lib/webauthn";
import { Fingerprint, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Secret } from "./feedback";
import { BrandMark, useBrand } from "@/lib/brand";
import { PublicAnnouncementBanner } from "./AnnouncementBanner";
import { Button, Notice, Segmented } from "./shared";

type Mode = "loading" | "login" | "challenge" | "bootstrap" | "setup" | "recover" | "forgot" | "token";
type Method = "totp" | "passkey";

const copyFor = (name: string): Record<Mode, [string, string]> => ({
  loading: [name, ""],
  login: ["Sign in", ""],
  challenge: ["Two-factor authentication", ""],
  bootstrap: [`Set up ${name}`, "Create the first administrator account for this panel."],
  setup: ["Turn on two-factor authentication", "Administrators need an authenticator app. Add this key to yours, then enter the code it shows."],
  recover: ["Recover your account", "Use one of your saved recovery codes to set a new password."],
  forgot: ["Reset your password", "Enter your email address and we’ll send you a link to choose a new one."],
  token: ["Choose a password", "Pick a password of at least 12 characters to finish."],
});

const METHOD_KEY = "fledge.2fa-method";
const readMethod = (): Method | null => {
  try {
    const v = localStorage.getItem(METHOD_KEY);
    return v === "totp" || v === "passkey" ? v : null;
  } catch {
    return null;
  }
};
const rememberMethod = (m: Method) => {
  try {
    localStorage.setItem(METHOD_KEY, m);
  } catch {
    /* storage can be blocked */
  }
};
const tokenFromUrl = () => {
  try {
    return new URLSearchParams(location.search).get("token") || "";
  } catch {
    return "";
  }
};
const dropTokenFromUrl = () => {
  try {
    const url = new URL(location.href);
    url.searchParams.delete("token");
    history.replaceState(history.state, "", url.pathname + (url.search || "") + url.hash);
  } catch {
    /* leave the address as it is */
  }
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
    [challenge, setChallenge] = useState(""),
    [methods, setMethods] = useState<Method[]>(["totp"]),
    [method, setMethod] = useState<Method>("totp"),
    [token, setToken] = useState(""),
    [sent, setSent] = useState(false),
    [tokenDead, setTokenDead] = useState(false),
    [prefill, setPrefill] = useState("");
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
    if (existing) {
      setup().catch((e) => setError(e.message));
      return;
    }
    const t = tokenFromUrl();
    if (t) {
      setToken(t);
      setMode("token");
      return;
    }
    request<{ needsSetup: boolean }>("/auth/status")
      .then((s) => setMode(s.needsSetup ? "bootstrap" : "login"))
      .catch((e) => setError(e.message));
  }, [existing]);

  async function complete() {
    const me = await request<User>("/auth/me");
    if (me.role === "admin" && !me.has2fa) await setup();
    else onSuccess(me);
  }

  function go(next: Mode) {
    setMode(next);
    setChallenge("");
    setError("");
    setInfo("");
    setSent(false);
    setTokenDead(false);
  }

  function startChallenge(r: { challenge: string; methods?: string[] }) {
    const supported = passkeysSupported();
    const offered = (r.methods?.length ? r.methods : ["totp"]).filter((m): m is Method => m === "totp" || m === "passkey");
    // Without passkey support in this browser, fall back to the code if there is one.
    const usable = offered.filter((m) => m !== "passkey" || supported);
    const choices = usable.length ? usable : offered;
    const last = readMethod();
    setChallenge(r.challenge);
    setMethods(choices);
    setMethod(last && choices.includes(last) ? last : choices[0]);
    setMode("challenge");
  }

  async function passkeyLogin() {
    const options = await json("POST", "/auth/passkey/options", { challenge });
    let response;
    try {
      response = await askPasskey(options);
    } catch (e) {
      throw new Error(passkeyProblem(e, "sign in").message);
    }
    await json("POST", "/auth/passkey/verify", { challenge, response });
    rememberMethod("passkey");
    setChallenge("");
    await complete();
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
      } else if (mode === "forgot") {
        await json("POST", "/auth/forgot", { email: f.email });
        setSent(true);
      } else if (mode === "token") {
        if (f.password !== f.confirm) throw new Error("The two passwords don’t match.");
        const r = await json("POST", "/auth/token/accept", { token, password: f.password });
        dropTokenFromUrl();
        setToken("");
        setPrefill(r?.email || "");
        setMode("login");
        setInfo(
          r?.kind === "invite"
            ? "Your account is ready. Sign in with your new password."
            : "Password changed. Sign in with your new password.",
        );
      } else if (mode === "challenge") {
        if (method === "passkey") await passkeyLogin();
        else {
          await json("POST", "/auth/challenge", { challenge, code: f.code });
          rememberMethod("totp");
          setChallenge("");
          await complete();
        }
      } else if (mode === "setup") {
        await json("POST", "/auth/2fa/confirm", { code: f.code });
        await complete();
      } else {
        const r = await json("POST", `/auth/${mode}`, { email: f.email, password: f.password, stepwise: true });
        if (r.requires2fa) startChallenge(r);
        else await complete();
      }
    } catch (ex) {
      setError((ex as Error).message);
      if (mode === "token" && ex instanceof ApiError && ex.status > 0) setTokenDead(true);
    } finally {
      setBusy(false);
    }
  }

  const { brand } = useBrand();
  const [title, rawSubtitle] = copyFor(brand.identity.name)[mode];
  const subtitle =
    mode === "challenge"
      ? method === "passkey"
        ? "Use the passkey on this device or a security key to finish signing in."
        : "Enter the 6-digit code from your authenticator app."
      : rawSubtitle;
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
  const emailInput = (
    <label className="field">
      <span className="field__label">Email</span>
      <input
        className="input"
        name="email"
        type="email"
        required
        autoComplete="username"
        autoFocus
        defaultValue={mode === "login" ? prefill : undefined}
      />
    </label>
  );
  const tokenExpired = mode === "token" && tokenDead && !!error;
  const passkeyOnly = mode === "challenge" && methods.length === 1 && methods[0] === "passkey";
  const noPasskeySupport = mode === "challenge" && method === "passkey" && !passkeysSupported();

  return (
    <main className={`auth auth--${brand.login.layout} auth--bg-${brand.login.background}`}>
      {brand.login.layout === "split" || brand.login.background === "image" ? (
        <aside className="auth__aside" aria-hidden={brand.login.layout === "split" ? undefined : true} style={brand.login.background === "image" && brand.images.login ? { backgroundImage: `url(${brand.images.login})` } : undefined}>
          {brand.login.layout === "split" ? (
            <div className="auth__aside-text">
              <div className="auth__brand auth__brand--large">
                <BrandMark />
              </div>
              {brand.identity.tagline ? <p className="auth__tagline">{brand.identity.tagline}</p> : null}
            </div>
          ) : null}
        </aside>
      ) : null}
      <div className="auth__panel">
        <PublicAnnouncementBanner />
        <div className={`auth__brand${brand.login.layout === "split" ? " auth__brand--compact" : ""}`}>
          <BrandMark />
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
              {mode === "login" && brand.login.welcome ? <p className="auth__welcome">{brand.login.welcome}</p> : null}
              {mode === "login" && !brand.login.welcome && brand.identity.tagline && brand.login.layout !== "split" ? <p className="auth__welcome">{brand.identity.tagline}</p> : null}
            </div>
            {mode === "forgot" && sent ? (
              <div className="form">
                <Notice tone="ok">If an account exists for that address and email is set up, a link is on its way.</Notice>
                <p className="faint small">The link works once and expires after a while. Check your spam folder if it doesn’t show up.</p>
                <Button variant="primary" onClick={() => go("login")}>
                  Back to sign in
                </Button>
              </div>
            ) : (
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
                  <>
                    {methods.length > 1 && (
                      <Segmented<Method>
                        label="Verification method"
                        value={method}
                        onChange={(m) => {
                          setMethod(m);
                          setError("");
                        }}
                        options={[
                          { value: "totp", label: "Authenticator code" },
                          { value: "passkey", label: "Passkey" },
                        ]}
                      />
                    )}
                    {method === "totp" ? (
                      codeInput
                    ) : noPasskeySupport ? (
                      <Notice tone="warn" title="Passkeys aren’t available here">
                        This browser or address can’t use passkeys. Open the panel over https in a browser that supports them, or use a recovery code.
                      </Notice>
                    ) : (
                      <p className="auth__passkey">
                        <Fingerprint aria-hidden="true" />
                        <span>Your browser will ask you to confirm with your fingerprint, face, screen lock or security key.</span>
                      </p>
                    )}
                  </>
                ) : mode === "token" ? (
                  <>
                    <label className="field">
                      <span className="field__label">New password</span>
                      <input
                        className="input"
                        name="password"
                        type="password"
                        required
                        minLength={12}
                        autoComplete="new-password"
                        placeholder="At least 12 characters"
                        autoFocus
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">Confirm password</span>
                      <input className="input" name="confirm" type="password" required minLength={12} autoComplete="new-password" />
                    </label>
                  </>
                ) : mode === "forgot" ? (
                  emailInput
                ) : (
                  <>
                    {emailInput}
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
                      {mode === "login" && (
                        <button type="button" className="text-button auth__forgot" onClick={() => go("forgot")}>
                          Forgot password?
                        </button>
                      )}
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
                {tokenExpired && (
                  <button type="button" className="text-button" onClick={() => go("forgot")}>
                    Request a new link
                  </button>
                )}
                <Button type="submit" variant="primary" busy={busy} disabled={(mode === "setup" && !secret) || noPasskeySupport}>
                  {mode === "recover"
                    ? "Reset password"
                    : mode === "bootstrap"
                      ? "Create administrator"
                      : mode === "setup"
                        ? "Turn on"
                        : mode === "forgot"
                          ? "Send reset link"
                          : mode === "token"
                            ? "Save password"
                            : mode === "challenge"
                              ? method === "passkey"
                                ? "Use passkey"
                                : "Verify"
                              : "Sign in"}
                </Button>
              </form>
            )}
            {(mode === "login" || mode === "recover" || mode === "challenge" || mode === "forgot" || mode === "token") && (
              <div className="auth__foot">
                <span className="auth__links">
                  {mode === "login" ? (
                    <button type="button" className="text-button" onClick={() => go("recover")}>
                      Lost your authenticator?
                    </button>
                  ) : (
                    <button type="button" className="text-button" onClick={() => go("login")}>
                      Back to sign in
                    </button>
                  )}
                  {(mode === "forgot" || (mode === "challenge" && (passkeyOnly || method === "passkey"))) && (
                    <button type="button" className="text-button" onClick={() => go("recover")}>
                      Use a recovery code
                    </button>
                  )}
                </span>
                <a href="https://github.com/kavaliersdelikt/fledge#quick-start" target="_blank" rel="noreferrer">
                  Help
                </a>
              </div>
            )}
          </>
        )}
        {brand.login.footerLinks.length || brand.identity.showPoweredBy ? (
          <footer className="auth__legal">
            {brand.login.footerLinks.map((l) => (
              <a key={l.url + l.label} href={l.url} {...(l.newTab ? { target: "_blank", rel: "noopener noreferrer" } : { rel: "noopener noreferrer" })}>
                {l.label}
              </a>
            ))}
            {brand.identity.showPoweredBy ? (
              <a href="https://kavaliersdelikt.github.io/fledge/" target="_blank" rel="noopener noreferrer" className="auth__powered">
                Powered by {brand.product.name}
              </a>
            ) : null}
          </footer>
        ) : null}
      </div>
    </main>
  );
}
