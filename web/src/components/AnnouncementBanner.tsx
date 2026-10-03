"use client";

import { request } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import type { PublicAnnouncement } from "@/lib/brand-types";
import { Markdown } from "@/lib/markdown";
import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

const KEY = "fledge-dismissed-announcement";

function dismissed(id: string) {
  try {
    return localStorage.getItem(KEY) === id;
  } catch {
    return false;
  }
}

/** The banner for the signed-in person: the message set in Settings, Appearance, if it is meant for them. */
export default function AnnouncementBanner() {
  const { brand } = useBrand();
  const [item, setItem] = useState<PublicAnnouncement | null>(null);
  const [hidden, setHidden] = useState<string>("");

  // Messages for customers or administrators are not in the public document; ask for the one meant for this person.
  useEffect(() => {
    let live = true;
    request<PublicAnnouncement | null>("/branding/announcement")
      .then((a) => live && setItem(a))
      .catch(() => live && setItem(null));
    return () => {
      live = false;
    };
  }, [brand.revision]);

  if (!item || hidden === item.id || (item.dismissible && dismissed(item.id))) return null;
  const Icon = item.tone === "bad" ? CircleAlert : item.tone === "warn" ? TriangleAlert : Info;
  return (
    <div className={`announcement announcement--${item.tone}`} role={item.tone === "bad" ? "alert" : "status"}>
      <Icon className="announcement__icon" aria-hidden="true" />
      <Markdown source={item.text} className="announcement__text" />
      {item.dismissible ? (
        <button
          type="button"
          className="announcement__close"
          aria-label="Dismiss this message"
          onClick={() => {
            try {
              localStorage.setItem(KEY, item.id);
            } catch {
              /* private mode: hide for this visit only */
            }
            setHidden(item.id);
          }}
        >
          <X />
        </button>
      ) : null}
    </div>
  );
}

/** The same message on the sign-in page, where only messages for everyone exist. */
export function PublicAnnouncementBanner() {
  const { brand } = useBrand();
  const a = brand.announcement;
  const [hidden, setHidden] = useState("");
  if (!a || hidden === a.id || (a.dismissible && dismissed(a.id))) return null;
  const Icon = a.tone === "bad" ? CircleAlert : a.tone === "warn" ? TriangleAlert : Info;
  return (
    <div className={`announcement announcement--${a.tone} announcement--auth`} role={a.tone === "bad" ? "alert" : "status"}>
      <Icon className="announcement__icon" aria-hidden="true" />
      <Markdown source={a.text} className="announcement__text" />
      {a.dismissible ? (
        <button type="button" className="announcement__close" aria-label="Dismiss this message" onClick={() => setHidden(a.id)}>
          <X />
        </button>
      ) : null}
    </div>
  );
}
