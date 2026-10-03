import type { CSSProperties } from "react";
import { DENSITIES, FONTS, derivePalette, themeCss, type Mode, type ThemeSpec } from "../../../../shared/theme";
import type { Branding, PublicBranding } from "@/lib/brand-types";

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** JSON with sorted keys, so two documents compare equal whatever order their keys came in. */
export const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

export type AssetKind = "mark" | "wordmark" | "favicon" | "login";
export const ASSET_KINDS: AssetKind[] = ["mark", "wordmark", "favicon", "login"];

/** The tokens of one palette as inline custom properties, for the preview (and nothing else). */
export function previewStyle(spec: ThemeSpec, mode: Mode): CSSProperties {
  const { tokens } = derivePalette(mode === "dark" ? spec.dark : spec.light, mode);
  const style: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(tokens)) style[`--${k}`] = v as string;
  style["--radius-scale"] = spec.radius / 10;
  style["--text-scale"] = spec.textScale;
  style["--density"] = DENSITIES[spec.density];
  style["--font-ui"] = FONTS[spec.font].stack;
  style.colorScheme = mode;
  return style as CSSProperties;
}

/** What the real panel would receive for this draft, to try it out before saving. */
export function draftToPublic(draft: Branding, urls: Record<AssetKind, string | null>, base: PublicBranding): PublicBranding {
  // The generated stylesheet comes from the same function the server uses.
  const dark = derivePalette(draft.theme.dark, "dark").tokens;
  const light = derivePalette(draft.theme.light, "light").tokens;
  return {
    ...base,
    identity: { ...base.identity, name: draft.identity.name, shortName: draft.identity.shortName || draft.identity.name, tagline: draft.identity.tagline, showPoweredBy: draft.identity.showPoweredBy, sourceUrl: draft.identity.sourceUrl },
    theme: { mode: draft.theme.mode, allowUserMode: draft.theme.allowUserMode, font: draft.theme.font, motion: draft.theme.motion, css: themeCss(draft.theme), colors: { dark: { bg: dark.bg, accent: dark.accent }, light: { bg: light.bg, accent: light.accent } } },
    customCss: draft.advanced.customCssEnabled ? draft.advanced.customCss : "",
    images: { mark: urls.mark, wordmark: urls.wordmark, favicon: urls.favicon || urls.mark, login: urls.login },
    login: { welcome: draft.login.welcome, background: draft.login.background, layout: draft.login.layout, footerLinks: draft.login.footerLinks },
    navigation: draft.navigation,
  };
}

export const NAV_LABELS: Record<string, string> = {
  overview: "Overview",
  servers: "Servers",
  nodes: "Nodes",
  resilience: "Resilience",
  templates: "Templates",
  plugins: "Plugins",
  customers: "Customers",
  activity: "Activity",
  api: "API",
  updates: "Updates",
  settings: "Settings",
};

/** Local date-time input value (yyyy-mm-ddThh:mm) from an ISO string, and back. */
export const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
