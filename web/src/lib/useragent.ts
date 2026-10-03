/** A short "Browser on OS" label from a user-agent string. Order matters: Edge and Opera also say Chrome. */
export function deviceLabel(ua?: string | null): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg(?:e|A|iOS)?\/\d/.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /SamsungBrowser\//.test(ua) ? "Samsung Internet"
    : /CriOS\/|Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) && /Version\//.test(ua) ? "Safari"
    : /curl\//i.test(ua) ? "curl"
    : "";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? (/iPad/.test(ua) ? "iPadOS" : "iOS")
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux|X11/.test(ua) ? "Linux"
    : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Unknown device";
}

/** True for phones and tablets, to pick an icon. */
export function isMobileAgent(ua?: string | null): boolean {
  return !!ua && /Android|iPhone|iPad|iPod|Mobile/.test(ua);
}
