import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import "./appearance.css";
import { BrandProvider } from "@/lib/brand";
import { INIT_SCRIPT, MODE_COOKIE, isPersonalMode } from "@/lib/brand-init";
import { getBranding } from "@/lib/branding-server";

// The branding is read on every request (and cached for 3 seconds), so the first byte of every page already has the
// administrator's name, colours and mode. Without it the built-in Fledge look is used; the panel never waits for it.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const b = await getBranding();
  const icon = b.images.favicon || "/fledge-symbol.png";
  return {
    title: b.identity.name,
    description: b.identity.tagline || "Self-hosted game server panel",
    applicationName: b.identity.name,
    icons: { icon },
    manifest: "/manifest.webmanifest",
  };
}

export async function generateViewport(): Promise<Viewport> {
  const b = await getBranding();
  const only = b.theme.mode === "dark" ? "dark" : b.theme.mode === "light" ? "light" : null;
  return {
    themeColor: only
      ? b.theme.colors[only].bg
      : [
          { media: "(prefers-color-scheme: dark)", color: b.theme.colors.dark.bg },
          { media: "(prefers-color-scheme: light)", color: b.theme.colors.light.bg },
        ],
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const b = await getBranding();
  const personal = (await cookies()).get(MODE_COOKIE)?.value;
  const chosen = b.theme.allowUserMode && isPersonalMode(personal) ? personal : b.theme.mode;
  // "system" is resolved in the browser by the script in <head>; until then the stylesheet's media query decides.
  const mode = chosen === "system" ? undefined : chosen;
  return (
    <html
      lang="en"
      className={mode === "dark" ? "dark" : undefined}
      data-mode={mode}
      data-default={b.theme.mode}
      data-allow={b.theme.allowUserMode ? "1" : "0"}
      data-motion={b.theme.motion}
      suppressHydrationWarning
    >
      <head>
        {b.theme.css ? <style id="brand-vars" dangerouslySetInnerHTML={{ __html: b.theme.css }} /> : <style id="brand-vars" />}
        {b.customCss ? <style id="brand-css" dangerouslySetInnerHTML={{ __html: b.customCss }} /> : null}
        <script dangerouslySetInnerHTML={{ __html: INIT_SCRIPT }} />
      </head>
      <body>
        <BrandProvider initial={b}>{children}</BrandProvider>
      </body>
    </html>
  );
}
