"use client";
import { request } from "@/lib/api";
import { ArrowRight, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, ErrorNotice, Notice, PageHeader, Skeleton, Status } from "./shared";

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
  oneClickEnabled: boolean;
};
type UpdateStatus = {
  state: "idle" | "running" | "succeeded" | "failed" | "unavailable";
  phase: string;
  version?: string | null;
  logs: string[];
  error?: string | null;
};

const steps: [string, string][] = [
  ["preparing", "Prepare"],
  ["backup", "Back up database"],
  ["installing", "Install release"],
  ["checking-health", "Health check"],
];
const phaseCopy: Record<string, string> = {
  starting: "Starting",
  preparing: "Checking this installation",
  backup: "Backing up the database",
  "backup-complete": "Database backed up",
  installing: "Installing the release",
  "checking-health": "Checking the panel’s health",
  restarting: "Waiting for the panel to come back",
};

export default function UpdateCenter() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const initiated = useRef(false);

  const load = useCallback(async (force = false) => {
    setChecking(true);
    setError("");
    try {
      setInfo(await request<UpdateInfo>(`/updates${force ? "?refresh=1" : ""}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
      setLoading(false);
    }
  }, []);
  const refreshStatus = useCallback(async () => {
    try {
      const next = await request<UpdateStatus>("/updates/status");
      setStatus(next);
      if (initiated.current && next.state === "succeeded") void load(true);
      if (next.state === "succeeded" || next.state === "failed") initiated.current = false;
    } catch {
      if (initiated.current) setStatus((current) => (current ? { ...current, phase: "restarting" } : current));
    }
  }, [load]);

  useEffect(() => {
    void Promise.all([load(), refreshStatus()]);
  }, [load, refreshStatus]);
  useEffect(() => {
    if (status?.state !== "running" && !initiated.current) return;
    const timer = window.setInterval(() => void refreshStatus(), 1800);
    return () => window.clearInterval(timer);
  }, [status?.state, refreshStatus]);

  async function start() {
    setStarting(true);
    setError("");
    try {
      const next = await request<UpdateStatus>("/updates/run", { method: "POST", body: "{}" });
      initiated.current = next.state === "running";
      setStatus(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const running = status?.state === "running";
  const phase = status?.phase === "backup-complete" ? "installing" : status?.phase || "";
  const current = steps.findIndex(([key]) => key === phase);

  return (
    <>
      <PageHeader
        title="Updates"
        meta={
          info ? (
            <>
              <span className="num">v{info.currentVersion}</span>
              {info.latestVersion && !info.updateAvailable && !info.error ? (
                <>
                  <span className="sep">·</span>
                  <span>Up to date</span>
                </>
              ) : null}
              <span className="sep">·</span>
              <a className="text-button" href={`https://github.com/${info.repository}/releases`} target="_blank" rel="noreferrer">
                {info.repository}
              </a>
            </>
          ) : undefined
        }
        actions={
          <Button onClick={() => void load(true)} disabled={loading || checking || running}>
            <RefreshCw className={checking ? "spin" : ""} /> Check now
          </Button>
        }
      />
      <ErrorNotice message={error} />
      {loading ? (
        <Skeleton rows={4} />
      ) : info ? (
        <>
          {info.updateAvailable || running ? (
            <Card flush>
              <div className="release">
                <div className="release__versions">
                  <div className="release__version">
                    <span>Installed</span>
                    <strong>v{info.currentVersion}</strong>
                  </div>
                  {info.latestVersion ? (
                    <>
                      <ArrowRight className="release__arrow" />
                      <div className="release__version">
                        <span>Available</span>
                        <strong>v{info.latestVersion}</strong>
                      </div>
                    </>
                  ) : null}
                </div>
                {running ? (
                  <Status value="pending" label={phaseCopy[status?.phase || ""] || "Updating"} />
                ) : info.oneClickEnabled ? (
                  <Button variant="primary" busy={starting} onClick={() => void start()}>
                    Update to v{info.latestVersion}
                  </Button>
                ) : null}
              </div>
              {running ? (
                <div className="card__foot" style={{ padding: 18 }} role="status" aria-live="polite">
                  <ol className="steps">
                    {steps.map(([key, label], i) => (
                      <li key={key} className={i < current ? "done" : i === current ? "current" : undefined}>
                        {label}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : info.oneClickEnabled ? (
                <div className="card__foot">The database is backed up before anything changes; your settings are kept.</div>
              ) : null}
            </Card>
          ) : null}

          {info.error && (
            <Notice tone="warn" title="Couldn’t check for new releases">
              {info.error.split(". ")[0].replace(/\.$/, "")}.
            </Notice>
          )}
          {info.updateAvailable && !info.oneClickEnabled && (
            <Notice tone="warn" title="One-click updates aren’t set up">
              Add the updater service to this installation’s Docker Compose file, or run update.sh on the host.
            </Notice>
          )}
          {status?.phase === "restarting" && (
            <Notice tone="busy" title="The panel is restarting">
              This page picks up the progress again once the API is back.
            </Notice>
          )}
          {status?.state === "succeeded" && (
            <Notice tone="ok" title={`Updated to v${status.version || info.latestVersion || ""}`}>
              The panel passed its health checks. The database backup was kept.
            </Notice>
          )}
          {status?.state === "failed" && (
            <Notice tone="bad" title="The update didn’t finish">
              {status.error || "See the log below. The previous version was restored where possible."}
            </Notice>
          )}
          {!!status?.logs?.length && status.state !== "idle" && (
            <Card flush>
              <details className="disclosure" open={status.state === "failed"}>
                <summary>Updater log · {status.logs.length} lines</summary>
                <pre className="code-block">{status.logs.join("\n")}</pre>
              </details>
            </Card>
          )}

          {info.updateAvailable && info.body ? (
            <Card
              title={info.releaseName || `v${info.latestVersion}`}
              description={info.publishedAt ? `Released ${new Date(info.publishedAt).toLocaleDateString(undefined, { dateStyle: "long" })}` : undefined}
              actions={
                <a className="card-link" href={info.releaseUrl} target="_blank" rel="noreferrer">
                  GitHub <ExternalLink />
                </a>
              }
            >
              <pre className="code-block" style={{ border: 0, padding: 0, background: "none", maxHeight: 480 }}>
                {info.body}
              </pre>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
