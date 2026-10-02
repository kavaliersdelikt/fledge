"use client";
import { Tooltip } from "@base-ui/react/tooltip";
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";

/** Small hover tooltip. `children` must be a single element that can take a ref. */
export function Tip({ content, children }: { content: ReactNode; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} delay={80} />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8} className="z-50">
          <Tooltip.Popup className="tip">{content}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const TipProvider = Tooltip.Provider;

export type Point = { t: number; v: number };

/**
 * A single-series trend line. Hovering shows the value under the pointer.
 * The vertical domain is the limit (`max`), so height always means the same
 * share of what the server is allowed to use.
 */
export function Sparkline({
  points,
  max,
  height = 44,
  format,
  label,
  empty = "Collecting samples…",
}: {
  points: Point[];
  max: number;
  height?: number;
  format: (v: number) => string;
  label: string;
  empty?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [fresh, setFresh] = useState(false);
  const clip = useId();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const last = points[points.length - 1];
  useEffect(() => {
    if (!last) return;
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 700);
    return () => clearTimeout(t);
  }, [last?.t]); // eslint-disable-line react-hooks/exhaustive-deps

  if (points.length < 2)
    return (
      <div className="spark" style={{ height }} ref={box} onPointerLeave={() => setHoverT(null)}>
        <span className="spark__empty">{empty}</span>
      </div>
    );

  const pad = 4;
  const t0 = points[0].t;
  const span = Math.max(1, last.t - t0);
  const top = Math.max(max, ...points.map((p) => p.v)) || 1;
  const x = (p: Point) => ((p.t - t0) / span) * width;
  const y = (p: Point) => pad + (1 - Math.min(1, p.v / top)) * (height - pad * 2);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join("");
  const area = `${line}L${width},${height}L0,${height}Z`;
  // Hover tracks a timestamp, not an index, so the tooltip stays on the same
  // sample while new ones push older ones out of the window.
  const active =
    hoverT === null
      ? null
      : points.reduce((best, p) => (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT) ? p : best), points[0]);

  return (
    <div
      className="spark"
      style={{ height }}
      ref={box}
      role="img"
      aria-label={`${label}: ${format(last.v)} now`}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const rel = (e.clientX - rect.left) / rect.width;
        const target = t0 + rel * span;
        setHoverT(points.reduce((best, p) => (Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best), points[0]).t);
      }}
      onPointerLeave={() => setHoverT(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <defs>
            <clipPath id={clip}>
              <rect x="0" y="0" width={width} height={height} />
            </clipPath>
            <linearGradient id={`${clip}-wash`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.16" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line className="spark__grid" x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} />
          <g clipPath={`url(#${clip})`}>
            <path className="spark__area" d={area} fill={`url(#${clip}-wash)`} />
            <path className="spark__line" d={line} />
          </g>
          {active ? (
            <>
              <line className="spark__cross" x1={x(active)} x2={x(active)} y1={0} y2={height} />
              <circle className="spark__end" cx={x(active)} cy={y(active)} r={4} />
            </>
          ) : (
            <circle className={`spark__end${fresh ? " is-fresh" : ""}`} cx={x(last)} cy={y(last)} r={3.5} />
          )}
        </svg>
      )}
      {active ? (
        <span className="spark__tip" style={{ left: Math.min(Math.max(x(active), 40), width - 40) }}>
          {format(active.v)}
          <small>{new Date(active.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>
        </span>
      ) : null}
    </div>
  );
}

export function severity(ratio: number) {
  return ratio >= 0.9 ? "bad" : ratio >= 0.75 ? "warn" : "ok";
}

/** Used-of-limit readout with a severity-coloured bar. */
export function UsageBar({
  used,
  limit,
  text,
  sub,
  label,
}: {
  used: number | null;
  limit: number;
  text: ReactNode;
  sub?: ReactNode;
  label: string;
}) {
  if (used === null) return <span className="faint">—</span>;
  const ratio = limit > 0 ? used / limit : 0;
  return (
    <div className="usage">
      <span className="usage__text">
        {text}
        {sub ? <small>{sub}</small> : null}
      </span>
      <div
        className={`meter meter--${severity(ratio)}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
    </div>
  );
}

export type Segment = { key: string; value: number; label: string; detail?: string };

/** Part-to-whole bar: one segment per item, the remainder as track. */
export function StackedBar({ segments, total, label }: { segments: Segment[]; total: number; label: string }) {
  const used = segments.reduce((a, s) => a + s.value, 0);
  // Tooltips are hover-only, so the full breakdown also goes in the label.
  const summary = segments.length
    ? `${label}: ${segments.map((s) => `${s.label}${s.detail ? ` (${s.detail})` : ""}`).join(", ")}`
    : `${label}: nothing reserved`;
  return (
    <div className="stacked" role="img" aria-label={summary}>
      {segments.map((s, i) => (
        <Tip
          key={s.key}
          content={
            <>
              {s.label}
              {s.detail ? <small>{s.detail}</small> : null}
            </>
          }
        >
          <span
            className="stacked__seg"
            style={{ flexGrow: 0, flexBasis: `${(s.value / Math.max(total, used)) * 100}%`, ["--i" as string]: i }}
          />
        </Tip>
      ))}
      {used < total ? <span className="stacked__rest" /> : null}
    </div>
  );
}
