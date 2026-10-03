// Server-side access to the public branding document, used by the root layout, the image proxy and the manifest.
// The panel must always render, so every failure falls back to the last good document or to the built-in look.
import { DEFAULT_PUBLIC, type PublicBranding } from "./brand-types";

/** Where the panel's server reaches the API (inside Docker Compose this is the service name). */
export const apiInternalUrl = () =>
  (process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");

let cache: { at: number; value: PublicBranding } | undefined;
let inflight: Promise<PublicBranding> | undefined;
// Short on purpose: a saved change shows up on the next page load within a few seconds.
const TTL = 3_000;

async function load(): Promise<PublicBranding> {
  try {
    const res = await fetch(`${apiInternalUrl()}/api/branding`, { cache: "no-store", signal: AbortSignal.timeout(900) });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as PublicBranding;
    // A document from a very different version must not break rendering.
    if (!body || typeof body !== "object" || !body.identity || !body.theme) throw new Error("unexpected shape");
    cache = { at: Date.now(), value: { ...DEFAULT_PUBLIC, ...body, identity: { ...DEFAULT_PUBLIC.identity, ...body.identity }, theme: { ...DEFAULT_PUBLIC.theme, ...body.theme }, images: { ...DEFAULT_PUBLIC.images, ...body.images }, login: { ...DEFAULT_PUBLIC.login, ...body.login }, navigation: { ...DEFAULT_PUBLIC.navigation, ...body.navigation } } };
    return cache.value;
  } catch {
    // Keep serving the last good document for a minute; after that the built-in look.
    if (cache && Date.now() - cache.at < 60_000) return cache.value;
    return DEFAULT_PUBLIC;
  }
}

export async function getBranding(): Promise<PublicBranding> {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  inflight ??= load().finally(() => {
    inflight = undefined;
  });
  return inflight;
}
