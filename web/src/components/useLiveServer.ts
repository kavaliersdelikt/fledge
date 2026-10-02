"use client";
import { API } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from "react";

export type Connection = "connecting" | "connected" | "disconnected";
export type Line = { id: number; text: string; kind: "out" | "echo" };
export type Sample = { t: number; cpu: number; mem: number; memLimit: number };

type Frame = {
  type: "status" | "log" | "sample";
  connected?: boolean;
  data?: string;
  cpuPercent?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  sampledAt?: string;
};

const MAX_LINES = 1000;
const MAX_SAMPLES = 80;

/**
 * One live connection per server page. Shared by the resource panel and the
 * console so log history survives switching tabs.
 */
export function useLiveServer(id: string, reachable: boolean) {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lines, setLines] = useState<Line[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState("");
  const nextId = useRef(0);
  const partial = useRef("");

  // Samples arrive from the live stream (including a replay of the last couple of
  // minutes on connect) and from the polled server record, so merge by time.
  const addSample = useCallback((s: Sample) => {
    if (!Number.isFinite(s.t)) return;
    setSamples((xs) => {
      if (xs.some((x) => Math.abs(x.t - s.t) < 500)) return xs;
      const next = [...xs, s];
      if (xs.length && s.t < xs[xs.length - 1].t) next.sort((a, b) => a.t - b.t);
      return next.slice(-MAX_SAMPLES);
    });
  }, []);

  // Frames arrive one message at a time (hundreds on connect), so collect
  // complete lines and render them in batches instead of once per frame.
  const pending = useRef<Line[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    flushTimer.current = null;
    const batch = pending.current;
    pending.current = [];
    if (batch.length) setLines((xs) => [...xs, ...batch].slice(-MAX_LINES));
  }, []);
  const append = useCallback(
    (text: string) => {
      const parts = (partial.current + text).split(/\r?\n/);
      partial.current = parts.pop() ?? "";
      if (!parts.length) return;
      for (const t of parts) pending.current.push({ id: ++nextId.current, text: t, kind: "out" });
      if (!flushTimer.current) flushTimer.current = setTimeout(flush, 100);
    },
    [flush],
  );

  const echo = useCallback((text: string) => {
    setLines((xs) => [...xs, { id: ++nextId.current, text: `> ${text}`, kind: "echo" as const }].slice(-MAX_LINES));
  }, []);

  useEffect(() => {
    setLines([]);
    setSamples([]);
    partial.current = "";
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
      ws = new WebSocket(`${API.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/api/servers/${id}/live`);
      ws.onopen = () => {
        // The API replays recent output on every connect; start clean so a
        // reconnect doesn't duplicate what's already on screen.
        if (attempt > 0) {
          pending.current = [];
          partial.current = "";
          setLines([]);
        }
        attempt = 0;
        setError("");
      };
      ws.onmessage = (e) => {
        try {
          const f = JSON.parse(e.data) as Frame;
          if (f.type === "status") {
            setConnection(f.connected ? "connected" : "disconnected");
          } else if (f.type === "log" && typeof f.data === "string") {
            const raw = atob(f.data);
            append(decoder.decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)), { stream: true }));
          } else if (
            f.type === "sample" &&
            typeof f.cpuPercent === "number" &&
            typeof f.memoryBytes === "number" &&
            typeof f.memoryLimitBytes === "number"
          ) {
            addSample({
              t: f.sampledAt ? Date.parse(f.sampledAt) : Date.now(),
              cpu: f.cpuPercent,
              mem: f.memoryBytes,
              memLimit: f.memoryLimitBytes,
            });
          }
        } catch {
          setError("Couldn’t read live data from the node.");
        }
      };
      ws.onclose = () => {
        setConnection("disconnected");
        decoder = new TextDecoder();
        if (!stopped) retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4)));
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      pending.current = [];
      ws?.close();
    };
  }, [id, reachable, append, addSample]);

  return { connection, lines, samples, error, addSample, echo };
}

export type LiveServer = ReturnType<typeof useLiveServer>;
