"use client";
import { API,json } from "@/lib/api";
import { Send } from "lucide-react";
import { useEffect,useRef,useState,type FormEvent } from "react";
import { Notice } from "./shared";

type Frame = {
  type: "status" | "log" | "sample";
  connected?: boolean;
  data?: string;
  cpuPercent?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  sampledAt?: string;
};
export default function LiveConsole({
  id,
  minecraft,
  reachable,
}: {
  id: string;
  minecraft: boolean;
  reachable: boolean;
}) {
  const [output, setOutput] = useState(""),
    [connection, setConnection] = useState<
      "connecting" | "connected" | "disconnected"
    >("connecting");
  const [sample, setSample] = useState<Frame | null>(null),
    [now, setNow] = useState(Date.now()),
    [command, setCommand] = useState(""),
    [commandResult, setCommandResult] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const [following, setFollowing] = useState(true);
  const tail = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setOutput("");
    setSample(null);
    setConnection("connecting");
    let stopped = false,
      ws: WebSocket | null = null,
      retry: ReturnType<typeof setTimeout> | undefined,
      attempt = 0,
      decoder = new TextDecoder();
    const connect = () => {
      if (stopped || !reachable) {
        setConnection("disconnected");
        return;
      }
      setConnection("connecting");
      ws = new WebSocket(
        `${API.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/api/servers/${id}/live`,
      );
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (e) => {
        try {
          const f = JSON.parse(e.data) as Frame;
          if (f.type === "status") {
            setConnection(f.connected ? "connected" : "disconnected");
            if (!f.connected) setSample(null);
          } else if (f.type === "log" && typeof f.data === "string") {
            const raw = atob(f.data),
              bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
            const text = decoder.decode(bytes, { stream: true });
            setOutput((prev) => (prev + text).slice(-120000));
          } else if (
            f.type === "sample" &&
            typeof f.cpuPercent === "number" &&
            typeof f.memoryBytes === "number" &&
            typeof f.memoryLimitBytes === "number"
          ) {
            setSample(f);
          }
        } catch {
          setError("Unable to read live data.");
        }
      };
      ws.onclose = () => {
        setConnection("disconnected");
        setSample(null);
        decoder = new TextDecoder();
        if (!stopped) {
          retry = setTimeout(
            connect,
            Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4)),
          );
        }
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [id, reachable]);
  useEffect(() => {
    if (following)
      tail.current?.scrollTo({
        top: tail.current.scrollHeight,
        behavior: "smooth",
      });
  }, [output, following]);
  const fresh =
    connection === "connected" &&
    sample?.sampledAt &&
    now - Date.parse(sample.sampledAt) < 15000;
  async function send(e: FormEvent) {
    e.preventDefault();
    const value = command.trim();
    if (!value) return;
    setPending(true);
    setError("");
    setCommandResult("");
    try {
      const result = (await json("POST", `/servers/${id}/console`, {
        command: value,
      })) as { output?: string };
      setOutput((prev) => (prev + `\n> ${value}\n`).slice(-120000));
      setCommandResult(result.output || "Input sent to the server.");
      setCommand("");
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="section" aria-label="Live console">
      <div className="section-title">
        <div>
          <h2>Live console</h2>
          <p className="muted" role="status">
            {connection === "connected"
              ? "Connected — live Docker logs and resource samples"
              : connection === "connecting"
                ? "Connecting…"
                : "No live connection; retrying."}
          </p>
        </div>
      </div>
      <div className="detail-stats">
        <div>
          <span>CPU (Docker)</span>
          <strong>{fresh ? `${sample!.cpuPercent!.toFixed(2)} %` : "—"}</strong>
        </div>
        <div>
          <span>RAM (Docker)</span>
          <strong>
            {fresh
              ? `${(sample!.memoryBytes! / 1048576).toFixed(1)} / ${(sample!.memoryLimitBytes! / 1048576).toFixed(1)} MiB`
              : "—"}
          </strong>
        </div>
        <div>
          <span>Sample time</span>
          <strong>
            {fresh
              ? new Date(sample!.sampledAt!).toLocaleTimeString("en-US")
              : "No recent sample"}
          </strong>
        </div>
      </div>
      <div className="console-stream">
        <div className="console-toolbar">
          <span
            className={`signal ${connection !== "connected" ? "off" : ""}`}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </span>
          <span>
            {connection === "connected" ? "LIVE STREAM" : "AWAITING CONNECTION"}
          </span>
          <button
            type="button"
            className="btn"
            aria-pressed={following}
            onClick={() => setFollowing(!following)}
          >
            {following ? "Pause scrolling" : "Follow output"}
          </button>
        </div>
        <pre
          ref={tail}
          className="console"
          aria-label="Live server log"
          style={{
            maxHeight: 480,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {output || "Waiting for log data…"}
          {connection === "connected" && (
            <span className="console-caret" aria-hidden="true" />
          )}
        </pre>
        {commandResult && (
          <div className="console-ack" role="status">
            <span>{minecraft ? "RCON" : "STDIN"}</span>
            {commandResult}
          </div>
        )}
        <form className="console-input" onSubmit={send}>
          <label className="sr-only" htmlFor={`console-command-${id}`}>
            {minecraft ? "Minecraft command" : "Server console input"}
          </label>
          <span className="console-prompt" aria-hidden="true">
            ›
          </span>
          <input
            id={`console-command-${id}`}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            required
            maxLength={1024}
            placeholder={
              minecraft ? "say Hello" : "Enter a command or console input…"
            }
            disabled={!reachable || connection !== "connected" || pending}
          />
          <button
            className="btn primary"
            type="submit"
            disabled={
              !reachable ||
              connection !== "connected" ||
              pending ||
              !command.trim()
            }
            aria-label="Send console input"
          >
            {pending ? (
              "Sending…"
            ) : (
              <>
                <Send size={15} />
                Send
              </>
            )}
          </button>
        </form>
        {error && <Notice status="danger" className="console-error">{error}</Notice>}
        {!minecraft && (
          <p className="console-caption">
            Sends one line to the container’s standard input. The server
            software must support console input this way.
          </p>
        )}
      </div>
    </section>
  );
}
