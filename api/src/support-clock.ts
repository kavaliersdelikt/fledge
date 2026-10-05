export type BusinessHours = {
  timezone: string;
  weekly: Record<string, [number, number][]>;
  holidays: string[];
};
function localParts(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const day = `${v.year}-${v.month}-${v.day}`;
  return {
    day,
    weekday: new Date(day + "T12:00:00Z").getUTCDay(),
    minute: Number(v.hour) * 60 + Number(v.minute),
  };
}
export function businessClock(hours: BusinessHours) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: hours.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = (time: number) => {
    const v = Object.fromEntries(
      formatter.formatToParts(new Date(time)).map((p) => [p.type, p.value]),
    );
    const day = `${v.year}-${v.month}-${v.day}`,
      minute = Number(v.hour) * 60 + Number(v.minute);
    return {
      day,
      minute,
      weekday: new Date(day + "T12:00:00Z").getUTCDay(),
      localTime: Date.parse(day + "T00:00:00Z") + minute * 60000,
    };
  };
  const holidays = new Set(hours.holidays);
  let cachedHour = Number.NaN,
    cached = parts(0),
    regular = false;
  return (time: number) => {
    const hour = Math.floor(time / 3600000);
    if (hour !== cachedHour) {
      cachedHour = hour;
      cached = parts(hour * 3600000);
      regular =
        parts((hour + 1) * 3600000).localTime - cached.localTime === 3600000;
    }
    // Use minute arithmetic only when the whole UTC hour has a stable local offset.
    // Transition hours fall back to Intl, including Lord Howe's half-hour DST change.
    if (!regular) {
      const p = parts(time);
      return (
        !holidays.has(p.day) &&
        (hours.weekly[String(p.weekday)] || []).some(
          ([a, b]) => p.minute >= a && p.minute < b,
        )
      );
    }
    const total = cached.minute + Math.floor((time - hour * 3600000) / 60000),
      shift = Math.floor(total / 1440),
      minute = total % 1440;
    const day = shift
      ? new Date(Date.parse(cached.day + "T00:00:00Z") + shift * 86400000)
          .toISOString()
          .slice(0, 10)
      : cached.day;
    return (
      !holidays.has(day) &&
      (hours.weekly[String((cached.weekday + shift) % 7)] || []).some(
        ([a, b]) => minute >= a && minute < b,
      )
    );
  };
}
/** Walk elapsed UTC minutes, evaluating local business windows. DST repeats and gaps stay correct. */
export function addBusinessMinutes(
  start: Date,
  minutes: number,
  hours: BusinessHours,
): Date {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 525600)
    throw Error("Invalid business duration");
  if (!Object.values(hours.weekly).some((w) => w.length))
    throw Error("At least one business window is required");
  const open = businessClock(hours);
  let t = start.getTime(),
    left = Math.ceil(minutes),
    iterations = 0;
  while (left > 0) {
    if (++iterations > 5 * 366 * 1440)
      throw Error("Business deadline exceeds five years");
    if (open(t)) left--;
    t += 60000;
  }
  return new Date(t);
}
export function businessMinutesBetween(
  start: Date,
  end: Date,
  hours: BusinessHours,
): number {
  const open = businessClock(hours);
  let n = 0;
  for (let t = start.getTime(); t < end.getTime(); t += 60000) if (open(t)) n++;
  return n;
}
export function validateHours(value: any): BusinessHours {
  if (
    !value ||
    typeof value.timezone !== "string" ||
    !value.weekly ||
    typeof value.weekly !== "object" ||
    !Array.isArray(value.holidays)
  )
    throw Error("Expected timezone, weekly windows and holidays");
  localParts(new Date(), value.timezone);
  const weekly: Record<string, [number, number][]> = Object.fromEntries(
    Array.from({ length: 7 }, (_, day) => {
      const windows = value.weekly[String(day)] || [];
      if (!Array.isArray(windows) || windows.length > 4)
        throw Error("At most four windows per day");
      let last = 0;
      for (const w of windows) {
        if (
          !Array.isArray(w) ||
          w.length !== 2 ||
          !w.every(Number.isInteger) ||
          w[0] < last ||
          w[0] < 0 ||
          w[1] > 1440 ||
          w[1] <= w[0]
        )
          throw Error(
            "Business windows must be ordered, disjoint minute ranges",
          );
        last = w[1];
      }
      return [String(day), windows];
    }),
  );
  if (
    !Object.values(weekly).some((w) => w.length) ||
    value.holidays.length > 366 ||
    value.holidays.some(
      (d: any) => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d),
    )
  )
    throw Error("Invalid business calendar");
  return { timezone: value.timezone, weekly, holidays: value.holidays };
}
