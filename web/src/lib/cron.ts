/** Small helpers for showing and building common cron expressions. Anything unusual is shown as written. */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");
const int = (v: string) => (/^\d+$/.test(v) ? Number(v) : NaN);

function dayList(field: string): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      if (a > b || a > 7 || b > 7) return null;
      for (let d = a; d <= b; d++) out.add(d % 7);
    } else {
      const n = int(part);
      if (!(n >= 0 && n <= 7)) return null;
      out.add(n % 7);
    }
  }
  return [...out].sort((x, y) => x - y);
}

function join(names: string[]) {
  return names.length < 2 ? names[0] || "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "0 4 * * *" in Europe/Berlin becomes "Every day at 04:30 Europe/Berlin". */
export function describeCron(expr: string, tz = ""): string {
  const raw = expr.trim();
  const f = raw.split(/\s+/);
  if (f.length !== 5) return raw;
  const [min, hour, dom, mon, dow] = f;
  const zone = tz ? ` ${tz}` : "";
  const minute = int(min), h = int(hour);
  const timed = minute >= 0 && minute <= 59 && h >= 0 && h <= 23;
  if (mon === "*" && dom === "*" && dow === "*") {
    if (/^\*\/\d+$/.test(min) && hour === "*") {
      const n = Number(min.slice(2));
      return n === 1 ? "Every minute" : `Every ${n} minutes`;
    }
    if (minute >= 0 && minute <= 59 && hour === "*") return minute === 0 ? "Every hour" : `Every hour at minute ${minute}`;
    if (minute >= 0 && minute <= 59 && /^\*\/\d+$/.test(hour)) {
      const n = Number(hour.slice(2));
      return `Every ${n === 1 ? "hour" : `${n} hours`}${minute ? ` at minute ${minute}` : ""}`;
    }
    if (timed) return `Every day at ${pad(h)}:${pad(minute)}${zone}`;
  }
  if (timed && mon === "*" && dom === "*" && dow !== "*") {
    const days = dayList(dow);
    if (days && days.length) {
      const time = `${pad(h)}:${pad(minute)}${zone}`;
      if (days.join() === "1,2,3,4,5") return `Weekdays at ${time}`;
      if (days.join() === "0,6") return `Weekends at ${time}`;
      return `Every ${join(days.map((d) => DAYS[d]))} at ${time}`;
    }
  }
  if (timed && mon === "*" && dow === "*" && int(dom) >= 1 && int(dom) <= 31) return `On day ${int(dom)} of every month at ${pad(h)}:${pad(minute)}${zone}`;
  return raw;
}

export function describeInterval(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

export type Preset = "daily" | "hours" | "weekdays" | "weekly";

/** Builds the expression for a preset. `time` is "HH:MM", `dow` 0 (Sunday) to 6. */
export function buildCron(preset: Preset, opts: { time: string; every: number; dow: number }): string {
  const [hh, mm] = opts.time.split(":").map((x) => Number(x));
  const m = Number.isFinite(mm) ? mm : 0, h = Number.isFinite(hh) ? hh : 0;
  switch (preset) {
    case "hours":
      return `${m} */${Math.max(1, Math.min(23, Math.round(opts.every) || 1))} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${opts.dow}`;
    default:
      return `${m} ${h} * * *`;
  }
}

export const weekdayNames = DAYS;
