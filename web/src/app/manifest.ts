import type { MetadataRoute } from "next";
import { getBranding } from "@/lib/branding-server";

export const dynamic = "force-dynamic";

// "Add to home screen" and installed web app: the panel's own name, logo and colours.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const b = await getBranding();
  const dark = b.theme.mode !== "light";
  const colors = dark ? b.theme.colors.dark : b.theme.colors.light;
  const icon = b.images.mark || "/fledge-symbol.png";
  return {
    name: b.identity.name,
    short_name: b.identity.shortName || b.identity.name,
    description: b.identity.tagline || "Self-hosted game server panel",
    start_url: "/",
    display: "standalone",
    background_color: colors.bg,
    theme_color: colors.bg,
    icons: [
      { src: icon, sizes: "any", type: icon.startsWith("/branding/") ? undefined : "image/png", purpose: "any" },
    ],
  };
}
