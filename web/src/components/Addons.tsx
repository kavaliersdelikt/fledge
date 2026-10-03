"use client";
import {
  json,
  request,
  type Addon,
  type AddonHit,
  type AddonOverview,
  type AddonPlan,
  type AddonProject,
  type AddonSearch,
  type AddonUnmanaged,
  type AddonUpdate,
  type AddonUpdates,
  type AddonVersion,
} from "@/lib/api";
import { fmtAgo, fmtBytes, fmtCompact, fmtDay, fmtTime } from "@/lib/format";
import { Markdown, safeHref } from "@/lib/markdown";
import { ArrowRight, Download, ExternalLink, Heart, MoreHorizontal, Pin, PinOff, Power, PowerOff, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer, Modal, useConfirm } from "./feedback";
import { IconTile } from "./PluginBits";
import { useToast } from "./toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button, Card, Empty, ErrorNotice, Notice, Segmented, Skeleton, State, Status, Toolbar, btn, useLoad } from "./shared";

type Tab = "browse" | "installed" | "updates";
type Target = { pluginId: string; projectId: string; title: string; iconUrl: string | null; versionId?: string };
const PAGE = 24;
const sorts = [
  ["relevance", "Most relevant"],
  ["downloads", "Most downloaded"],
  ["follows", "Most followed"],
  ["newest", "Newest"],
  ["updated", "Recently updated"],
] as const;

/** Tab label for the server page. */
export const addonsLabel = (kind?: string) => (kind === "mod" ? "Mods" : kind === "plugin" ? "Plugins" : "Add-ons");

function Channel({ channel }: { channel: string }) {
  return <span className={`tag chan chan--${channel}`}>{channel[0].toUpperCase() + channel.slice(1)}</span>;
}

export default function Addons({ id, admin, canManage, initial }: { id: string; admin: boolean; canManage: boolean; initial: AddonOverview }) {
  const toast = useToast();
  const [ov, setOv] = useState(initial),
    [tab, setTab] = useState<Tab>("browse"),
    [project, setProject] = useState<{ pluginId: string; hit: AddonHit } | null>(null),
    [plan, setPlan] = useState<Target | null>(null),
    [notes, setNotes] = useState<string[]>([]),
    [restart, setRestartState] = useState(false),
    [restarting, setRestarting] = useState(false);
  const cap = ov.capability;
  const noun = cap.kind === "mod" ? "mods" : cap.kind === "plugin" ? "plugins" : "add-ons";
  const storage = useLoad<{ enabled: boolean }>("/storage/status");
  const backup = !!storage.data?.enabled;
  const rkey = `fledge:addons-restart:${id}`;

  useEffect(() => {
    try {
      setRestartState(sessionStorage.getItem(rkey) === "1");
    } catch {
      /* storage unavailable */
    }
  }, [rkey]);
  const setRestart = (value: boolean) => {
    setRestartState(value);
    try {
      if (value) sessionStorage.setItem(rkey, "1");
      else sessionStorage.removeItem(rkey);
    } catch {
      /* storage unavailable */
    }
  };

  const refresh = useCallback(async () => {
    try {
      setOv(await request<AddonOverview>(`/servers/${id}/addons`));
    } catch {
      /* keep what's on screen */
    }
  }, [id]);
  // Poll only while the node still has something in flight.
  const pending = ov.installed.some((a) => a.state === "pending" || a.state === "removing");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  // Updates: the count is cheap (cached); opening the tab asks for a fresh check.
  const [updates, setUpdates] = useState<AddonUpdates | null>(null),
    [checking, setChecking] = useState(false),
    [updatesError, setUpdatesError] = useState("");
  const checked = useRef(false);
  const checkUpdates = useCallback(
    async (force: boolean) => {
      setChecking(true);
      setUpdatesError("");
      try {
        setUpdates(await request<AddonUpdates>(`/servers/${id}/addons/updates${force ? "?refresh=1" : ""}`));
      } catch (e) {
        setUpdatesError((e as Error).message);
      } finally {
        setChecking(false);
      }
    },
    [id],
  );
  useEffect(() => {
    if (ov.providers.length && cap.supported) void checkUpdates(false);
  }, [checkUpdates, ov.providers.length, cap.supported]);
  useEffect(() => {
    if (tab === "updates" && !checked.current) {
      checked.current = true;
      void checkUpdates(true);
    }
  }, [tab, checkUpdates]);

  if (!cap.supported)
    return (
      <Card>
        <Empty title={`${addonsLabel(cap.kind)} aren’t available here`}>{cap.reason || "This server doesn’t support mods or plugins."}</Empty>
      </Card>
    );
  if (!ov.providers.length)
    return (
      <Card>
        <Empty
          title={`No catalog for ${noun} yet`}
          action={
            admin ? (
              <Link href="/plugins" className={btn("primary")}>
                Open Plugins
              </Link>
            ) : undefined
          }
        >
          {admin ? "Install and turn on a catalog plugin, such as Modrinth, to browse and install here." : "Ask an administrator to install a catalog plugin."}
        </Empty>
      </Card>
    );

  const actionable = ov.agentOk && ov.writable;
  const updateCount = updates?.updates.filter((u) => !u.pinned).length ?? 0;

  async function restartServer() {
    setRestarting(true);
    try {
      await json("POST", `/servers/${id}/actions`, { action: "restart" });
      toast({ tone: "ok", title: "Restart queued" });
      setRestart(false);
    } catch (e) {
      toast({ tone: "bad", title: "Couldn’t restart", description: (e as Error).message });
    } finally {
      setRestarting(false);
    }
  }
  const afterChange = (restartRequired: boolean, messages: string[] = []) => {
    if (restartRequired) setRestart(true);
    setNotes(messages);
    void refresh();
    void checkUpdates(false);
  };

  return (
    <>
      {!ov.agentOk && (
        <Notice
          tone="warn"
          title="This server’s node needs an update"
          action={
            admin ? (
              <Link href="/nodes" className={btn("secondary", "sm")}>
                Open Nodes
              </Link>
            ) : undefined
          }
        >
          Installing {noun} needs node agent {ov.requiredAgent ? `v${ov.requiredAgent}` : "a newer version"}
          {ov.agentVersion ? ` (this node runs v${ov.agentVersion})` : ""}. {admin ? "Update the agent to turn installs on." : "Ask an administrator to update the node."}
        </Notice>
      )}
      {ov.agentOk && !ov.writable && (
        <Notice tone="neutral" title="Installs are paused">
          This server is suspended or its node is offline, so {noun} can’t be added or changed right now. Browsing still works.
        </Notice>
      )}
      {restart && (
        <Notice
          tone="warn"
          title="Restart required"
          action={
            canManage ? (
              <Button size="sm" variant="primary" busy={restarting} onClick={() => void restartServer()}>
                {restarting ? null : <RotateCw />}
                Restart now
              </Button>
            ) : undefined
          }
        >
          Changes to {noun} apply the next time the server starts.{canManage ? "" : " Ask someone with manage access to restart it."}
        </Notice>
      )}
      {notes.length > 0 && (
        <Notice
          tone="neutral"
          title="Some updates were skipped"
          action={
            <Button size="sm" variant="ghost" onClick={() => setNotes([])}>
              Dismiss
            </Button>
          }
        >
          <ul>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Notice>
      )}

      <Toolbar>
        <Segmented
          label="Add-on sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: "browse", label: "Browse" },
            { value: "installed", label: <>Installed <span className="count">{ov.installed.length}</span></> },
            { value: "updates", label: <>Updates <span className="count">{updateCount}</span></> },
          ]}
        />
        {cap.gameVersion || cap.loaders?.length ? (
          <span className="small faint">
            {[cap.gameVersion ? `Minecraft ${cap.gameVersion}` : "", cap.loaders?.join(", ")].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </Toolbar>

      <div hidden={tab !== "browse"}>
        <Browse
          id={id}
          ov={ov}
          noun={noun}
          actionable={actionable}
          revision={ov.installed.map((a) => `${a.id}:${a.state}`).join(",")}
          onOpen={(pluginId, hit) => setProject({ pluginId, hit })}
        />
      </div>
      {tab === "installed" && (
        <InstalledList id={id} ov={ov} noun={noun} actionable={actionable} onChanged={(r) => afterChange(r)} onBrowse={() => setTab("browse")} />
      )}
      {tab === "updates" && (
        <UpdatesList
          id={id}
          updates={updates}
          checking={checking}
          error={updatesError}
          actionable={actionable}
          backup={backup}
          onCheck={() => void checkUpdates(true)}
          onDone={(restartRequired, skipped) => {
            afterChange(restartRequired, skipped);
            setTab("installed");
          }}
        />
      )}

      <ProjectDrawer
        target={project}
        id={id}
        actionable={actionable}
        onClose={() => setProject(null)}
        onInstall={(t) => setPlan(t)}
      />
      <InstallDialog
        target={plan}
        id={id}
        backupAvailable={backup}
        actionable={actionable}
        onClose={() => setPlan(null)}
        onDone={(restartRequired, warnings) => {
          setPlan(null);
          setProject(null);
          setTab("installed");
          afterChange(restartRequired, warnings);
        }}
      />
    </>
  );
}

/* ---------- Browse ---------- */

function Browse({
  id,
  ov,
  noun,
  actionable,
  revision,
  onOpen,
}: {
  id: string;
  ov: AddonOverview;
  noun: string;
  actionable: boolean;
  revision: string;
  onOpen: (pluginId: string, hit: AddonHit) => void;
}) {
  const [provider, setProvider] = useState(ov.providers[0].pluginId),
    [text, setText] = useState(""),
    [q, setQ] = useState(""),
    [sort, setSort] = useState<(typeof sorts)[number][0]>("relevance"),
    [cats, setCats] = useState<string[]>([]),
    [clientOnly, setClientOnly] = useState(false),
    [offset, setOffset] = useState(0),
    [result, setResult] = useState<AddonSearch | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const mod = ov.capability.kind === "mod";
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ((prev) => {
        if (prev !== text.trim()) setOffset(0);
        return text.trim();
      });
    }, 350);
    return () => clearTimeout(t);
  }, [text]);

  const categories = useLoad<{ id: string; label: string }[]>(`/servers/${id}/addons/categories?pluginId=${encodeURIComponent(provider)}`);

  useEffect(() => {
    const ticket = ++seq.current;
    setLoading(true);
    const params = new URLSearchParams({ pluginId: provider, offset: String(offset), limit: String(PAGE), sort });
    if (q) params.set("q", q);
    if (cats.length) params.set("categories", cats.join(","));
    if (mod && clientOnly) params.set("showClientOnly", "1");
    request<AddonSearch>(`/servers/${id}/addons/search?${params}`)
      .then((r) => {
        if (seq.current !== ticket) return;
        setResult(r);
        setError("");
      })
      .catch((e) => {
        if (seq.current === ticket) setError((e as Error).message);
      })
      .finally(() => {
        if (seq.current === ticket) setLoading(false);
      });
  }, [id, provider, q, sort, cats, clientOnly, offset, mod, attempt, revision]);

  const catList = Array.isArray(categories.data) ? categories.data : [];
  const toggleCat = (c: string) => {
    setCats((xs) => (xs.includes(c) ? xs.filter((x) => x !== c) : xs.length >= 5 ? xs : [...xs, c]));
    setOffset(0);
  };
  const total = result?.total ?? 0;
  const items = result?.items ?? [];

  return (
    <div className="addon-browse">
      <div className="addon-filters">
        {ov.providers.length > 1 && (
          <select
            className="input select addon-filters__select"
            aria-label="Catalog"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setCats([]);
              setOffset(0);
            }}
          >
            {ov.providers.map((p) => (
              <option key={p.pluginId} value={p.pluginId}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <input
          type="search"
          className="input input--search addon-filters__search"
          aria-label={`Search ${noun}`}
          placeholder={`Search ${noun}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          className="input select addon-filters__select"
          aria-label="Sort by"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as typeof sort);
            setOffset(0);
          }}
        >
          {sorts.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {mod && (
          <label className="check-line">
            <input
              type="checkbox"
              checked={clientOnly}
              onChange={(e) => {
                setClientOnly(e.target.checked);
                setOffset(0);
              }}
            />
            <span>Show client-only mods</span>
          </label>
        )}
      </div>
      {catList.length > 0 && (
        <div className="chips" role="group" aria-label="Categories">
          {catList.map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={cats.includes(c.id)} disabled={!cats.includes(c.id) && cats.length >= 5} onClick={() => toggleCat(c.id)}>
              {c.label}
            </button>
          ))}
          {cats.length >= 5 && <span className="small faint">Up to 5 categories</span>}
        </div>
      )}
      {!actionable && <span className="sr-only">Installing is currently unavailable.</span>}

      {error && !items.length ? (
        <Notice
          tone="bad"
          title={`Couldn’t load ${noun}`}
          action={
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        >
          {error}
        </Notice>
      ) : loading && !items.length ? (
        <div className="addon-grid" aria-busy="true" aria-label="Loading">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="addon-card is-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      ) : items.length ? (
        <>
          <div className={`addon-grid${loading ? " is-loading" : ""}`} aria-busy={loading}>
            {items.map((hit) => (
              <HitCard key={hit.id} hit={hit} onOpen={() => onOpen(provider, hit)} />
            ))}
          </div>
          <div className="pager addon-pager">
            <span>
              {offset + 1}–{offset + items.length} of {total.toLocaleString()}
            </span>
            <div>
              <Button size="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </Button>
              <Button size="sm" disabled={offset + items.length >= total || loading} onClick={() => setOffset(offset + PAGE)}>
                Next
              </Button>
            </div>
          </div>
          {error ? <ErrorNotice message={error} /> : null}
        </>
      ) : (
        <Card>
          <Empty title={`No ${noun} found`}>{q || cats.length ? "Try a different word or fewer categories." : `This catalog has no ${noun} for this server.`}</Empty>
        </Card>
      )}
    </div>
  );
}

function HitCard({ hit, onOpen }: { hit: AddonHit; onOpen: () => void }) {
  return (
    <button type="button" className="addon-card" onClick={onOpen} aria-label={`${hit.title}, view details`}>
      <span className="addon-card__head">
        <IconTile src={hit.iconUrl} size={44} />
        <span className="addon-card__title">
          <strong>{hit.title}</strong>
          <small>by {hit.author}</small>
        </span>
      </span>
      <span className="addon-card__summary">{hit.summary}</span>
      <span className="addon-card__stats small faint">
        <span title="Downloads">
          <Download aria-hidden="true" /> {fmtCompact(hit.downloads)}
          <span className="sr-only"> downloads</span>
        </span>
        <span title="Followers">
          <Heart aria-hidden="true" /> {fmtCompact(hit.follows)}
          <span className="sr-only"> followers</span>
        </span>
      </span>
      <span className="addon-card__foot">
        {hit.installedAddonId ? <span className="tag tag--accent">Installed{hit.installedVersion ? ` ${hit.installedVersion}` : ""}</span> : null}
        {(hit.categories || []).slice(0, 3).map((c) => (
          <span key={c} className="tag">
            {c}
          </span>
        ))}
      </span>
    </button>
  );
}

/* ---------- Project drawer ---------- */

const linkLabels: [keyof AddonProject["links"], string][] = [
  ["page", "Project page"],
  ["source", "Source"],
  ["issues", "Issues"],
  ["wiki", "Wiki"],
  ["discord", "Discord"],
];

function ProjectDrawer({
  target,
  id,
  actionable,
  onClose,
  onInstall,
}: {
  target: { pluginId: string; hit: AddonHit } | null;
  id: string;
  actionable: boolean;
  onClose: () => void;
  onInstall: (t: Target) => void;
}) {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (target) setShown(target);
  }, [target]);
  return (
    <Drawer open={!!target} onOpenChange={(o) => !o && onClose()} title={shown?.hit.title || "Details"} description={shown ? `by ${shown.hit.author}` : undefined} wide>
      {shown ? <ProjectBody key={`${shown.pluginId}:${shown.hit.id}`} id={id} target={shown} actionable={actionable} onInstall={onInstall} /> : null}
    </Drawer>
  );
}

function ProjectBody({ id, target, actionable, onInstall }: { id: string; target: { pluginId: string; hit: AddonHit }; actionable: boolean; onInstall: (t: Target) => void }) {
  const { pluginId, hit } = target;
  const q = `pluginId=${encodeURIComponent(pluginId)}&projectId=${encodeURIComponent(hit.id)}`;
  const project = useLoad<AddonProject>(`/servers/${id}/addons/project?${q}`);
  const versions = useLoad<AddonVersion[]>(`/servers/${id}/addons/versions?${q}`);
  const p = project.data;
  const list = Array.isArray(versions.data) ? versions.data : [];
  const install = (versionId?: string) => onInstall({ pluginId, projectId: hit.id, title: hit.title, iconUrl: hit.iconUrl, versionId });
  const stable = list.find((v) => v.channel === "release") || list[0];

  return (
    <>
      <div className="drawer-id">
        <IconTile src={p?.iconUrl || hit.iconUrl} size={56} />
        <div>
          <strong>{hit.title}</strong>
          <p className="muted small">{p?.summary || hit.summary}</p>
        </div>
      </div>
      <div className="addon-facts small">
        <span>
          <Download aria-hidden="true" /> {fmtCompact(p?.downloads ?? hit.downloads)} downloads
        </span>
        <span>
          <Heart aria-hidden="true" /> {fmtCompact(p?.follows ?? hit.follows)} followers
        </span>
        {p?.license ? <span>License: {p.license}</span> : null}
        {p?.updatedAt ? <span>Updated {fmtDay(p.updatedAt)}</span> : null}
      </div>
      {p && (
        <div className="addon-links">
          {linkLabels.map(([k, label]) => {
            const href = safeHref(p.links?.[k] || "");
            return href ? (
              <a key={k} className="card-link" href={href} target="_blank" rel="noopener noreferrer">
                {label} <ExternalLink />
              </a>
            ) : null;
          })}
        </div>
      )}
      <div className="btn-group">
        <Button variant="primary" disabled={!actionable || !stable} onClick={() => install(undefined)} title={!actionable ? "Installing is unavailable right now" : undefined}>
          <Download /> Install latest
        </Button>
        {stable ? <span className="small faint">{stable.label}</span> : null}
      </div>

      <section className="wizard__section" aria-labelledby="addon-versions">
        <h3 id="addon-versions">Versions for this server</h3>
        <State loading={versions.loading} error={versions.error} rows={3}>
          {list.length ? (
            <ul className="addon-versions">
              {list.map((v) => (
                <VersionRow key={v.id} version={v} disabled={!actionable} onInstall={() => install(v.id)} />
              ))}
            </ul>
          ) : (
            <p className="muted small">No version of this project is compatible with this server’s game version and loader.</p>
          )}
        </State>
      </section>

      <section className="wizard__section" aria-labelledby="addon-about">
        <h3 id="addon-about">About</h3>
        <State loading={project.loading} error={project.error} rows={4}>
          {p?.description ? <Markdown source={p.description} /> : <p className="muted small">No description.</p>}
        </State>
      </section>

      {p && p.gallery?.length ? (
        <section className="wizard__section" aria-labelledby="addon-gallery">
          <h3 id="addon-gallery">Gallery</h3>
          <div className="addon-gallery">
            {p.gallery.slice(0, 8).map((g, i) => {
              const src = safeHref(g.url);
              return src ? (
                <a key={i} href={src} target="_blank" rel="noopener noreferrer" title={g.title || "Open image"}>
                  <img src={src} alt={g.title || ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                </a>
              ) : null;
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}

function VersionRow({ version: v, disabled, onInstall }: { version: AddonVersion; disabled: boolean; onInstall: () => void }) {
  const file = v.files.find((f) => f.primary) || v.files[0];
  return (
    <li className="addon-version">
      <div className="addon-version__main">
        <div className="addon-version__name">
          <strong>{v.label}</strong>
          <Channel channel={v.channel} />
        </div>
        <p className="small faint">
          {fmtDay(v.publishedAt)} · {v.gameVersions.slice(0, 4).join(", ")}
          {v.gameVersions.length > 4 ? ` +${v.gameVersions.length - 4}` : ""}
          {v.loaders.length ? ` · ${v.loaders.join(", ")}` : ""}
          {file ? ` · ${fmtBytes(file.size)}` : ""}
        </p>
        {v.changelog ? (
          <details className="addon-details">
            <summary>Changelog</summary>
            <Markdown source={v.changelog} />
          </details>
        ) : null}
      </div>
      <Button size="sm" disabled={disabled} onClick={onInstall} aria-label={`Install ${v.label}`}>
        Install
      </Button>
    </li>
  );
}

/* ---------- Install dialog ---------- */

function InstallDialog({
  target,
  id,
  backupAvailable,
  actionable,
  onClose,
  onDone,
}: {
  target: Target | null;
  id: string;
  backupAvailable: boolean;
  actionable: boolean;
  onClose: () => void;
  onDone: (restartRequired: boolean, warnings: string[]) => void;
}) {
  return (
    <Modal open={!!target} onOpenChange={(o) => !o && onClose()} title={target ? `Install ${target.title}` : "Install"} description="Review what will be added to the server." wide>
      {target ? <InstallBody key={`${target.projectId}:${target.versionId || ""}`} id={id} target={target} backupAvailable={backupAvailable} actionable={actionable} onClose={onClose} onDone={onDone} /> : null}
    </Modal>
  );
}

function InstallBody({ id, target, backupAvailable, actionable, onClose, onDone }: { id: string; target: Target; backupAvailable: boolean; actionable: boolean; onClose: () => void; onDone: (r: boolean, w: string[]) => void }) {
  const toast = useToast();
  const [optional, setOptional] = useState<string[]>([]),
    [plan, setPlan] = useState<AddonPlan | null>(null),
    [planning, setPlanning] = useState(true),
    [error, setError] = useState(""),
    [backup, setBackup] = useState(true),
    [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const body = { pluginId: target.pluginId, projectId: target.projectId, ...(target.versionId ? { versionId: target.versionId } : {}) };

  useEffect(() => {
    const ticket = ++seq.current;
    setPlanning(true);
    json("POST", `/servers/${id}/addons/plan`, { ...body, optional })
      .then((r) => {
        if (seq.current !== ticket) return;
        setPlan(r as AddonPlan);
        setError("");
      })
      .catch((e) => {
        if (seq.current === ticket) setError((e as Error).message);
      })
      .finally(() => {
        if (seq.current === ticket) setPlanning(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, optional, target.projectId, target.versionId, target.pluginId]);

  async function confirmInstall() {
    setBusy(true);
    setError("");
    try {
      const r = (await json("POST", `/servers/${id}/addons/install`, { ...body, optional, ...(backupAvailable ? { backupFirst: backup } : {}) })) as { warnings?: string[]; restartRequired?: boolean };
      toast({ tone: "busy", title: "Installing…", description: `${target.title} is being added to the server.` });
      onDone(r.restartRequired !== false, r.warnings || []);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const blocked = !!plan?.blockers.length;
  return (
    <div className="wizard">
      {planning && !plan ? <Skeleton rows={3} /> : null}
      {plan && (
        <>
          {plan.blockers.map((b, i) => (
            <Notice key={`b${i}`} tone="bad">
              {b}
            </Notice>
          ))}
          {plan.warnings.map((w, i) => (
            <Notice key={`w${i}`} tone="warn">
              {w}
            </Notice>
          ))}
          <ul className="plan-items" aria-busy={planning}>
            {plan.items.map((it) => {
              const isOptional = it.role === "optional";
              const checked = isOptional ? optional.includes(it.projectId) : true;
              return (
                <li key={`${it.role}:${it.projectId}`} className="plan-item">
                  <label className={`plan-item__label${isOptional ? "" : " is-fixed"}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!isOptional || busy}
                      onChange={() => setOptional((xs) => (xs.includes(it.projectId) ? xs.filter((x) => x !== it.projectId) : [...xs, it.projectId]))}
                      aria-label={`${it.title}${isOptional ? " (optional)" : ""}`}
                    />
                    <IconTile src={it.iconUrl} size={32} />
                    <span className="plan-item__text">
                      <strong>{it.title}</strong>
                      <small>
                        {it.versionLabel}
                        {it.file ? ` · ${it.file.filename} · ${fmtBytes(it.file.size)}` : it.alreadyInstalled ? "" : " · no file for this server"}
                      </small>
                    </span>
                  </label>
                  <span className="plan-item__tags">
                    {it.role === "main" ? <span className="tag tag--accent">Main</span> : it.role === "required" ? <span className="tag">Required</span> : <span className="tag">Optional</span>}
                    {it.channel && it.channel !== "release" ? <Channel channel={it.channel} /> : null}
                    {it.alreadyInstalled ? <span className="tag">Already installed</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {backupAvailable && (
        <label className="check-line">
          <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
          <span>Take a backup first</span>
        </label>
      )}
      <ErrorNotice message={error} />
      <div className="modal__actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!plan || planning || blocked || !actionable} onClick={() => void confirmInstall()}>
          Install
        </Button>
      </div>
    </div>
  );
}

/* ---------- Installed ---------- */

function InstalledList({ id, ov, noun, actionable, onChanged, onBrowse }: { id: string; ov: AddonOverview; noun: string; actionable: boolean; onChanged: (restart: boolean) => void; onBrowse: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState("");

  async function patch(a: Addon, body: { disabled?: boolean; pinned?: boolean }, done: string, restart: boolean) {
    setBusy(a.id);
    try {
      await json("PATCH", `/servers/${id}/addons/${a.id}`, body);
      toast({ tone: "ok", title: done });
      onChanged(restart);
    } catch (e) {
      toast({ tone: "bad", title: `Couldn’t change ${a.title}`, description: (e as Error).message });
    } finally {
      setBusy("");
    }
  }
  async function remove(a: Addon) {
    const failed = a.state === "failed";
    const text = failed
      ? "This only clears Fledge’s record of the failed install."
      : `${a.filename} is deleted from the server’s folder.${a.isDependency ? " Other " + noun + " may need it." : ""} Restart the server to apply it.`;
    if (!(await confirm(text, { title: `${failed ? "Remove the record for" : "Remove"} ${a.title}?`, confirmLabel: failed ? "Remove record" : "Remove" }))) return;
    setBusy(a.id);
    try {
      await request(`/servers/${id}/addons/${a.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: failed ? "Record removed" : `Removing ${a.title}…` });
      onChanged(!failed);
    } catch (e) {
      toast({ tone: "bad", title: `Couldn’t remove ${a.title}`, description: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      {ov.installed.length ? (
        <Card flush>
          <ul className="plug-list">
            {ov.installed.map((a) => {
              const working = a.state === "pending" || a.state === "removing";
              return (
                <li className="plug-row" key={a.id}>
                  <IconTile src={a.iconUrl} size={40} />
                  <div className="plug-row__main">
                    <div className="plug-row__name">
                      <strong>{a.title}</strong>
                      <span className="mono faint small">{a.versionLabel}</span>
                    </div>
                    <p className="plug-row__desc mono small">
                      {a.filename}
                      {a.sizeBytes != null ? <span className="faint"> · {fmtBytes(a.sizeBytes)}</span> : null}
                    </p>
                    <p className="plug-row__status small">
                      {a.state === "pending" ? <Status tone="busy" label="Installing…" /> : null}
                      {a.state === "removing" ? <Status tone="busy" label="Removing…" /> : null}
                      {a.state === "failed" ? <Status tone="bad" label="Failed" /> : null}
                      {a.disabled && !working ? <span className="tag">Disabled</span> : null}
                      {a.pinned ? <span className="tag">Pinned</span> : null}
                      {a.isDependency ? <span className="tag">Dependency</span> : null}
                    </p>
                    {a.state === "failed" && a.error ? <p className="small addon-error">{a.error}</p> : null}
                  </div>
                  <div className="plug-row__actions">
                    {a.state === "failed" ? (
                      <Button size="sm" variant="danger" busy={busy === a.id} onClick={() => void remove(a)}>
                        Remove record
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" disabled={working || !actionable || busy === a.id} busy={busy === a.id} onClick={() => void patch(a, { disabled: !a.disabled }, a.disabled ? `${a.title} enabled` : `${a.title} disabled`, true)}>
                          {busy === a.id ? null : a.disabled ? <Power /> : <PowerOff />}
                          {a.disabled ? "Enable" : "Disable"}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger className={btn("ghost", "icon", "btn--sm")} aria-label={`More actions for ${a.title}`} disabled={working || busy === a.id}>
                            <MoreHorizontal />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="menu">
                            <DropdownMenuItem onClick={() => void patch(a, { pinned: !a.pinned }, a.pinned ? "Unpinned" : "Pinned: updates will skip it", false)}>
                              {a.pinned ? <PinOff /> : <Pin />} {a.pinned ? "Unpin" : "Pin version"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="is-danger" disabled={!actionable} onClick={() => void remove(a)}>
                              <Trash2 /> Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : (
        <Card>
          <Empty
            title={`No ${noun} installed from here`}
            action={
              <Button variant="primary" onClick={onBrowse}>
                Browse {noun}
              </Button>
            }
          >
            Things you install with Fledge show up here.
          </Empty>
        </Card>
      )}
      <Unmanaged id={id} noun={noun} revision={ov.installed.length} />
    </>
  );
}

function Unmanaged({ id, noun, revision }: { id: string; noun: string; revision: number }) {
  const [data, setData] = useState<AddonUnmanaged | null>(null),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    request<AddonUnmanaged>(`/servers/${id}/addons/unmanaged`)
      .then((r) => live && (setData(r), setError("")))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id, open, revision]);
  return (
    <details className="addon-details addon-unmanaged" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Other files in the folder</summary>
      <div className="addon-unmanaged__body">
        {loading && !data ? <Skeleton rows={2} /> : null}
        <ErrorNotice message={error} />
        {data && (
          <>
            <p className="small faint">
              Not installed by Fledge. These are shown for reference only{data.dir ? <> in <span className="mono">{data.dir}</span></> : null}.
            </p>
            {data.items.length ? (
              <ul className="addon-files">
                {data.items.map((f) => (
                  <li key={f.name}>
                    <span className="mono">{f.name}</span>
                    {f.disabled ? <span className="tag">Disabled</span> : null}
                    <span className="faint small num">{fmtBytes(f.size)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No other {noun} in the folder.</p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/* ---------- Updates ---------- */

function UpdatesList({
  id,
  updates,
  checking,
  error,
  actionable,
  backup: backupAvailable,
  onCheck,
  onDone,
}: {
  id: string;
  updates: AddonUpdates | null;
  checking: boolean;
  error: string;
  actionable: boolean;
  backup: boolean;
  onCheck: () => void;
  onDone: (restartRequired: boolean, skipped: string[]) => void;
}) {
  const toast = useToast();
  const [backup, setBackup] = useState(true),
    [busy, setBusy] = useState("");
  const list = updates?.updates ?? [];
  const movable = list.filter((u) => !u.pinned);

  async function run(ids: string[] | undefined, key: string) {
    setBusy(key);
    try {
      const r = (await json("POST", `/servers/${id}/addons/update`, { ...(ids ? { addonIds: ids } : {}), ...(backupAvailable ? { backupFirst: backup } : {}) })) as { queued?: unknown[]; skipped?: string[]; restartRequired?: boolean };
      const n = r.queued?.length ?? 0;
      toast({ tone: n ? "busy" : "neutral", title: n ? `Updating ${n} ${n === 1 ? "item" : "items"}…` : "Nothing to update" });
      onDone(!!r.restartRequired || n > 0, r.skipped || []);
    } catch (e) {
      toast({ tone: "bad", title: "Couldn’t start the update", description: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="small faint">{updates?.checkedAt ? `Checked ${fmtAgo(updates.checkedAt)}` : checking ? "Checking…" : "Not checked yet"}</span>
        <div className="btn-group">
          {backupAvailable && movable.length > 0 && (
            <label className="check-line">
              <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
              <span>Take a backup first</span>
            </label>
          )}
          <Button onClick={onCheck} busy={checking}>
            {checking ? null : <RefreshCw />}
            Check for updates
          </Button>
          {movable.length > 0 && (
            <Button variant="primary" disabled={!actionable} busy={busy === "all"} onClick={() => void run(undefined, "all")}>
              Update all ({movable.length})
            </Button>
          )}
        </div>
      </div>
      {error && !updates ? (
        <Notice tone="bad" title="Couldn’t check for updates">
          {error}
        </Notice>
      ) : !updates ? (
        <Card flush>
          <Skeleton rows={3} />
        </Card>
      ) : list.length ? (
        <Card flush>
          <ul className="plug-list">
            {list.map((u) => (
              <UpdateRow key={u.addonId} u={u} disabled={!actionable || !!busy} busy={busy === u.addonId} onUpdate={() => void run([u.addonId], u.addonId)} />
            ))}
          </ul>
        </Card>
      ) : (
        <Card>
          <Empty title="Everything is up to date">New versions that fit this server show up here.</Empty>
        </Card>
      )}
    </>
  );
}

function UpdateRow({ u, disabled, busy, onUpdate }: { u: AddonUpdate; disabled: boolean; busy: boolean; onUpdate: () => void }) {
  return (
    <li className="plug-row">
      <IconTile src={u.iconUrl} size={40} />
      <div className="plug-row__main">
        <div className="plug-row__name">
          <strong>{u.title}</strong>
          <Channel channel={u.latest.channel} />
        </div>
        <p className="plug-row__desc small">
          <span className="mono">{u.current.label}</span> <ArrowRight className="inline-arrow" aria-label="to" /> <span className="mono">{u.latest.label}</span>
          <span className="faint" title={fmtTime(u.latest.publishedAt)}> · {fmtDay(u.latest.publishedAt)}</span>
        </p>
        {u.latest.changelog ? (
          <details className="addon-details">
            <summary>Changelog</summary>
            <Markdown source={u.latest.changelog} />
          </details>
        ) : null}
      </div>
      <div className="plug-row__actions">
        {u.pinned ? (
          <span className="tag">Pinned: skipped</span>
        ) : (
          <Button size="sm" variant="primary" disabled={disabled} busy={busy} onClick={onUpdate} aria-label={`Update ${u.title}`}>
            Update
          </Button>
        )}
      </div>
    </li>
  );
}
