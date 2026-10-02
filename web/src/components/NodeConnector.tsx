"use client";
import { API, json, request, type Node as NodeInfo } from "@/lib/api";
import { useEffect, useMemo, useState } from "react";
import { CopyButton, Secret, useConfirm } from "./feedback";
import { Button, ErrorNotice, Notice, Segmented, Skeleton } from "./shared";

type Enrollment = { nodeId: string; token: string; expiresInSeconds: number };
const repository = "kavaliersdelikt/fledge";
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";

export default function NodeConnector({ initialNodeId, onIssued }: { initialNodeId?: string; onIssued?: () => void }) {
  const confirm = useConfirm();
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null),
    [nodeId, setNodeId] = useState(""),
    [platform, setPlatform] = useState<"linux" | "windows">("linux"),
    [token, setToken] = useState<Enrollment | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const apiUrl = API.replace(/\/+$/, "");

  useEffect(() => {
    request<NodeInfo[]>("/nodes")
      .then((values) => {
        setNodes(values);
        setNodeId((current) =>
          values.some((n) => n.id === current)
            ? current
            : values.some((n) => n.id === initialNodeId)
              ? initialNodeId!
              : (values.find((n) => n.status !== "connected") || values[0])?.id || "",
        );
      })
      .catch((e) => {
        setNodes([]);
        setError((e as Error).message);
      });
  }, [initialNodeId]);

  const command = useMemo(() => {
    if (!token || !/^https?:\/\/[A-Za-z0-9.:/_-]+$/.test(apiUrl)) return "";
    const raw = `https://raw.githubusercontent.com/${repository}/main/agent/`;
    const insecure = apiUrl.startsWith("http://");
    if (platform === "linux")
      return [
        `curl --proto '=https' --tlsv1.2 -fsSL \\`,
        `  ${shellQuote(raw + "connect.sh")} \\`,
        `  -o /tmp/fledge-connect.sh \\`,
        `  && sudo sh /tmp/fledge-connect.sh \\`,
        `    --api ${shellQuote(apiUrl)} \\`,
        `    --node ${shellQuote(token.nodeId)} \\`,
        `    --repo ${shellQuote(repository)}${insecure ? " \\\n    --allow-insecure-http" : ""}`,
      ].join("\n");
    return `$p=Join-Path $env:TEMP 'fledge-connect.ps1'; Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(raw + "connect-wsl.ps1")} -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -ApiUrl ${psQuote(apiUrl)} -NodeId ${psQuote(token.nodeId)} -Repository ${psQuote(repository)}${insecure ? " -AllowInsecureHttp" : ""}; if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'WSL connector failed.' }; Remove-Item -LiteralPath $p -Force`;
  }, [token, apiUrl, platform]);

  async function issue() {
    const selected = nodes?.find((n) => n.id === nodeId);
    if (!selected) return;
    if (
      selected.status === "connected" &&
      !(await confirm(`${selected.name} is online. A new token replaces its credential and disconnects the running agent.`, {
        confirmLabel: "Replace credential",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      setToken((await json("POST", `/nodes/${nodeId}/enrollment`)) as Enrollment);
      onIssued?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!nodes) return <Skeleton rows={3} />;
  if (!nodes.length)
    return error ? (
      <ErrorNotice message={error} />
    ) : (
      <Notice title="Add a node first">Close this panel and use “Add node” to describe the host, then come back here.</Notice>
    );

  return (
    <div className="form">
      <div className="form-group">
        <h3><span className="step is-done">1</span>Choose the node</h3>
        <select
          className="input select"
          aria-label="Node"
          value={nodeId}
          onChange={(e) => {
            setNodeId(e.target.value);
            setToken(null);
          }}
        >
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} · {n.location} {n.status === "connected" ? "(online)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <h3><span className={`step${token ? " is-done" : ""}`}>2</span>Create a one-time token</h3>
        <p className="muted small">The connector asks for it in a hidden prompt, so it never appears in your shell history.</p>
        {token ? (
          <Secret label={`Token · expires in ${Math.floor(token.expiresInSeconds / 60)} minutes`} value={token.token} />
        ) : (
          <div>
            <Button variant="primary" busy={busy} onClick={issue}>
              Create token
            </Button>
          </div>
        )}
        <ErrorNotice message={error} />
      </div>
      <div className="form-group">
        <h3><span className="step">3</span>Run the connector on the host</h3>
        <Segmented
          label="Host operating system"
          value={platform}
          onChange={setPlatform}
          options={[
            { value: "linux", label: "Linux" },
            { value: "windows", label: "Windows (WSL2)" },
          ]}
        />
        {token ? (
          command ? (
            <>
              <div className="command">
                <pre className="code-block code-block--command">{command}</pre>
                <CopyButton value={command} size="icon" label="Copy command" />
              </div>
            </>
          ) : (
            <Notice tone="warn">
              The panel’s API address ({apiUrl}) can’t be used in a connector command. Set NEXT_PUBLIC_API_URL to a reachable URL.
            </Notice>
          )
        ) : (
          <p className="faint small">The command appears once you’ve created a token.</p>
        )}
        <p className="faint small">
          Downloads the checksum-verified agent from the latest {repository} release.
          {platform === "windows" ? " Needs WSL2 with Ubuntu and Docker Desktop’s WSL integration; the agent runs inside Linux." : " Needs Docker Engine and root access."}
        </p>
      </div>
    </div>
  );
}
