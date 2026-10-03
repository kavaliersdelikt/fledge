"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { API } from "./api";
import { DEFAULT_PUBLIC, type PublicBranding } from "./brand-types";
import { MODE_COOKIE, isPersonalMode, type PersonalMode } from "./brand-init";

type BrandContext = {
  brand: PublicBranding;
  /** Fetch the public document again (after an administrator saved, or when the tab regains focus). */
  refresh: () => Promise<void>;
  /** The person's own mode, or null when the administrator's default applies. */
  mode: PersonalMode | null;
  setMode: (mode: PersonalMode | null) => void;
  /** Shows an unsaved draft on the real panel (this browser only). null goes back to what is saved. */
  preview: PublicBranding | null;
  setPreview: (draft: PublicBranding | null) => void;
};

const Ctx = createContext<BrandContext>({ brand: DEFAULT_PUBLIC, refresh: async () => {}, mode: null, setMode: () => {}, preview: null, setPreview: () => {} });
export const useBrand = () => useContext(Ctx);

function readCookie(): PersonalMode | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${MODE_COOKIE}=(dark|light|system)`));
  return m && isPersonalMode(m[1]) ? m[1] : null;
}

/** Applies a mode to the page at once (no reload) and remembers it in the cookie the server reads. */
export function applyMode(mode: PersonalMode | null, fallback: PersonalMode) {
  const d = document.documentElement;
  if (d.hasAttribute("data-safe")) return;
  if (mode) document.cookie = `${MODE_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
  else document.cookie = `${MODE_COOKIE}=; path=/; max-age=0; samesite=lax`;
  const want = mode ?? fallback;
  const mq = matchMedia("(prefers-color-scheme: light)");
  const v = want === "system" ? (mq.matches ? "light" : "dark") : want;
  d.setAttribute("data-mode", v);
  d.classList.toggle("dark", v === "dark");
}

export function BrandProvider({ initial, children }: { initial: PublicBranding; children: ReactNode }) {
  const [saved, setBrand] = useState(initial);
  const [preview, setPreview] = useState<PublicBranding | null>(null);
  const brand = preview ?? saved;
  const [mode, setModeState] = useState<PersonalMode | null>(null);
  const lastFetch = useRef(Date.now());

  useEffect(() => setModeState(readCookie()), []);

  const refresh = useCallback(async () => {
    lastFetch.current = Date.now();
    try {
      const res = await fetch(`${API}/api/branding`, { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as PublicBranding;
      setBrand((cur) => (next.revision === cur.revision && next.disabled === cur.disabled ? cur : next));
    } catch {
      /* keep what we have */
    }
  }, []);

  // Other administrators' changes arrive when the tab is used again.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetch.current > 60_000) void refresh();
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [refresh]);

  // Keep the document in step when the branding changes while the page is open (a save, or a preview of a draft).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const d = document.documentElement;
    if (d.hasAttribute("data-safe")) return;
    const vars = document.getElementById("brand-vars");
    if (vars) vars.textContent = brand.theme.css;
    let css = document.getElementById("brand-css");
    if (brand.customCss) {
      if (!css) {
        css = document.createElement("style");
        css.id = "brand-css";
        document.head.appendChild(css);
      }
      css.textContent = brand.customCss;
    } else css?.remove();
    d.setAttribute("data-default", brand.theme.mode);
    d.setAttribute("data-allow", brand.theme.allowUserMode ? "1" : "0");
    d.setAttribute("data-motion", brand.theme.motion);
    applyMode(brand.theme.allowUserMode ? readCookie() : null, brand.theme.mode);
    const icon = brand.images.favicon || "/fledge-symbol.png";
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]').forEach((l) => (l.href = icon));
  }, [brand]);

  const setMode = useCallback(
    (next: PersonalMode | null) => {
      setModeState(next);
      applyMode(next, brand.theme.mode);
    },
    [brand.theme.mode],
  );
  const value = useMemo(() => ({ brand, refresh, mode, setMode, preview, setPreview }), [brand, refresh, mode, setMode, preview]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The logo. Without an uploaded one, the Fledge mark in the colours that suit the current mode (cream on dark, ink on light). */
export function MarkImage() {
  const { brand } = useBrand();
  return brand.images.mark ? <img src={brand.images.mark} alt="" /> : <FledgeMark />;
}

/** Fledge's own mark, whatever the panel is called (used where the software itself is meant). */
export function FledgeMark() {
  return (
    <>
      <img className="mark mark--dark" src="/fledge-symbol.png" alt="" />
      <img className="mark mark--light" src="/fledge-symbol-light.png" alt="" />
    </>
  );
}

/** The logo and the name, for use inside an existing `.brand` container. A wide logo replaces both. */
export function BrandMark({ name = true }: { name?: boolean }) {
  const { brand } = useBrand();
  if (brand.images.wordmark) return <img className="brand__wordmark" src={brand.images.wordmark} alt={brand.identity.name} />;
  return (
    <>
      <MarkImage />
      {name ? <span>{brand.identity.name}</span> : null}
    </>
  );
}

/** Sets the tab title to "Page · Panel name". */
export function useDocumentTitle(page?: string) {
  const { brand } = useBrand();
  useEffect(() => {
    document.title = page ? `${page} · ${brand.identity.name}` : brand.identity.name;
  }, [page, brand.identity.name]);
}
