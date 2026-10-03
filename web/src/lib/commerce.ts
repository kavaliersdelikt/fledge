// Types and small helpers shared by the sign-up, store, billing and limits screens (0.7.1.1).
import { createContext, useContext } from "react";

export type Cycle = "month" | "quarter" | "semiannual" | "year";
export const CYCLES: Cycle[] = ["month", "quarter", "semiannual", "year"];
export const cycleLabel: Record<Cycle, string> = { month: "Monthly", quarter: "Every 3 months", semiannual: "Every 6 months", year: "Yearly" };
export const cycleShort: Record<Cycle, string> = { month: "month", quarter: "3 months", semiannual: "6 months", year: "year" };

/** What the panel offers this person (GET /api/features). */
export type Features = {
  store: { enabled: boolean; sells: boolean; title: string };
  billing: { subscriptions: number; visible: boolean };
  selfService: { mode: "off" | "presets" | "custom"; canDelete: boolean; coolingHours: number };
  limits: { showUsage: boolean; enabled: boolean; mode: "enforce" | "warn" };
  account: { status: string; allowDeletion: boolean; allowEmailChange: boolean; allowExport: boolean; minPasswordLength: number };
};
export const noFeatures: Features = {
  store: { enabled: false, sells: false, title: "Store" },
  billing: { subscriptions: 0, visible: false },
  selfService: { mode: "off", canDelete: false, coolingHours: 0 },
  limits: { showUsage: true, enabled: true, mode: "enforce" },
  account: { status: "active", allowDeletion: false, allowEmailChange: true, allowExport: true, minPasswordLength: 12 },
};
export const FeaturesContext = createContext<Features>(noFeatures);
export const useFeatures = () => useContext(FeaturesContext);

export type PlanPrice = { id: string; cycle: Cycle; amount: number; currency: string; text: string; perMonthText: string | null; trialDays: number; setupFee: number; setupText: string | null; savings: number };
export type StorePlan = {
  id: string; slug: string; name: string; description: string; kind: "server" | "account"; features: string[]; highlight: boolean; badge: string; note: string; free: boolean;
  spec: null | { template: string; memoryMb: number; cpuPercent: number; diskMb: number; locations: string[]; allowLocationChoice: boolean; allowNameChoice: boolean; variables: { key: string; label: string; description?: string; type: string; options?: { value: string; label: string }[]; min?: number; max?: number; required?: boolean }[] };
  prices: PlanPrice[]; stock: number | null; soldOut: boolean; owned: number; canBuyMore: boolean;
};
export type StoreView = {
  enabled: boolean; title: string; intro: string; defaultInterval: Cycle; promoCodes: boolean; collectAddress: boolean; freeOnly?: boolean;
  legal: { termsUrl: string; privacyUrl: string; withdrawalNotice: string; taxNote: string; requireTerms: boolean; companyName: string; companyEmail: string; supportUrl: string };
  plans: StorePlan[]; canBuy: boolean; reason: string | null; activeSubscriptions: number; maxActive: number;
};

export type SubStatus = "incomplete" | "trialing" | "active" | "past_due" | "suspended" | "canceled" | "terminated";
export type MySubscription = {
  id: string; planId: string; planName: string; kind: "server" | "account"; status: SubStatus; cycle: Cycle; intervalText: string; amount: number; currency: string; amountText: string;
  provider: string; comped: boolean; currentPeriodEnd: string | null; trialEnd: string | null; cancelAtPeriodEnd: boolean; endsAt: string | null; pastDueSince: string | null; suspendAt: string | null;
  retentionUntil: string | null; fulfilment: string; fulfilmentError: string | null; hold: boolean; server: null | { id: string; name: string; status: string; suspendedReason: string | null };
  createdAt: string; can: { cancel: boolean; resume: boolean; change: boolean; pay: boolean };
};
export type MyInvoice = { id: string; number: string | null; status: string; plan: string | null; amountText: string; paidText: string; refundedText: string | null; createdAt: string; paidAt: string | null; url: string | null; pdf: string | null };
export type BillingView = { enabled: boolean; subscriptions: MySubscription[]; invoices: MyInvoice[]; portal: boolean; allowCancel: boolean; cancelNow: boolean };

export type OrderView = {
  id: string; status: "created" | "pending" | "paid" | "expired" | "failed" | "canceled"; planName: string; amountText: string; subscriptionId: string | null; subscriptionStatus: string | null;
  fulfilment: string | null; server: null | { id: string; name: string }; checkoutUrl: string | null;
};

export type LimitRow = { key: string; label: string; limit: number | null; used: number | null; unlimited: boolean; source: "default" | "plan" | "override" | "none"; plans: string[] };
export type LimitsView = {
  enabled: boolean; mode: "enforce" | "warn"; hidden?: boolean; usage: Record<string, number> | null; rows: LimitRow[]; flags: Record<string, boolean>;
  allowedTemplates: string[] | null; allowedLocations: string[] | null; override?: Record<string, unknown>; defaults?: Record<string, unknown>;
};

export type SignupConfig = {
  mode: "off" | "open" | "approval" | "invite"; available: boolean; captcha: null | { provider: "turnstile" | "hcaptcha"; siteKey: string };
  requireTerms: boolean; termsUrl: string; privacyUrl: string; minPasswordLength: number; termsVersion: string;
};

export type SelfOptions = {
  mode: "off" | "presets" | "custom"; canCreate: boolean; canDelete: boolean; coolingHours: number; customResources?: boolean;
  templates: { id: string; name: string; description: string; memoryMb: number; cpuPercent: number; diskMb: number; variables: { key: string; label: string; description?: string; type: string; options?: { value: string; label: string }[]; min?: number; max?: number; required?: boolean }[] }[];
  locations: string[]; ceilings?: { memoryMb: number; cpuPercent: number; diskMb: number }; limits: LimitsView | null;
};

/** 2048 -> "2 GB" */
export const memText = (mb: number) => (mb >= 1024 ? `${+(mb / 1024).toFixed(mb % 1024 ? 2 : 0)} GB` : `${mb} MB`);
export const cpuText = (percent: number) => `${+(percent / 100).toFixed(2)} ${percent === 100 ? "core" : "cores"}`;
/** Minor units to a price string in the browser's own formatting. */
export function money(minor: number, currency: string) {
  const digits = (() => {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      return 2;
    }
  })();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits);
  } catch {
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency.toUpperCase()}`;
  }
}
export const currencyDigits = (currency: string) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};
/** "8.50" -> 850 without floating point; null when it is not a valid amount. */
export function toMinor(text: string, currency: string): number | null {
  const d = currencyDigits(currency);
  const t = text.trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d+)?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  if (f.length > d) return null;
  return Number(w) * 10 ** d + Number((f + "0".repeat(d)).slice(0, d) || 0);
}
export const fromMinor = (minor: number, currency: string) => {
  const d = currencyDigits(currency);
  return (minor / 10 ** d).toFixed(d);
};

export const statusLabel: Record<string, string> = {
  incomplete: "Starting", trialing: "Trial", active: "Active", past_due: "Payment overdue", suspended: "Suspended", canceled: "Ended", terminated: "Removed",
};
export const statusTone = (s: string): "ok" | "warn" | "bad" | "neutral" | "busy" =>
  s === "active" || s === "trialing" ? "ok" : s === "past_due" ? "warn" : s === "suspended" || s === "terminated" ? "bad" : s === "incomplete" ? "busy" : "neutral";
