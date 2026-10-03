"use client";
import type { PluginTier } from "@/lib/api";
import { BadgeCheck, Puzzle, ShieldAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

/** Square icon with a calm placeholder. Remote images never send a referrer. */
export function IconTile({ src, size = 40, children }: { src?: string | null; size?: number; children?: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  // Only https images and inline data images are ever loaded.
  const ok = !!src && (/^https:\/\//i.test(src) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(src));
  const show = ok && failed !== src;
  return (
    <span className="icon-tile" style={{ width: size, height: size }} aria-hidden="true">
      {show ? (
        <img src={src!} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src!)} />
      ) : (
        (children ?? <Puzzle />)
      )}
    </span>
  );
}

const tierCopy: Record<PluginTier, { label: string; hint: string }> = {
  bundled: { label: "Built in", hint: "Ships with Fledge" },
  verified: { label: "Verified", hint: "Signed by a publisher key you trust" },
  community: { label: "Community", hint: "Unsigned. Fledge can’t vouch for who made it" },
};

export function TierBadge({ tier }: { tier: PluginTier }) {
  const t = tierCopy[tier] || tierCopy.community;
  return (
    <span className={`tag tier tier--${tier}`} title={t.hint}>
      {tier === "verified" ? <BadgeCheck aria-hidden="true" /> : tier === "community" ? <ShieldAlert aria-hidden="true" /> : null}
      {t.label}
    </span>
  );
}
