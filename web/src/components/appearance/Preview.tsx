"use client";

import type { Mode } from "../../../../shared/theme";
import { Server } from "lucide-react";
import type { Branding } from "@/lib/brand-types";
import { parseMarkdown, plainText } from "@/lib/markdown";
import { previewStyle, NAV_LABELS, type AssetKind } from "./helpers";

/**
 * A miniature panel drawn with the draft's own colours. It sets the draft tokens as custom properties on one element, so
 * nothing outside it changes, and uses the same radii, text size and density rules as the real panel.
 */
export default function Preview({
  draft,
  mode,
  view,
  urls,
}: {
  draft: Branding;
  mode: Mode;
  view: "panel" | "signin";
  urls: Record<AssetKind, string | null>;
}) {
  const name = draft.identity.name || "Fledge";
  const wordmark = urls.wordmark;
  const label = (id: string) => draft.navigation.labels[id] || NAV_LABELS[id];
  const brand = wordmark ? (
    <img className="pv__wordmark" src={wordmark} alt="" />
  ) : (
    <>
      <img className="pv__mark" src={urls.mark || (mode === "light" ? "/fledge-symbol-light.png" : "/fledge-symbol.png")} alt="" />
      <span>{name}</span>
    </>
  );
  return (
    <div className="pv" style={previewStyle(draft.theme, mode)} data-mode={mode} aria-hidden="true">
      {view === "panel" ? (
        <div className="pv__app">
          <div className="pv__side">
            <div className="pv__brand">{brand}</div>
            <div className="pv__search">Search</div>
            <ul className="pv__nav">
              {["overview", "servers", "nodes", "templates", "settings"].map((id) => (
                <li key={id} className={id === "servers" ? "is-active" : undefined}>
                  <span className="pv__dot" />
                  {label(id)}
                </li>
              ))}
              {draft.navigation.links.slice(0, 2).map((l, i) => (
                <li key={i} className="pv__link">
                  <span className="pv__dot" />
                  {l.label || "Link"}
                </li>
              ))}
            </ul>
          </div>
          <div className="pv__main">
            {draft.announcement.enabled && draft.announcement.text ? (
              <div className={`pv__banner pv__banner--${draft.announcement.tone}`}>{plainText(parseMarkdown(draft.announcement.text)).slice(0, 90)}</div>
            ) : null}
            <div className="pv__page">
              <h4>{label("servers")}</h4>
              <div className="pv__card">
                <div className="pv__server">
                  <Server />
                  <div>
                    <strong>Survival SMP</strong>
                    <small>minecraft-paper · frankfurt-01</small>
                  </div>
                  <span className="pv__pill pv__pill--ok">Running</span>
                </div>
                <div className="pv__server">
                  <Server />
                  <div>
                    <strong>Creative</strong>
                    <small>minecraft-fabric · helsinki-01</small>
                  </div>
                  <span className="pv__pill pv__pill--warn">Starting</span>
                </div>
              </div>
              <div className="pv__controls">
                <span className="pv__input">Search servers</span>
                <span className="pv__btn pv__btn--primary">Create server</span>
                <span className="pv__btn">Restart</span>
                <span className="pv__btn pv__btn--danger">Delete</span>
              </div>
              <div className="pv__console">
                <span>[12:03:51 INFO]: Done (4.2s)! For help, type "help"</span>
                <span className="pv__link-text">[12:04:00 INFO]: Mara_Plays joined the game</span>
                <span className="pv__bad">[12:04:09 WARN]: Can't keep up!</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className={`pv__auth pv__auth--${draft.login.layout} pv__auth--${draft.login.background}`}>
          {draft.login.layout === "split" || draft.login.background === "image" ? (
            <div className="pv__aside" style={draft.login.background === "image" && urls.login ? { backgroundImage: `url(${urls.login})` } : undefined}>
              {draft.login.layout === "split" ? (
                <>
                  <div className="pv__brand pv__brand--large">{brand}</div>
                  {draft.identity.tagline ? <p>{draft.identity.tagline}</p> : null}
                </>
              ) : null}
            </div>
          ) : null}
          <div className="pv__signin">
            {draft.login.layout !== "split" ? <div className="pv__brand">{brand}</div> : null}
            <h4>Sign in</h4>
            {draft.login.welcome || (draft.identity.tagline && draft.login.layout !== "split") ? <p>{draft.login.welcome || draft.identity.tagline}</p> : null}
            <span className="pv__input">Email</span>
            <span className="pv__input">Password</span>
            <span className="pv__btn pv__btn--primary pv__btn--block">Sign in</span>
            <small className="pv__legal">
              {draft.login.footerLinks.map((l) => l.label || "Link").join("  ")}
              {draft.identity.showPoweredBy ? "  Powered by Fledge" : ""}
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
