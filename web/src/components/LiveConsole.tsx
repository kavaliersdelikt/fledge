"use client";
import { json } from "@/lib/api";
import { ArrowDown } from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ErrorNotice, Status } from "./shared";
import type { Line, LiveServer } from "./useLiveServer";

const levelOf = (text: string) =>
  /\b(ERROR|SEVERE|FATAL)\b|Exception/.test(text) ? "is-error" : /\bWARN(ING)?\b/.test(text) ? "is-warn" : "";

const LogLine = memo(function LogLine({ line, fresh }: { line: Line; fresh: boolean }) {
  const cls = `console__line${fresh ? " is-new" : ""}${line.kind === "echo" ? " is-echo" : ` ${levelOf(line.text)}`}`;
  const ts = /^(\[\d{2}:\d{2}:\d{2}\]\s?)(.*)$/.exec(line.text);
  return (
    <span className={cls}>
      {ts ? (
        <>
          <span className="ts">{ts[1]}</span>
          {ts[2]}
        </>
      ) : (
        line.text || " "
      )}
    </span>
  );
});

export default function LiveConsole({
  id,
  live,
  minecraft,
  reachable,
}: {
  id: string;
  live: LiveServer;
  minecraft: boolean;
  reachable: boolean;
}) {
  const { connection, lines, echo } = live;
  const [command, setCommand] = useState(""),
    [ack, setAck] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [following, setFollowing] = useState(true),
    [history, setHistory] = useState<string[]>([]),
    [cursor, setCursor] = useState(-1);
  const box = useRef<HTMLPreElement>(null);
  // Lines that existed when the console opened don't animate in again.
  const seen = useRef(lines.length ? lines[lines.length - 1].id : 0);
  const connected = connection === "connected";

  useEffect(() => {
    if (following && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, following]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const value = command.trim();
    if (!value) return;
    setPending(true);
    setError("");
    setAck("");
    try {
      const result = (await json("POST", `/servers/${id}/console`, { command: value })) as { output?: string };
      echo(value);
      setAck(result.output || "");
      setHistory((h) => [value, ...h.filter((x) => x !== value)].slice(0, 50));
      setCursor(-1);
      setCommand("");
      setFollowing(true);
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <section className="console" aria-label="Console" style={{ position: "relative" }}>
        {connected ? null : (
          <div className="console__bar">
            <Status value={reachable ? "pending" : "disconnected"} label={reachable ? "Connecting to the server log" : "Node offline"} />
          </div>
        )}
        <pre
          ref={box}
          className="console__lines"
          aria-label="Server log"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (atBottom !== following) setFollowing(atBottom);
          }}
        >
          {lines.length ? (
            lines.map((line) => <LogLine key={line.id} line={line} fresh={line.id > seen.current} />)
          ) : connected ? (
            <span className="console__placeholder">No output yet.</span>
          ) : null}
        </pre>
        {!following && lines.length ? (
          <Button
            size="sm"
            className="console__jump"
            onClick={() => {
              setFollowing(true);
              box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
            }}
          >
            <ArrowDown /> Jump to latest
          </Button>
        ) : null}
        {ack ? (
          <div className="console__note" role="status">
            <strong>{minecraft ? "rcon" : "stdin"}</strong>
            {ack}
          </div>
        ) : null}
        <form className="console__in" onSubmit={send}>
          <span aria-hidden="true">›</span>
          <label className="sr-only" htmlFor={`console-${id}`}>
            {minecraft ? "Minecraft command" : "Console input"}
          </label>
          <input
            id={`console-${id}`}
            value={command}
            autoComplete="off"
            spellCheck={false}
            maxLength={1024}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && history.length) {
                e.preventDefault();
                const next = Math.min(cursor + 1, history.length - 1);
                setCursor(next);
                setCommand(history[next]);
              } else if (e.key === "ArrowDown" && cursor >= 0) {
                e.preventDefault();
                const next = cursor - 1;
                setCursor(next);
                setCommand(next >= 0 ? history[next] : "");
              }
            }}
            placeholder={!reachable || !connected ? "Console unavailable" : minecraft ? "list" : "Type a line and press Enter"}
            disabled={!reachable || !connected}
            readOnly={pending}
          />
          <Button type="submit" size="sm" busy={pending} disabled={!reachable || !connected || !command.trim()}>
            Send
          </Button>
        </form>
      </section>
      <ErrorNotice message={error || live.error} />
    </div>
  );
}
