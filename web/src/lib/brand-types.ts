// Types for the appearance settings ("Plumage", 0.6.2.1). They mirror api/src/branding.ts; the panel only ever reads the
// public projection, and the administrator editor reads and writes the full document.
import type { FontId, ModeSetting, ThemeSpec } from "../../../shared/theme";

export type BrandLink = { label: string; url: string; icon: string; newTab: boolean };
export type AnnouncementTone = "info" | "warn" | "bad";
export type PublicAnnouncement = { id: string; tone: AnnouncementTone; text: string; dismissible: boolean; audience: "everyone" | "customers" | "admins" };

export type PublicBranding = {
  revision: number;
  disabled: boolean;
  product: { name: string; version: string };
  identity: { name: string; shortName: string; tagline: string; showPoweredBy: boolean; sourceUrl: string };
  theme: { mode: ModeSetting; allowUserMode: boolean; font: FontId; motion: "full" | "reduced"; css: string; colors: { dark: { bg: string; accent: string }; light: { bg: string; accent: string } } };
  customCss: string;
  images: { mark: string | null; wordmark: string | null; favicon: string | null; login: string | null };
  login: { welcome: string; background: "none" | "gradient" | "image"; layout: "centered" | "split"; footerLinks: BrandLink[] };
  navigation: { links: BrandLink[]; labels: Record<string, string> };
  announcement: PublicAnnouncement | null;
};

export type Branding = {
  schemaVersion: 1;
  revision: number;
  identity: { name: string; shortName: string; tagline: string; emailFromName: string; sourceUrl: string; showPoweredBy: boolean };
  theme: ThemeSpec;
  login: { welcome: string; background: "none" | "gradient" | "image"; layout: "centered" | "split"; footerLinks: BrandLink[] };
  navigation: { links: BrandLink[]; labels: Record<string, string> };
  announcement: { enabled: boolean; tone: AnnouncementTone; text: string; audience: "everyone" | "customers" | "admins"; dismissible: boolean; startsAt: string | null; endsAt: string | null; id: string };
  email: { footer: string };
  advanced: { customCssEnabled: boolean; customCss: string };
  assets: Record<"mark" | "wordmark" | "favicon" | "login", string | null>;
};

export type BrandingAdmin = {
  branding: Branding;
  warnings: string[];
  disabled: boolean;
  history: { id: number; revision: number; at: string; reason: string; by: string | null }[];
  limits: { css: number; assets: Record<string, { bytes: number; types: string[]; maxWidth: number; maxHeight: number }> };
};

export const LINK_ICONS = ["link", "book", "life-buoy", "message-circle", "shield", "activity", "server", "globe", "heart", "mail", "file-text", "help-circle", "users", "star"] as const;
export const NAV_IDS = ["overview", "servers", "nodes", "resilience", "templates", "plugins", "customers", "activity", "api", "updates", "settings", "store", "billing"] as const;

/** What the panel shows when the API cannot be reached (and what a fresh install receives). */
export const DEFAULT_PUBLIC: PublicBranding = {
  revision: 0,
  disabled: false,
  product: { name: "Fledge", version: "" },
  identity: { name: "Fledge", shortName: "Fledge", tagline: "", showPoweredBy: true, sourceUrl: "" },
  theme: { mode: "dark", allowUserMode: true, font: "geist", motion: "full", css: "", colors: { dark: { bg: "#0b0b0a", accent: "#8fb596" }, light: { bg: "#f7f6f2", accent: "#36724b" } } },
  customCss: "",
  images: { mark: null, wordmark: null, favicon: null, login: null },
  login: { welcome: "", background: "none", layout: "centered", footerLinks: [] },
  navigation: { links: [], labels: {} },
  announcement: null,
};
