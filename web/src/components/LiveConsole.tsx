"use client";
import { json, type QuickCommand } from "@/lib/api";
import { ArrowDown, Plus, X } from "lucide-react";
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

/** Browser storage can be missing or blocked; the console works the same without it. */
function readList(key: string): unknown[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
function writeList(key: string, value: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
const asCommands = (list: unknown[]): QuickCommand[] =>
  list.filter((q): q is QuickCommand => !!q && typeof (q as QuickCommand).label === "string" && typeof (q as QuickCommand).command === "string").slice(0, 20);

export default function LiveConsole({
  id,
  live,
  minecraft,
  reachable,
  quickCommands = [],
  canManage = false,
}: {
  id: string;
  live: LiveServer;
  minecraft: boolean;
  reachable: boolean;
  /** Buttons from the server's template. */
  quickCommands?: QuickCommand[];
  /** Whether this person may add and remove their own saved commands. */
  canManage?: boolean;
}) {
  const { connection, lines, echo } = live;
  const [command, setCommand] = useState(""),
    [ack, setAck] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [following, setFollowing] = useState(true),
    [history, setHistory] = useState<string[]>([]),
    [cursor, setCursor] = useState(-1),
    [saved, setSaved] = useState<QuickCommand[]>([]),
    [adding, setAdding] = useState(false),
    [draft, setDraft] = useState({ label: "", command: "" });
  const historyKey = `fledge:console-history:${id}`,
    savedKey = `fledge:console-saved:${id}`;
  const box = useRef<HTMLPreElement>(null);
  // Lines that existed when the console opened don't animate in again.
  const seen = useRef(lines.length ? lines[lines.length - 1].id : 0);
  const connected = connection === "connected";

  useEffect(() => {
    if (following && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, following]);
  useEffect(() => {
    setHistory(readList(historyKey).filter((x): x is string => typeof x === "string").slice(0, 50));
    setSaved(asCommands(readList(savedKey)));
  }, [historyKey, savedKey]);

  function send(e: FormEvent) {
    e.preventDefault();
    void run(command.trim(), true);
  }

  async function run(value: string, clear: boolean) {
    if (!value) return;
    setPending(true);
    setError("");
    setAck("");
    try {
      const result = (await json("POST", `/servers/${id}/console`, { command: value })) as { output?: string };
      echo(value);
      setAck(result.output || "");
      setHistory((h) => {
        const next = [value, ...h.filter((x) => x !== value)].slice(0, 50);
        writeList(historyKey, next);
        return next;
      });
      setCursor(-1);
      if (clear) setCommand("");
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
        {quickCommands.length || saved.length || canManage ? (
          <div className="console__quick" role="group" aria-label="Quick commands">
            {quickCommands.map((q, i) => (
              <button key={`t${i}`} type="button" className="btn btn--secondary btn--sm" title={q.command} disabled={!reachable || !connected || pending} onClick={() => void run(q.command, false)}>
                {q.label}
              </button>
            ))}
            {saved.map((q, i) => (
              <span key={`s${i}`} className="console__chip">
                <button type="button" className="btn btn--secondary btn--sm" title={q.command} disabled={!reachable || !connected || pending} onClick={() => void run(q.command, false)}>
                  {q.label}
                </button>
                {canManage ? (
                  <button
                    type="button"
                    className="console__chip-x"
                    aria-label={`Remove ${q.label}`}
                    onClick={() => {
                      const next = saved.filter((_, j) => j !== i);
                      setSaved(next);
                      writeList(savedKey, next);
                    }}
                  >
                    <X />
                  </button>
                ) : null}
              </span>
            ))}
            {canManage && !adding ? (
              <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                <Plus /> Add command
              </Button>
            ) : null}
          </div>
        ) : null}
        {adding ? (
          <form
            className="console__add"
            onSubmit={(e) => {
              e.preventDefault();
              const label = draft.label.trim().slice(0, 40),
                cmd = draft.command.trim().slice(0, 256);
              if (!label || !cmd) return;
              const next = [...saved, { label, command: cmd }].slice(0, 20);
              setSaved(next);
              writeList(savedKey, next);
              setDraft({ label: "", command: "" });
              setAdding(false);
            }}
          >
            <input className="input" aria-label="Button label" placeholder="Label" maxLength={40} required autoFocus value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
            <input className="input mono" aria-label="Command" placeholder="Command" maxLength={256} required value={draft.command} onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value.replace(/[\r\n]/g, "") }))} />
            <Button type="submit" size="sm" variant="primary">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </form>
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
