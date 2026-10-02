"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A number that rolls to its new value when it changes. The first render shows
 * the value as-is — numbers only move when the data actually moves.
 */
export function Num({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  duration = 550,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
}) {
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    if (!Number.isFinite(value) || !Number.isFinite(from) || from === value || prefersReducedMotion()) {
      current.current = value;
      setShown(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      const next = from + (value - from) * eased;
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return <>{format(shown)}</>;
}

/**
 * Positions a `.glide` container's highlight (its ::before) over the child that
 * matches `selector`, so selection slides instead of jumping. Re-measures when
 * `key` changes and when the container resizes. Pass the element from a
 * callback ref so containers that mount late (portals) are picked up.
 */
export function useGlide(box: HTMLElement | null, selector: string, key: unknown) {
  useIsoLayoutEffect(() => {
    if (!box) return;
    const place = () => {
      const target = box.querySelector<HTMLElement>(selector);
      if (!target) {
        box.dataset.glide = "off";
        return;
      }
      box.style.setProperty("--glide-x", `${target.offsetLeft}px`);
      box.style.setProperty("--glide-y", `${target.offsetTop}px`);
      box.style.setProperty("--glide-w", `${target.offsetWidth}px`);
      box.style.setProperty("--glide-h", `${target.offsetHeight}px`);
      box.dataset.glide = "on";
    };
    place();
    // Enable transitions only after the first placement so it doesn't fly in from 0,0.
    const frame = requestAnimationFrame(() => box.setAttribute("data-glide-ready", ""));
    const observer = new ResizeObserver(place);
    observer.observe(box);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [box, selector, key]);
}
