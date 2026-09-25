"use client";
import { request } from "@/lib/api";
import {
Check,
Copy,
Download,
ExternalLink,
RefreshCw,
ShieldCheck,
Terminal,
Wrench,
} from "lucide-react";
import { useCallback,useEffect,useState } from "react";
import { Notice } from "./shared";

type UpdateInfo = {
  repository: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseName: string | null;
  releaseUrl: string;
  body: string;
  publishedAt: string | null;
  checkedAt: string;
  error: string | null;
};
export default function UpdateCenter() {
  const [info, setInfo] = useState<UpdateInfo | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [copied, setCopied] = useState(false),
    [windows, setWindows] = useState(false);
  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError("");
    try {
      setInfo(
        await request<UpdateInfo>(`/updates${force ? "?refresh=1" : ""}`),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setWindows(/windows|win32/i.test(navigator.userAgent));
    load();
  }, [load]);
  const versionArg =
    info?.updateAvailable && info.latestVersion
      ? ` v${info.latestVersion}`
      : "";
  const command = windows
    ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\update.ps1${versionArg ? ` -Version${versionArg}` : ""}`
    : `sh ./update.sh${versionArg}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Workspace / Updates</div>
          <h1>Updates</h1>
          <p className="muted">
            Check the latest release and prepare an update for this host.
          </p>
        </div>
        <button className="btn" onClick={() => load(true)} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin" : ""} /> Check now
        </button>
      </div>
      <section className="update-status">
        <div className="update-mark" aria-hidden="true"><Download size={19} /></div>
        <div className="update-summary">
          <span className="eyebrow">Installed version</span>
          <strong>
            {info
              ? `v${info.currentVersion}`
              : loading
                ? "Checking…"
                : "Unavailable"}
          </strong>
          <p>
            {info?.updateAvailable
              ? "A newer stable release is available."
              : info?.latestVersion
                ? `You’re up to date with v${info.latestVersion}.`
                : "Release information is unavailable."}
          </p>
        </div>
        <div className="update-divider" />
        <div className="update-latest">
          <span className="muted small">Latest release</span>
          <strong>
            {info?.latestVersion ? `v${info.latestVersion}` : "—"}
          </strong>
          {info?.publishedAt && (
            <span className="muted small">
              Published {new Date(info.publishedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </section>
      {info && (
        <Notice
          status={info.updateAvailable ? "warning" : info.latestVersion ? "success" : "default"}
          className="update-release-notice"
          title={info.updateAvailable ? "An update is available" : info.latestVersion ? "This host is up to date" : "Latest release could not be checked"}
        >
          {info.updateAvailable && info.releaseUrl ? (
            <a href={info.releaseUrl} target="_blank" rel="noreferrer" className="notice-link">
              Read release notes <ExternalLink size={13} />
            </a>
          ) : info.latestVersion ? (
            <span>Checked {new Date(info.checkedAt).toLocaleString()}.</span>
          ) : (
            <span>Release details will appear here when GitHub is reachable.</span>
          )}
        </Notice>
      )}
      {error && <Notice status="danger">{error}</Notice>}
      {info?.error && (
        <Notice status="accent" title="Release information unavailable">
          {info.error}{" "}
          {info.repository === "kavaliersdelikt/fledge" && (
            <span>
              Repository:{" "}
              <a
                href={`https://github.com/${info.repository}`}
                target="_blank"
                rel="noreferrer"
              >
                {info.repository}
              </a>
              .
            </span>
          )}
        </Notice>
      )}
      <section className="section update-runbook">
        <div className="section-title">
          <div>
            <span className="eyebrow">On this machine</span>
            <h2>Run the updater</h2>
            <p className="muted">
              Copy this command and run it from the Fledge project folder.
            </p>
          </div>
        </div>
        <div
          className="segmented update-platform"
          aria-label="Host operating system"
        >
          <button aria-pressed={!windows} onClick={() => setWindows(false)}>
            Linux / macOS
          </button>
          <button aria-pressed={windows} onClick={() => setWindows(true)}>
            Windows
          </button>
        </div>
        <div className="update-command">
          <div>
            <Terminal size={15} />
            <span>{windows ? "PowerShell" : "Terminal"}</span>
          </div>
          <code>{command}</code>
          <button className="btn" onClick={copy}>
            {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
            {copied ? "Copied" : "Copy command"}
          </button>
        </div>
        <div className="update-notes">
          <span><ShieldCheck size={15} /> The updater checks the Git checkout and saves a PostgreSQL backup.</span>
          <span><RefreshCw size={15} /> It rebuilds the panel and checks API and web health.</span>
          <span><Wrench size={15} /> The command runs on the host; the panel never runs it.</span>
        </div>
      </section>
      {info?.latestVersion && info.body && (
        <section className="section">
          <div className="section-title">
            <div>
              <h2>{info.releaseName}</h2>
              <p className="muted">Release notes from GitHub.</p>
            </div>
            <a
              className="btn"
              href={info.releaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              View release <ExternalLink size={14} />
            </a>
          </div>
          <pre className="release-notes">{info.body}</pre>
        </section>
      )}
      {info && (
        <p className="muted small update-meta">
          Repository:{" "}
          <a
            href={`https://github.com/${info.repository}`}
            target="_blank"
            rel="noreferrer"
          >
            {info.repository}
          </a>{" "}
          · Checked {new Date(info.checkedAt).toLocaleString()}
        </p>
      )}
    </>
  );
}
