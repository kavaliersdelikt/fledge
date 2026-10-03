"use client";

import { ArrowLeft, Download, Eye, Palette, RotateCcw, Save, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, json, request } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { NAV_IDS, type Branding, type BrandingAdmin } from "@/lib/brand-types";
import { Markdown } from "@/lib/markdown";
import {
  COLOR_TOKENS, DENSITIES, FONTS, PRESETS, RADII, TEXT_SCALES, applyPreset, checkTheme, editPalette, derivePalette, isHex,
  type ColorToken, type Density, type FontId, type Mode, type ModeSetting, type PaletteInput,
} from "../../../shared/theme";
import { Button, Card, Confirm, Notice, PageHeader, Segmented, State } from "./shared";
import { useToast } from "./toast";
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "./ui/tabs";
import ContrastTable from "./appearance/ContrastTable";
import { ColorField, Choice, ImageSlot, LinkList, RangeField, SwitchRow, TextField } from "./appearance/Controls";
import { ASSET_KINDS, NAV_LABELS, clone, draftToPublic, fromLocalInput, stable, toLocalInput, type AssetKind } from "./appearance/helpers";
import Preview from "./appearance/Preview";

type Tab = "identity" | "colors" | "type" | "login" | "navigation" | "announcement" | "advanced";
const TABS: [Tab, string][] = [
  ["identity", "Identity"],
  ["colors", "Colours"],
  ["type", "Type and shape"],
  ["login", "Sign-in page"],
  ["navigation", "Navigation"],
  ["announcement", "Announcement"],
  ["advanced", "Advanced"],
];

const TOKEN_LABELS: Record<ColorToken, string> = {
  bg: "Page background", surface: "Cards", "surface-2": "Raised areas", "surface-3": "Hover and pressed", raised: "Menus and dialogs",
  border: "Borders", "border-strong": "Strong borders", "border-hover": "Border on hover",
  text: "Text", "text-2": "Secondary text", "text-3": "Hints and placeholders",
  primary: "Main button", "primary-hover": "Main button on hover", "primary-text": "Text on the main button", accent: "Accent (links, focus)", "on-accent": "Knob on accent switches",
  ok: "Success", warn: "Warning", bad: "Error", busy: "Busy", "on-bad": "Text on a delete button",
  "seg-alt": "Second chart colour", "terminal-bg": "Console background", "terminal-text": "Console text", "shadow-ink": "Shadows", wash: "Hover overlay", gloss: "Button highlight", scrim: "Dimmed backdrop",
};

const TRY_SECONDS = 60;
const DRAFT_KEY = "fledge-appearance-draft";

// An unsaved draft survives leaving the page (or a reload) for as long as the tab lives and nobody else saved in between.
const readDraft = (revision: number): Branding | null => {
  try {
    const v = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
    return v && v.base === revision ? (v.draft as Branding) : null;
  } catch {
    return null;
  }
};
const writeDraft = (revision: number, draft: Branding | null) => {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ base: revision, draft }));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage can be blocked */
  }
};

export default function AppearancePage() {
  const { brand, refresh, setPreview } = useBrand();
  const toast = useToast();
  const [data, setData] = useState<BrandingAdmin | null>(null);
  const [draft, setDraft] = useState<Branding | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("identity");
  const [editing, setEditing] = useState<Mode>("dark");
  const [pvMode, setPvMode] = useState<Mode>("dark");
  const [pvView, setPvView] = useState<"panel" | "signin">("panel");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [imported, setImported] = useState<string[] | null>(null);
  const [cssProblem, setCssProblem] = useState("");
  const [trying, setTrying] = useState<{ left: number; kept: boolean } | null>(null);
  const [restored, setRestored] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await request<BrandingAdmin>("/branding/admin");
      setData(d);
      // Start the preview and the palette editor on the mode people see by default.
      setEditing(d.branding.theme.mode === "light" ? "light" : "dark");
      setPvMode(d.branding.theme.mode === "light" ? "light" : "dark");
      const kept = readDraft(d.branding.revision);
      if (kept && stable(kept) !== stable(d.branding)) {
        setDraft(kept);
        setRestored(true);
      } else setDraft(clone(d.branding));
      setLoadError("");
      setConflict(false);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = data?.branding;
  const dirty = !!draft && !!saved && stable(draft) !== stable(saved);

  useEffect(() => {
    if (saved) writeDraft(saved.revision, dirty ? draft : null);
  }, [dirty, draft, saved]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const patch = useCallback((fn: (d: Branding) => void) => {
    setDraft((cur) => {
      if (!cur) return cur;
      const next = clone(cur);
      fn(next);
      return next;
    });
  }, []);

  /* ---- images ---- */
  const urlFor = useCallback(
    (kind: AssetKind): string | null => {
      const sha = draft?.assets[kind];
      if (!sha) return null;
      if (local[sha]) return local[sha];
      if (sha === saved?.assets[kind]) return `/branding/${kind}?v=${sha.slice(0, 16)}`;
      return `${API}/api/branding/blobs/${kind}/${sha}`;
    },
    [draft, saved, local],
  );
  const urls = useMemo(() => Object.fromEntries(ASSET_KINDS.map((k) => [k, urlFor(k)])) as Record<AssetKind, string | null>, [urlFor]);
  const upload = async (kind: AssetKind, file: File) => {
    const fd = new FormData();
    fd.append("kind", kind); // the field must come before the file
    fd.append("file", file);
    const r = await request<{ sha256: string }>("/branding/assets", { method: "POST", body: fd });
    setLocal((l) => ({ ...l, [r.sha256]: URL.createObjectURL(file) }));
    patch((d) => {
      d.assets[kind] = r.sha256;
    });
  };

  /* ---- checks ---- */
  const report = useMemo(() => (draft ? checkTheme(draft.theme) : null), [draft?.theme]); // eslint-disable-line react-hooks/exhaustive-deps
  // Half-typed colours are fine while editing but cannot be saved.
  const colourProblem = draft
    ? (['dark', 'light'] as Mode[]).map((m) => (!isHex(draft.theme[m].accent) ? `The ${m} accent is not a colour yet.` : draft.theme[m].primary !== undefined && !isHex(draft.theme[m].primary) ? `The ${m} main button colour is not a colour yet.` : '')).find(Boolean) || ''
    : '';

  // The server checks custom CSS; ask it while the administrator types.
  useEffect(() => {
    if (!draft?.advanced.customCssEnabled || !draft.advanced.customCss.trim()) {
      setCssProblem("");
      return;
    }
    const t = setTimeout(() => {
      request("/branding/validate", { method: "POST", body: JSON.stringify({ branding: draft }) })
        .then(() => setCssProblem(""))
        .catch((e: Error) => setCssProblem(/Custom CSS/.test(e.message) ? e.message : ""));
    }, 700);
    return () => clearTimeout(t);
  }, [draft?.advanced.customCssEnabled, draft?.advanced.customCss]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- try on this browser ---- */
  const stopTrying = useCallback(() => {
    setTrying(null);
    setPreview(null);
  }, [setPreview]);
  useEffect(() => () => setPreview(null), [setPreview]);
  useEffect(() => {
    if (!trying || !draft) return;
    setPreview(draftToPublic(draft, urls, brand));
  }, [trying, draft, urls]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!trying || trying.kept) return;
    if (trying.left <= 0) {
      stopTrying();
      toast({ tone: "neutral", title: "Went back to the saved look", description: "The preview ended because nobody confirmed it." });
      return;
    }
    const t = setTimeout(() => setTrying((x) => (x ? { ...x, left: x.left - 1 } : x)), 1000);
    return () => clearTimeout(t);
  }, [trying]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- save ---- */
  const save = async () => {
    if (!draft || !saved || colourProblem || (report && report.errors.length)) return;
    setSaving(true);
    setSaveError("");
    try {
      const res = await request<{ branding: Branding; warnings: string[] }>("/branding", { method: "PUT", body: JSON.stringify({ branding: draft, baseRevision: saved.revision }) });
      stopTrying();
      await load();
      await refresh();
      toast({ tone: "ok", title: "Appearance saved", description: res.warnings.length ? `${res.warnings.length} suggestion${res.warnings.length === 1 ? "" : "s"} to look at.` : undefined });
    } catch (e: any) {
      if (e?.status === 409) setConflict(true);
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loadError || !draft || !saved || !data || !report)
    return (
      <>
        <PageHeader title="Appearance" />
        <State loading={!loadError} error={loadError}>
          {null}
        </State>
      </>
    );

  const editingResult = report[editing];
  const pal = draft.theme[editing];
  const setPal = (p: Partial<PaletteInput>) =>
    patch((d) => {
      d.theme[editing] = editPalette(d.theme[editing], p);
      d.theme.preset = "custom";
    });
  const primaryKind = pal.primary ? (pal.primary.toLowerCase() === pal.accent.toLowerCase() ? "accent" : "custom") : "neutral";
  const hueTrack = "linear-gradient(90deg, hsl(0 45% 55%), hsl(60 45% 55%), hsl(120 45% 55%), hsl(180 45% 55%), hsl(240 45% 55%), hsl(300 45% 55%), hsl(360 45% 55%))";

  return (
    <>
      <PageHeader
        title="Appearance"
        description="Name the panel, give it a logo and colours, and decide how the sign-in page, navigation and emails look."
        crumb={
          <Link href="/settings" className="crumb">
            <ArrowLeft /> Settings
          </Link>
        }
        actions={
          <Button onClick={() => setTrying({ left: TRY_SECONDS, kept: false })} disabled={!!trying || !!report.errors.length || !!colourProblem}>
            <Eye /> Try on this browser
          </Button>
        }
      />
      {data.disabled ? (
        <Notice tone="warn" title="Appearance is switched off on this server">
          BRANDING_DISABLED is set, so everyone sees the built-in look and changes cannot be saved. Remove it from the API’s environment and restart to change the appearance.
        </Notice>
      ) : null}
      {restored && dirty ? (
        <Notice tone="neutral" title="Your unsaved changes are back">
          You left this page before saving. Nothing is live until you press Save appearance.
        </Notice>
      ) : null}
      {data.warnings.length ? (
        <Notice tone="warn" title="Some saved settings were not usable">
          {data.warnings.join(" ")}
        </Notice>
      ) : null}
      {trying ? (
        <div className="trybar" role="status">
          <span>
            {trying.kept ? "Previewing unsaved changes on this browser." : `Previewing unsaved changes. Going back to the saved look in ${trying.left} s unless you keep it.`}
          </span>
          <span className="trybar__actions">
            {trying.kept ? null : (
              <button type="button" onClick={() => setTrying({ left: 0, kept: true })}>
                Keep previewing
              </button>
            )}
            <button type="button" onClick={stopTrying}>
              Go back
            </button>
          </span>
        </div>
      ) : null}

      <div className="ap">
        <div className="ap__editor">
          <Tabs value={tab} onValueChange={(v: string) => setTab(v as Tab)}>
            <TabsList aria-label="Appearance sections">
              {TABS.map(([key, label]) => (
                <TabsTrigger key={key} value={key}>
                  {label}
                </TabsTrigger>
              ))}
              <TabsIndicator />
            </TabsList>
            <TabsContent value={tab} key={tab}>
              {tab === "identity" ? (
                <Card title="Identity" description="What the panel is called and what it looks like at a glance.">
                  <div className="form">
                    <TextField label="Panel name" value={draft.identity.name} max={40} onChange={(v) => patch((d) => void (d.identity.name = v))} hint="Shown in the sidebar, the sign-in page, the browser tab, emails and notifications." />
                    <TextField label="Short name" value={draft.identity.shortName} max={12} placeholder={draft.identity.name} onChange={(v) => patch((d) => void (d.identity.shortName = v))} hint="Used where space is tight: email subjects and the home-screen icon." />
                    <TextField label="Tagline" value={draft.identity.tagline} max={120} onChange={(v) => patch((d) => void (d.identity.tagline = v))} hint="One line under the name on the sign-in page." />
                    <ImageSlot label="Logo" src={urls.mark} accept="image/png,image/webp,image/jpeg,image/svg+xml" maxKb={data.limits.assets.mark.bytes / 1024} hint="Square works best. PNG, WebP, JPEG or plain SVG, up to 512 KB and 1024 px." onFile={(f) => upload("mark", f)} onRemove={() => patch((d) => void (d.assets.mark = null))} />
                    <ImageSlot label="Wide logo (optional)" wide src={urls.wordmark} accept="image/png,image/webp,image/jpeg,image/svg+xml" maxKb={data.limits.assets.wordmark.bytes / 1024} hint="Replaces the logo and the name in the sidebar and on the sign-in page. Up to 2048 × 512 px." onFile={(f) => upload("wordmark", f)} onRemove={() => patch((d) => void (d.assets.wordmark = null))} />
                    <ImageSlot label="Browser tab icon (optional)" src={urls.favicon} accept="image/png,image/x-icon,image/svg+xml,image/webp" maxKb={data.limits.assets.favicon.bytes / 1024} hint="Defaults to the logo. PNG, ICO, SVG or WebP, up to 128 KB." onFile={(f) => upload("favicon", f)} onRemove={() => patch((d) => void (d.assets.favicon = null))} />
                    <TextField label="Email sender name" value={draft.identity.emailFromName} max={60} onChange={(v) => patch((d) => void (d.identity.emailFromName = v))} hint="Shown as the sender when the From address in Settings, Email has no name of its own." />
                    <TextField label="Email footer" multiline rows={3} value={draft.email.footer} max={300} onChange={(v) => patch((d) => void (d.email.footer = v))} hint="Added to the end of every email the panel sends, such as your address or a support contact." />
                    <TextField label="Source code address" value={draft.identity.sourceUrl} placeholder="https://github.com/kavaliersdelikt/fledge" onChange={(v) => patch((d) => void (d.identity.sourceUrl = v))} hint="Shown in About. If you changed Fledge’s code, point this at your modified source: the AGPL asks you to offer it to the people who use the panel." />
                    <SwitchRow label="Show “Powered by Fledge” on the sign-in page" checked={draft.identity.showPoweredBy} onChange={(v) => patch((d) => void (d.identity.showPoweredBy = v))} hint="The About dialog in the account menu always names Fledge and its licence." />
                  </div>
                </Card>
              ) : null}

              {tab === "colors" ? (
                <>
                  <Card title="Starting point" description="Pick a preset, then adjust it below. Every preset has a dark and a light version.">
                    <div className="ap-presets">
                      {PRESETS.map((p) => {
                        const d = derivePalette(p.dark, "dark").tokens, l = derivePalette(p.light, "light").tokens;
                        return (
                          <button key={p.id} type="button" className="ap-preset" aria-pressed={draft.theme.preset === p.id} onClick={() => patch((x) => void (x.theme = applyPreset(x.theme, p.id)))}>
                            <span className="ap-preset__swatches" aria-hidden="true">
                              <i style={{ background: d.bg }} />
                              <i style={{ background: d.surface }} />
                              <i style={{ background: d.accent }} />
                              <i style={{ background: l.bg }} />
                              <i style={{ background: l.accent }} />
                            </span>
                            <strong>{p.name}</strong>
                            <small>{p.description}</small>
                          </button>
                        );
                      })}
                    </div>
                  </Card>
                  <Card title="Light or dark" description="The default for people who have not chosen for themselves.">
                    <div className="form">
                      <Choice<ModeSetting> label="Default mode" value={draft.theme.mode} onChange={(v) => patch((d) => void (d.theme.mode = v))} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "Match the device", hint: "Follows the system setting" }]} />
                      <SwitchRow label="People can choose for themselves" checked={draft.theme.allowUserMode} onChange={(v) => patch((d) => void (d.theme.allowUserMode = v))} hint="Adds Light, Dark and Match this device to the account menu. Turn it off to show one look to everyone." />
                    </div>
                  </Card>
                  <Card
                    title="Colours"
                    description="Fledge works out every other colour from these, and keeps text readable."
                    actions={<Segmented<Mode> label="Palette to edit" value={editing} onChange={(v) => { setEditing(v); setPvMode(v); }} options={[{ value: "dark", label: "Dark palette" }, { value: "light", label: "Light palette" }]} />}
                  >
                    <div className="form">
                      <ColorField label="Accent" value={pal.accent} placeholder="#8fb596" onChange={(v) => setPal({ accent: v.toLowerCase() })} hint="Links, focus rings, switches and highlights." />
                      {editingResult.notes.length ? <Notice tone="neutral">{editingResult.notes.join(" ")}</Notice> : null}
                      <RangeField label="Background tint" min={0} max={360} step={1} value={pal.neutralHue} track={hueTrack} display={`${pal.neutralHue}°`} onChange={(v) => setPal({ neutralHue: v })} hint="The hue of backgrounds and borders." />
                      <RangeField label="Tint strength" min={0} max={0.04} step={0.002} value={pal.neutralChroma} display={pal.neutralChroma === 0 ? "None (grey)" : `${Math.round((pal.neutralChroma / 0.04) * 100)}%`} onChange={(v) => setPal({ neutralChroma: Math.round(v * 1000) / 1000 })} />
                      <Choice<"neutral" | "accent" | "custom"> label="Main button" value={primaryKind} columns={3} onChange={(v) => setPal({ primary: v === "neutral" ? undefined : v === "accent" ? pal.accent : pal.primary && pal.primary.toLowerCase() !== pal.accent.toLowerCase() ? pal.primary : "#ebe5d6" })} options={[{ value: "neutral", label: "Neutral", hint: "Light or dark ink" }, { value: "accent", label: "Accent colour" }, { value: "custom", label: "Pick a colour" }]} />
                      {primaryKind === "custom" ? <ColorField label="Main button colour" value={pal.primary || ""} onChange={(v) => setPal({ primary: v })} /> : null}
                      <SwitchRow label="High contrast" checked={pal.contrast === "high"} onChange={(v) => setPal({ contrast: v ? "high" : "standard" })} hint="Raises every text and border to AAA contrast (7:1) for low vision." />
                    </div>
                  </Card>
                  <Card title={`Readability: ${editing} palette`} description="Every pair below is checked. Red ones cannot be saved; amber ones are worth a look.">
                    {editingResult.errors.length ? (
                      <Notice tone="bad" title="This palette cannot be saved yet">
                        {editingResult.errors.join(" · ")}
                      </Notice>
                    ) : editingResult.warnings.length ? (
                      <Notice tone="warn" title="Worth a look">
                        {editingResult.warnings.join(" · ")}
                      </Notice>
                    ) : (
                      <Notice tone="ok">Every pair passes.</Notice>
                    )}
                    <ContrastTable result={editingResult} />
                    <details className="ap-pins">
                      <summary>Pin individual colours (advanced)</summary>
                      <p className="field__hint">A pinned colour replaces the calculated one. It is checked like everything else, so pinning a colour that is hard to read blocks saving.</p>
                      <div className="ap-pins__grid">
                        {COLOR_TOKENS.map((t) => {
                          const pinned = pal.overrides?.[t];
                          const current = pinned || (editingResult.tokens[t] as string);
                          return (
                            <div key={t} className="ap-pin">
                              <input type="color" aria-label={`${TOKEN_LABELS[t]}`} value={current} onChange={(e) => setPal({ overrides: { ...(pal.overrides || {}), [t]: e.target.value } })} />
                              <span>{TOKEN_LABELS[t]}</span>
                              {pinned ? (
                                <button type="button" className="text-button" onClick={() => { const o = { ...(pal.overrides || {}) }; delete o[t]; setPal({ overrides: o }); }}>
                                  Unpin
                                </button>
                              ) : (
                                <small>{current}</small>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  </Card>
                </>
              ) : null}

              {tab === "type" ? (
                <Card title="Type and shape" description="How text looks and how rounded and roomy the panel is.">
                  <div className="form">
                    <Choice<FontId> label="Font" value={draft.theme.font} columns={3} onChange={(v) => patch((d) => void ((d.theme.font = v), (d.theme.preset = "custom")))} options={(Object.keys(FONTS) as FontId[]).map((id) => ({ value: id, label: FONTS[id].label, hint: FONTS[id].note, style: { fontFamily: FONTS[id].stack } }))} />
                    <Choice<number> label="Text size" value={draft.theme.textScale} columns={4} onChange={(v) => patch((d) => void (d.theme.textScale = v))} options={TEXT_SCALES.map((s) => ({ value: s, label: `${Math.round(s * 100)}%`, hint: s === 1 ? "Default" : undefined }))} />
                    <Choice<number> label="Corner radius" value={draft.theme.radius} columns={6} onChange={(v) => patch((d) => void ((d.theme.radius = v), (d.theme.preset = "custom")))} options={RADII.map((r) => ({ value: r, label: r === 0 ? "Square" : `${r}`, hint: r === 10 ? "Default" : undefined }))} />
                    <Choice<Density> label="Density" value={draft.theme.density} columns={3} onChange={(v) => patch((d) => void (d.theme.density = v))} options={(Object.keys(DENSITIES) as Density[]).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1), hint: k === "compact" ? "More on screen" : k === "spacious" ? "Easier to tap" : "Default" }))} />
                    <Choice<"full" | "reduced"> label="Motion" value={draft.theme.motion} columns={2} onChange={(v) => patch((d) => void (d.theme.motion = v))} options={[{ value: "full", label: "Full", hint: "Transitions and fades" }, { value: "reduced", label: "Reduced", hint: "Nearly instant. A device set to reduce motion always wins." }]} />
                  </div>
                </Card>
              ) : null}

              {tab === "login" ? (
                <Card title="Sign-in page" description="The first thing customers see.">
                  <div className="form">
                    <TextField label="Welcome text" multiline rows={3} value={draft.login.welcome} max={280} onChange={(v) => patch((d) => void (d.login.welcome = v))} hint="Shown under “Sign in”. Plain text; line breaks are kept." />
                    <Choice<"centered" | "split"> label="Layout" value={draft.login.layout} columns={2} onChange={(v) => patch((d) => void (d.login.layout = v))} options={[{ value: "centered", label: "Centred", hint: "One card in the middle" }, { value: "split", label: "Split", hint: "Name and tagline on one side, the form on the other" }]} />
                    <Choice<"none" | "gradient" | "image"> label="Background" value={draft.login.background} columns={3} onChange={(v) => { patch((d) => void (d.login.background = v)); setPvView("signin"); }} options={[{ value: "none", label: "Plain" }, { value: "gradient", label: "Soft glow", hint: "From the accent colour" }, { value: "image", label: "Picture" }]} />
                    {draft.login.background === "image" ? (
                      <ImageSlot label="Background picture" wide src={urls.login} accept="image/jpeg,image/webp,image/png" maxKb={data.limits.assets.login.bytes / 1024} hint="JPEG, WebP or PNG, up to 2 MB and 4096 px. Without a picture the soft glow is used." onFile={(f) => upload("login", f)} onRemove={() => patch((d) => void (d.assets.login = null))} />
                    ) : null}
                    <LinkList label="Links under the form" value={draft.login.footerLinks} max={5} empty="Terms, privacy or a support address, for example." onChange={(v) => patch((d) => void (d.login.footerLinks = v))} />
                  </div>
                </Card>
              ) : null}

              {tab === "navigation" ? (
                <>
                  <Card title="Rename pages" description="Change the words in the sidebar, the page titles and the search. Leave a field empty to keep the original.">
                    <div className="ap-labels">
                      {NAV_IDS.map((id) => (
                        <label key={id} className="field">
                          <span className="field__label">{NAV_LABELS[id]}</span>
                          <input
                            className="input"
                            maxLength={24}
                            placeholder={NAV_LABELS[id]}
                            value={draft.navigation.labels[id] || ""}
                            onChange={(e) =>
                              patch((d) => {
                                if (e.target.value.trim()) d.navigation.labels[id] = e.target.value;
                                else delete d.navigation.labels[id];
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>
                  </Card>
                  <Card title="Extra links" description="Shown at the bottom of the sidebar for everyone, for example your status page, rules or Discord.">
                    <LinkList label="Links" value={draft.navigation.links} max={8} empty="No extra links yet." onChange={(v) => patch((d) => void (d.navigation.links = v))} />
                  </Card>
                </>
              ) : null}

              {tab === "announcement" ? (
                <Card title="Announcement" description="A banner across the top of every page, and on the sign-in page when it is for everyone.">
                  <div className="form">
                    <SwitchRow label="Show the announcement" checked={draft.announcement.enabled} onChange={(v) => patch((d) => void (d.announcement.enabled = v))} />
                    <TextField label="Message" multiline rows={3} max={400} value={draft.announcement.text} onChange={(v) => patch((d) => void (d.announcement.text = v))} hint="Plain text with **bold**, `code` and [links](https://example.com)." />
                    <Choice<"info" | "warn" | "bad"> label="Tone" value={draft.announcement.tone} columns={3} onChange={(v) => patch((d) => void (d.announcement.tone = v))} options={[{ value: "info", label: "Information" }, { value: "warn", label: "Warning" }, { value: "bad", label: "Problem" }]} />
                    <Choice<"everyone" | "customers" | "admins"> label="Who sees it" value={draft.announcement.audience} columns={3} onChange={(v) => patch((d) => void (d.announcement.audience = v))} options={[{ value: "everyone", label: "Everyone", hint: "Including the sign-in page" }, { value: "customers", label: "Customers" }, { value: "admins", label: "Administrators" }]} />
                    <SwitchRow label="People can dismiss it" checked={draft.announcement.dismissible} onChange={(v) => patch((d) => void (d.announcement.dismissible = v))} hint="A dismissed message stays hidden until you change its text." />
                    <div className="ap-pair">
                      <label className="field">
                        <span className="field__label">Starts</span>
                        <input className="input" type="datetime-local" value={toLocalInput(draft.announcement.startsAt)} onChange={(e) => patch((d) => void (d.announcement.startsAt = fromLocalInput(e.target.value)))} />
                      </label>
                      <label className="field">
                        <span className="field__label">Ends</span>
                        <input className="input" type="datetime-local" value={toLocalInput(draft.announcement.endsAt)} onChange={(e) => patch((d) => void (d.announcement.endsAt = fromLocalInput(e.target.value)))} />
                      </label>
                    </div>
                    <p className="field__hint">Leave both empty to show it until you turn it off.</p>
                    {draft.announcement.text ? (
                      <div className={`announcement announcement--${draft.announcement.tone}`}>
                        <Markdown source={draft.announcement.text} className="announcement__text" />
                      </div>
                    ) : null}
                  </div>
                </Card>
              ) : null}

              {tab === "advanced" ? (
                <>
                  <Card title="Custom CSS" description="For details the settings above cannot reach. Applies to every page for everyone.">
                    <div className="form">
                      <Notice tone="warn">Custom CSS can hide or rearrange parts of the panel. It cannot load other files, fonts or remote images, and safe mode (add ?safe=1 to the address) ignores it if something goes wrong.</Notice>
                      <SwitchRow label="Use custom CSS" checked={draft.advanced.customCssEnabled} onChange={(v) => patch((d) => void (d.advanced.customCssEnabled = v))} />
                      {draft.advanced.customCssEnabled ? (
                        <TextField label="CSS" multiline mono rows={12} value={draft.advanced.customCss} max={data.limits.css} onChange={(v) => patch((d) => void (d.advanced.customCss = v))} hint={cssProblem ? undefined : "Up to 32 KB. Images may be embedded (data: URLs up to 20 KB) or come from /branding/mark, /branding/wordmark and /branding/login."} />
                      ) : null}
                      {cssProblem ? <Notice tone="bad">{cssProblem}</Notice> : null}
                    </div>
                  </Card>
                  <Card title="Share or back up" description="A theme file holds everything on this page, images included, but no custom CSS secrets or passwords.">
                    <ThemeFile onImport={(doc, changed, extraLocal) => { setDraft(doc); setImported(changed); setLocal((l) => ({ ...l, ...extraLocal })); }} />
                    {imported ? (
                      <Notice tone="neutral" title="Theme loaded into the editor">
                        {imported.length ? `It changes: ${imported.join(", ")}. ` : "It matches what is saved. "}Nothing is saved until you press Save.
                      </Notice>
                    ) : null}
                  </Card>
                  <Card title="Earlier versions" description="The last 20 saved versions, images included.">
                    {data.history.length === 0 ? (
                      <p className="field__hint">Nothing has been saved yet.</p>
                    ) : (
                      <ul className="ap-history">
                        {data.history.map((h, i) => (
                          <li key={h.id}>
                            <div>
                              <strong>{h.reason}</strong>
                              <small>
                                Version {h.revision} · {new Date(h.at).toLocaleString()} · {h.by || "removed account"}
                              </small>
                            </div>
                            {i === 0 ? (
                              <span className="tag">Current</span>
                            ) : (
                              <Confirm
                                danger={false}
                                variant="secondary"
                                confirmLabel="Restore"
                                text={`Restore version ${h.revision}? It becomes a new version, so nothing is lost.${dirty ? " Your unsaved changes here will be dropped." : ""}`}
                                onConfirm={async () => {
                                  await json("POST", `/branding/history/${h.id}/restore`);
                                  stopTrying();
                                  await load();
                                  await refresh();
                                  toast({ tone: "ok", title: `Restored version ${h.revision}` });
                                }}
                              >
                                <RotateCcw /> Restore
                              </Confirm>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  <Card title="Start over" description="Goes back to the Fledge name, logo and colours. The current version stays in the history.">
                    <Confirm
                      text="Reset the appearance to the Fledge default? Custom images and CSS are removed from the live panel (you can restore them from the history)."
                      confirmLabel="Reset"
                      onConfirm={async () => {
                        await json("POST", "/branding/reset");
                        stopTrying();
                        await load();
                        await refresh();
                        toast({ tone: "ok", title: "Back to the Fledge look" });
                      }}
                    >
                      Reset to the Fledge look
                    </Confirm>
                  </Card>
                </>
              ) : null}
            </TabsContent>
          </Tabs>
        </div>

        <aside className="ap__preview" aria-label="Preview">
          <div className="ap__preview-bar">
            <Segmented<"panel" | "signin"> label="What to preview" value={pvView} onChange={setPvView} options={[{ value: "panel", label: "Panel" }, { value: "signin", label: "Sign-in" }]} />
            <Segmented<Mode> label="Mode to preview" value={pvMode} onChange={setPvMode} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
          </div>
          <Preview draft={draft} mode={pvMode} view={pvView} urls={urls} />
          <p className="field__hint">A drawing of the panel with these settings. “Try on this browser” shows the real thing for a minute.</p>
        </aside>
      </div>

      <div className="ap-savebar" role="region" aria-label="Save appearance">
        <div className="ap-savebar__text">
          {conflict ? (
            <strong>Someone else saved a change while you were editing.</strong>
          ) : saveError ? (
            <strong className="ap-error">{saveError}</strong>
          ) : colourProblem ? (
            <strong className="ap-error">{colourProblem}</strong>
          ) : report.errors.length ? (
            <strong className="ap-error">Fix the colours that are hard to read before saving.</strong>
          ) : dirty ? (
            <strong>You have unsaved changes.</strong>
          ) : (
            <span>Everything is saved{saved.revision ? ` (version ${saved.revision})` : ""}.</span>
          )}
        </div>
        <div className="ap-savebar__actions">
          {conflict ? (
            <Button onClick={() => load()}>Load their version</Button>
          ) : (
            <Button variant="ghost" disabled={!dirty || saving} onClick={() => { setDraft(clone(saved)); setImported(null); setRestored(false); setSaveError(""); stopTrying(); }}>
              Discard
            </Button>
          )}
          <Button variant="primary" busy={saving} disabled={!dirty || data.disabled || !!report.errors.length || !!colourProblem || conflict} onClick={save}>
            <Save /> Save appearance
          </Button>
        </div>
      </div>
    </>
  );
}

/** Export to a file and import from one. Importing only fills the editor. */
function ThemeFile({ onImport }: { onImport: (doc: Branding, changed: string[], local: Record<string, string>) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="ap-file">
      <Button
        onClick={async () => {
          const doc = await request("/branding/export");
          const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "fledge-theme.json";
          a.click();
          URL.revokeObjectURL(a.href);
        }}
      >
        <Download /> Export theme
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          setError("");
          try {
            if (file.size > 4 * 1024 * 1024) throw new Error("This file is larger than 4 MB.");
            const body = JSON.parse(await file.text());
            const res = await request<{ branding: Branding; changed: string[]; warnings: string[] }>("/branding/import", { method: "POST", body: JSON.stringify(body) });
            onImport(res.branding, res.changed, {});
            toast({ tone: "ok", title: "Theme loaded", description: "Review it, then save." });
          } catch (ex) {
            setError(ex instanceof SyntaxError ? "That file is not valid JSON." : (ex as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button busy={busy} onClick={() => input.current?.click()}>
        <Upload /> Import theme
      </Button>
      {error ? (
        <span className="ap-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A card on the Settings page that leads to the editor. */
export function AppearanceLink() {
  const { brand } = useBrand();
  return (
    <Card>
      <div className="ap-link-card">
        <Palette aria-hidden="true" />
        <div>
          <strong>Make {brand.identity.name} your own</strong>
          <p>Name, logo, colours, light and dark, the sign-in page, links and announcements.</p>
        </div>
        <Link href="/settings/appearance" className="btn btn--secondary">
          Open appearance
        </Link>
      </div>
    </Card>
  );
}
