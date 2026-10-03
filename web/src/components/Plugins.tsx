"use client";
import {
  ApiError,
  json,
  request,
  type PluginInfo,
  type PluginInspect,
  type PluginList,
  type PluginLog,
  type PluginPermission,
  type PluginStore,
  type StoreItem,
} from "@/lib/api";
import { fmtAgo, fmtTime } from "@/lib/format";
import { Markdown, safeHref } from "@/lib/markdown";
import { Check, CircleAlert, ExternalLink, FileUp, MoreHorizontal, Puzzle, RefreshCw, RotateCcw, Settings2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Drawer, Modal, useConfirm } from "./feedback";
import { IconTile, TierBadge } from "./PluginBits";
import { useToast } from "./toast";
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Button,
  Card,
  Empty,
  ErrorNotice,
  Notice,
  PageHeader,
  SearchInput,
  Segmented,
  Skeleton,
  State,
  Status,
  Switch,
  Toolbar,
  btn,
  useLoad,
} from "./shared";

const MAX_PACKAGE = 2 * 1024 * 1024;

/** Reads a .fledgeplugin file as base64, which is what the API expects. */
async function readPackage(file: File) {
  if (file.size > MAX_PACKAGE) throw new Error("That file is larger than 2 MB, so it isn’t a plugin package.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type Target = { kind: "store"; item: StoreItem } | { kind: "upload"; name: string; data: string };
type Approval = { id: string; name: string; data?: string; perms: PluginPermission[]; message: string; lessTrusted?: { from: string; to: string } };

export default function Plugins() {
  const toast = useToast();
  const confirm = useConfirm();
  const list = useLoad<PluginList>("/plugins");
  const [store, setStore] = useState<PluginStore | null>(null),
    [storeError, setStoreError] = useState(""),
    [storeLoading, setStoreLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"store" | "installed">("store"),
    [query, setQuery] = useState(""),
    [wizard, setWizard] = useState<Target | null>(null),
    [configuring, setConfiguring] = useState<string | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false),
    [approval, setApproval] = useState<Approval | null>(null),
    [busyId, setBusyId] = useState(""),
    [fileError, setFileError] = useState("");
  const picker = useRef<HTMLInputElement>(null),
    pickerFor = useRef<{ id: string; name: string } | null>(null);
  const { reload } = list;

  const loadStore = useCallback(async (force = false) => {
    try {
      setStore(await request<PluginStore>(`/plugins/store${force ? "?refresh=1" : ""}`));
      setStoreError("");
    } catch (e) {
      setStoreError((e as Error).message);
    } finally {
      setStoreLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadStore();
  }, [loadStore]);
  const changed = useCallback(() => {
    void reload();
    void loadStore();
  }, [reload, loadStore]);

  const plugins = list.data?.plugins || [];
  const storeById = new Map((store?.items || []).map((i) => [i.id, i]));
  const allowCommunity = !!store?.allowCommunity;
  const q = query.trim().toLowerCase();
  const match = (...parts: (string | undefined | null)[]) => !q || parts.join(" ").toLowerCase().includes(q);

  async function refreshRegistry() {
    setRefreshing(true);
    await loadStore(true);
    setRefreshing(false);
  }

  async function toggle(p: PluginInfo, enabled: boolean) {
    setBusyId(p.id);
    try {
      await json("PATCH", `/plugins/${p.id}`, { enabled });
      toast({ tone: "ok", title: enabled ? `${p.name} is on` : `${p.name} is off` });
      changed();
    } catch (e) {
      toast({ tone: "bad", title: `Couldn’t turn ${enabled ? "on" : "off"} ${p.name}`, description: (e as Error).message });
    } finally {
      setBusyId("");
    }
  }

  async function runUpdate(id: string, name: string, data?: string, accept = false) {
    setBusyId(id);
    try {
      const next = await json("POST", `/plugins/${id}/update`, { ...(accept ? { acceptPermissions: true } : {}), ...(data ? { package: data } : {}) });
      toast({ tone: "ok", title: `${name} updated`, description: next?.version ? `Now on version ${next.version}.` : undefined });
      setApproval(null);
      changed();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.code === "permissions_changed" || e.code === "less_trusted")) {
        setApproval({ id, name, data, perms: e.details?.newPermissions || [], message: e.message, lessTrusted: e.code === "less_trusted" ? { from: String(e.details?.from ?? ""), to: String(e.details?.to ?? "") } : undefined });
      } else toast({ tone: "bad", title: `Couldn’t update ${name}`, description: (e as Error).message });
    } finally {
      setBusyId("");
    }
  }

  async function rollback(p: PluginInfo) {
    if (!(await confirm(`${p.name} goes back to version ${p.previousVersion}. Its settings stay as they are.`, { title: `Roll back ${p.name}?`, confirmLabel: "Roll back", danger: false }))) return;
    setBusyId(p.id);
    try {
      await json("POST", `/plugins/${p.id}/rollback`);
      toast({ tone: "ok", title: `${p.name} is back on ${p.previousVersion}` });
      changed();
    } catch (e) {
      toast({ tone: "bad", title: `Couldn’t roll back ${p.name}`, description: (e as Error).message });
    } finally {
      setBusyId("");
    }
  }

  async function uninstall(p: PluginInfo) {
    if (!(await confirm("Mods and plugins this plugin installed on servers stay in place. Its settings and saved keys are deleted.", { title: `Uninstall ${p.name}?`, confirmLabel: "Uninstall" }))) return;
    setBusyId(p.id);
    try {
      await request(`/plugins/${p.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: `${p.name} uninstalled` });
      if (configuring === p.id) setConfiguring(null);
      changed();
    } catch (e) {
      toast({ tone: "bad", title: `Couldn’t uninstall ${p.name}`, description: (e as Error).message });
    } finally {
      setBusyId("");
    }
  }

  async function onFile(file: File | undefined) {
    const target = pickerFor.current;
    pickerFor.current = null;
    if (picker.current) picker.current.value = "";
    if (!file) return;
    setFileError("");
    try {
      const data = await readPackage(file);
      if (target) await runUpdate(target.id, target.name, data);
      else setWizard({ kind: "upload", name: file.name, data });
    } catch (e) {
      setFileError((e as Error).message);
    }
  }
  const pickFile = (target: { id: string; name: string } | null = null) => {
    pickerFor.current = target;
    picker.current?.click();
  };

  const shownStore = (store?.items || []).filter((i) => match(i.name, i.description, i.author, i.id));
  const shownInstalled = plugins.filter((p) => match(p.name, p.description, p.author, p.id));
  const registryMessage = store?.registry.error
    ? /404|not found/i.test(store.registry.error)
      ? "No community plugins have been published yet. Built-in plugins are listed below."
      : `Couldn’t reach the plugin registry (${store.registry.error}). Built-in plugins still work.`
    : "";

  return (
    <>
      <PageHeader
        nav="plugins"
        title="Plugins"
        description="Add catalogs and integrations to your servers. Once a plugin is on, matching servers get a Mods or Plugins tab."
      />
      {list.data && !list.data.host.ok && (
        <Notice tone="warn" title="The plugin host isn’t reachable">
          Plugins can’t run until the plugin host service is back. You can still install and configure them; they start working once it reconnects.
          {list.data.host.error ? <> ({list.data.host.error})</> : null}
        </Notice>
      )}
      <Toolbar>
        <Segmented
          label="Plugin list"
          value={tab}
          onChange={setTab}
          options={[
            { value: "store", label: "Store" },
            { value: "installed", label: <>Installed <span className="count">{plugins.length}</span></> },
          ]}
        />
        <div className="btn-group plug-tools">
          <SearchInput label="Search plugins" placeholder="Search plugins" value={query} onChange={setQuery} />
          <Button onClick={refreshRegistry} busy={refreshing} title="Fetch the latest plugin list from the registry">
            {refreshing ? null : <RefreshCw />}
            Refresh registry
          </Button>
          <Button
            onClick={() => pickFile()}
            disabled={!allowCommunity}
            aria-describedby={!allowCommunity ? "plug-file-hint" : undefined}
            title={allowCommunity ? "Install a .fledgeplugin package from your computer" : "Turn on community plugins in Settings first"}
          >
            <FileUp /> Install from file…
          </Button>
          <Button onClick={() => setSettingsOpen(true)}>
            <Settings2 /> Settings
          </Button>
        </div>
      </Toolbar>
      <input ref={picker} type="file" accept=".fledgeplugin,.zip" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void onFile(e.target.files?.[0])} />
      {store && !allowCommunity && (
        <p id="plug-file-hint" className="plug-hint">
          Installing from a file needs community (unsigned) plugins turned on in Settings.
        </p>
      )}
      <ErrorNotice message={fileError} />

      {tab === "store" ? (
        <>
          {registryMessage && <Notice tone={/404|not found/i.test(store?.registry.error || "") ? "neutral" : "warn"}>{registryMessage}</Notice>}
          {storeLoading ? (
            <Card flush>
              <Skeleton rows={4} />
            </Card>
          ) : storeError ? (
            <Notice
              tone="bad"
              title="Couldn’t load the plugin store"
              action={
                <Button size="sm" onClick={() => void loadStore()}>
                  Try again
                </Button>
              }
            >
              {storeError}
            </Notice>
          ) : shownStore.length ? (
            <div className="plug-grid">
              {shownStore.map((item, i) => (
                <StoreCard
                  key={item.id}
                  item={item}
                  index={i}
                  busy={busyId === item.id}
                  onInstall={() => setWizard({ kind: "store", item })}
                  onUpdate={() => void runUpdate(item.id, item.name)}
                  onConfigure={() => setConfiguring(item.id)}
                />
              ))}
            </div>
          ) : (
            <Card>
              <Empty title={q ? "No plugins match that search" : "Nothing in the store yet"}>
                {q ? "Try a different word." : "Built-in plugins appear here. Refresh the registry to look for more."}
              </Empty>
            </Card>
          )}
        </>
      ) : (
        <State loading={list.loading} error={list.error} rows={4}>
          {shownInstalled.length ? (
            <Card flush>
              <ul className="plug-list">
                {shownInstalled.map((p) => (
                  <InstalledRow
                    key={p.id}
                    plugin={p}
                    storeItem={storeById.get(p.id)}
                    busy={busyId === p.id}
                    onToggle={(next) => void toggle(p, next)}
                    onConfigure={() => setConfiguring(p.id)}
                    onUpdate={() => (p.source === "upload" ? pickFile({ id: p.id, name: p.name }) : void runUpdate(p.id, p.name))}
                    onRollback={() => void rollback(p)}
                    onUninstall={() => void uninstall(p)}
                  />
                ))}
              </ul>
            </Card>
          ) : (
            <Card>
              <Empty
                title={q ? "No installed plugins match that search" : "No plugins installed yet"}
                action={
                  q ? undefined : (
                    <Button variant="primary" onClick={() => setTab("store")}>
                      Browse the store
                    </Button>
                  )
                }
              >
                {q ? "Try a different word." : "Install a catalog plugin to let people add mods and plugins to their servers."}
              </Empty>
            </Card>
          )}
        </State>
      )}

      <InstallWizard
        target={wizard}
        onClose={() => setWizard(null)}
        onChanged={changed}
        onConfigure={(id) => {
          setWizard(null);
          setConfiguring(id);
        }}
      />
      <PluginDrawer id={configuring} onClose={() => setConfiguring(null)} onChanged={changed} />
      <Modal open={settingsOpen} onOpenChange={setSettingsOpen} title="Plugin settings" description="Where Fledge looks for plugins and which ones it trusts." wide>
        <RegistrySettings
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            void loadStore(true);
          }}
        />
      </Modal>
      <Modal
        open={!!approval}
        onOpenChange={(o) => !o && setApproval(null)}
        title={`Approve the update to ${approval?.name || "this plugin"}?`}
        description={
          approval?.lessTrusted
            ? `This version is less trusted (${approval.lessTrusted.to || "unsigned"}) than the one installed (${approval.lessTrusted.from || "verified"}).`
            : approval?.perms.length
              ? "This version asks for permissions the installed one didn’t have."
              : approval?.message
        }
      >
        {approval?.perms.length ? <PermissionList permissions={approval.perms} /> : null}
        <div className="modal__actions">
          <Button onClick={() => setApproval(null)}>Cancel</Button>
          <Button variant="primary" busy={!!approval && busyId === approval.id} onClick={() => approval && void runUpdate(approval.id, approval.name, approval.data, true)}>
            Approve and update
          </Button>
        </div>
      </Modal>
    </>
  );
}

function PermissionList({ permissions }: { permissions: { id: string; text: string; granted?: boolean }[] }) {
  if (!permissions.length) return <p className="muted small">This plugin doesn’t ask for any permissions.</p>;
  return (
    <ul className="perm-list">
      {permissions.map((p) => (
        <li key={p.id}>
          {p.granted === false ? <CircleAlert className="perm-list__off" aria-hidden="true" /> : <Check aria-hidden="true" />}
          <span>
            {p.text}
            {p.granted === false ? <small> Needs your approval</small> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- Store ---------- */

function StoreCard({
  item,
  index,
  busy,
  onInstall,
  onUpdate,
  onConfigure,
}: {
  item: StoreItem;
  index: number;
  busy: boolean;
  onInstall: () => void;
  onUpdate: () => void;
  onConfigure: () => void;
}) {
  const reason = item.blockedReason || (!item.compatible ? item.incompatibleReason : null);
  const perms = item.permissions.length;
  return (
    <article className="plug-card" style={{ ["--i" as string]: index }} aria-labelledby={`plug-${item.id}`}>
      <header className="plug-card__head">
        <IconTile src={item.icon} size={44} />
        <div className="plug-card__title">
          <h2 id={`plug-${item.id}`}>{item.name}</h2>
          <span className="mono faint small">v{item.version}</span>
        </div>
        <TierBadge tier={item.tier} />
      </header>
      <p className="plug-card__desc">{item.description}</p>
      <p className="plug-card__meta small faint">
        by {item.author}
        <span className="sep"> · </span>
        <span title={perms ? item.permissions.map((p) => p.text).join("\n") : undefined}>
          {perms ? `${perms} permission${perms === 1 ? "" : "s"}` : "No permissions"}
        </span>
      </p>
      {reason ? (
        <p className="plug-card__reason small" role="note">
          {reason}
        </p>
      ) : null}
      <footer className="plug-card__foot">
        {item.installed ? (
          <>
            <span className="plug-card__state">
              <Check aria-hidden="true" /> Installed <span className="faint">v{item.installed.version}</span>
            </span>
            <span className="btn-group">
              {item.installed.updateAvailable ? (
                <Button size="sm" variant="primary" busy={busy} onClick={onUpdate} disabled={!item.installable}>
                  Update to v{item.version}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={onConfigure}>
                Configure
              </Button>
            </span>
          </>
        ) : (
          <>
            <span />
            <Button size="sm" variant="primary" onClick={onInstall} disabled={!item.installable} aria-label={`Install ${item.name}`}>
              Install
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}

/* ---------- Installed ---------- */

function InstalledRow({
  plugin: p,
  storeItem,
  busy,
  onToggle,
  onConfigure,
  onUpdate,
  onRollback,
  onUninstall,
}: {
  plugin: PluginInfo;
  storeItem?: StoreItem;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onConfigure: () => void;
  onUpdate: () => void;
  onRollback: () => void;
  onUninstall: () => void;
}) {
  const updateAvailable = !!storeItem?.installed?.updateAvailable && storeItem.installable;
  const autoOff = !p.enabled && !!p.disabledReason;
  const needsSetup = !p.enabled && p.missingSettings.length > 0;
  return (
    <li className="plug-row">
      <IconTile src={p.icon} size={40} />
      <div className="plug-row__main">
        <div className="plug-row__name">
          <strong>{p.name}</strong>
          <span className="mono faint small">v{p.version}</span>
          <TierBadge tier={p.tier} />
          {updateAvailable ? <span className="tag tag--accent">Update available</span> : null}
        </div>
        <p className="plug-row__desc">{p.description}</p>
        <p className="plug-row__status small">
          {autoOff ? (
            <Status tone="warn" label={<>Turned off automatically: {p.disabledReason}</>} />
          ) : (
            <Status value={p.enabled ? "active" : "stopped"} label={p.enabled ? "On" : "Off"} />
          )}
          {p.failureCount > 0 ? (
            <span className="faint" title={p.lastError || undefined}>
              {p.failureCount} recent {p.failureCount === 1 ? "failure" : "failures"}
            </span>
          ) : null}
          {needsSetup ? <span className="faint">Needs setup</span> : null}
        </p>
      </div>
      <div className="plug-row__actions">
        <Switch checked={p.enabled} busy={busy} onChange={onToggle} label={`${p.name} is ${p.enabled ? "on" : "off"}`} />
        <Button size="sm" onClick={onConfigure}>
          Configure
        </Button>
        {updateAvailable || p.source === "upload" ? (
          <Button size="sm" variant={updateAvailable ? "primary" : "secondary"} disabled={busy} onClick={onUpdate}>
            {p.source === "upload" ? "Update from file…" : `Update to v${storeItem?.version}`}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger className={btn("ghost", "icon", "btn--sm")} aria-label={`More actions for ${p.name}`} disabled={busy}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="menu">
            {p.hasPrevious ? (
              <DropdownMenuItem onClick={onRollback}>
                <RotateCcw /> Roll back to v{p.previousVersion}
              </DropdownMenuItem>
            ) : null}
            {p.hasPrevious ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem className="is-danger" onClick={onUninstall}>
              <Trash2 /> Uninstall
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/* ---------- Settings form (wizard and drawer) ---------- */

type FieldValue = string | boolean;

function initialValues(info: PluginInfo) {
  const out: Record<string, FieldValue> = {};
  for (const f of info.settingsSchema) {
    const stored = info.settings[f.key];
    if (f.type === "secret") out[f.key] = "";
    else if (f.type === "boolean") out[f.key] = typeof stored === "boolean" ? stored : typeof f.default === "boolean" ? f.default : false;
    else if (f.type === "select") out[f.key] = String(stored ?? f.default ?? f.options?.[0]?.value ?? "");
    else out[f.key] = stored == null || typeof stored === "object" ? String(f.default ?? "") : String(stored);
  }
  return out;
}

function SettingsForm({
  info,
  onSaved,
  submitLabel = "Save",
  allowTest = true,
  extra,
}: {
  info: PluginInfo;
  onSaved: (info: PluginInfo) => void;
  submitLabel?: string;
  allowTest?: boolean;
  extra?: ReactNode;
}) {
  const toast = useToast();
  const [values, setValues] = useState(() => initialValues(info)),
    [clear, setClear] = useState<Record<string, boolean>>({}),
    [busy, setBusy] = useState(false),
    [testing, setTesting] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const set = (key: string, value: FieldValue) => {
    setValues((v) => ({ ...v, [key]: value }));
    setResult(null);
  };

  function payload() {
    const body: Record<string, unknown> = {};
    for (const f of info.settingsSchema) {
      const v = values[f.key];
      if (f.type === "secret") {
        if (clear[f.key]) body[f.key] = "";
        else if (v !== "") body[f.key] = v; // omitted = keep what's stored
      } else if (f.type === "number") body[f.key] = v === "" ? null : Number(v);
      else body[f.key] = v;
    }
    return body;
  }

  async function save() {
    const next = (await json("PUT", `/plugins/${info.id}/settings`, payload())) as PluginInfo;
    setValues((v) => ({ ...v, ...Object.fromEntries(info.settingsSchema.filter((f) => f.type === "secret").map((f) => [f.key, ""])) }));
    setClear({});
    onSaved(next);
    return next;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await save();
      toast({ tone: "ok", title: "Settings saved" });
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (formRef.current && !formRef.current.reportValidity()) return;
    setTesting(true);
    setError("");
    setResult(null);
    try {
      await save();
      setResult((await json("POST", `/plugins/${info.id}/health`)) as { ok: boolean; message: string });
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setTesting(false);
    }
  }

  const fields = info.settingsSchema;
  return (
    <form className="form" ref={formRef} onSubmit={submit}>
      {fields.map((f) => {
        const id = `set-${info.id}-${f.key}`;
        const stored = info.settings[f.key];
        const secretSet = f.type === "secret" && !!stored && typeof stored === "object" && (stored as { set?: boolean }).set === true && !clear[f.key];
        const label = (
          <span className="field__label">
            {f.label}
            {f.required ? <span className="req" aria-hidden="true"> *</span> : <span className="faint"> (optional)</span>}
          </span>
        );
        if (f.type === "boolean")
          return (
            <div className="toggle-row" key={f.key}>
              <div>
                <strong id={id}>{f.label}</strong>
                {f.help ? <small>{f.help}</small> : null}
              </div>
              <Switch label={f.label} checked={values[f.key] === true} onChange={(v) => set(f.key, v)} />
            </div>
          );
        return (
          <label className="field" key={f.key} htmlFor={id}>
            {label}
            {f.type === "select" ? (
              <select id={id} className="input select" value={String(values[f.key])} required={f.required} onChange={(e) => set(f.key, e.target.value)}>
                {!f.required && !f.options?.some((o) => o.value === "") ? <option value="">Default</option> : null}
                {(f.options || []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === "secret" ? (
              <input
                id={id}
                className="input mono"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={String(values[f.key])}
                required={!!f.required && !secretSet}
                placeholder={secretSet ? "Saved. Leave empty to keep" : f.placeholder || ""}
                onChange={(e) => set(f.key, e.target.value)}
              />
            ) : f.type === "number" ? (
              <input
                id={id}
                className="input"
                type="number"
                inputMode="decimal"
                step="any"
                min={f.min}
                max={f.max}
                required={!!f.required}
                placeholder={f.placeholder || (f.default !== undefined ? String(f.default) : "")}
                value={String(values[f.key])}
                onChange={(e) => set(f.key, e.target.value)}
              />
            ) : (
              <input
                id={id}
                className="input"
                type="text"
                maxLength={500}
                pattern={f.pattern}
                required={!!f.required}
                placeholder={f.placeholder || (f.default !== undefined ? String(f.default) : "")}
                value={String(values[f.key])}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
            {f.help ? <span className="field__hint">{f.help}</span> : null}
            {secretSet && !f.required ? (
              <button type="button" className="text-button plug-clear" onClick={() => setClear((c) => ({ ...c, [f.key]: true }))}>
                Remove the saved value
              </button>
            ) : null}
            {f.type === "secret" && clear[f.key] ? <span className="field__hint">The saved value is removed when you save.</span> : null}
          </label>
        );
      })}
      {!fields.length ? <p className="muted">This plugin has nothing to configure.</p> : null}
      {result ? (
        <Notice tone={result.ok ? "ok" : "bad"} title={result.ok ? "Looks good" : "That didn’t work"}>
          {result.message}
        </Notice>
      ) : null}
      <ErrorNotice message={error} />
      <div className="form__actions">
        {fields.length ? (
          <Button type="submit" variant="primary" busy={busy}>
            {submitLabel}
          </Button>
        ) : null}
        <Button onClick={test} busy={testing} disabled={!allowTest || busy} title={fields.length ? "Saves your changes, then checks that the plugin can connect" : undefined}>
          {fields.length ? "Test connection" : "Run health check"}
        </Button>
        {extra}
      </div>
    </form>
  );
}

/* ---------- Install wizard ---------- */

type Step = "review" | "configure" | "enable" | "done";

function InstallWizard({
  target,
  onClose,
  onChanged,
  onConfigure,
}: {
  target: Target | null;
  onClose: () => void;
  onChanged: () => void;
  onConfigure: (id: string) => void;
}) {
  return (
    <Modal
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={target ? (target.kind === "store" ? `Install ${target.item.name}` : "Install from file") : "Install"}
      description={target?.kind === "store" ? `Version ${target.item.version} by ${target.item.author}` : target ? target.name : undefined}
      wide
    >
      {target ? <WizardBody key={target.kind === "store" ? target.item.id : target.name} target={target} onClose={onClose} onChanged={onChanged} onConfigure={onConfigure} /> : null}
    </Modal>
  );
}

function WizardBody({ target, onClose, onChanged, onConfigure }: { target: Target; onClose: () => void; onChanged: () => void; onConfigure: (id: string) => void }) {
  const upload = target.kind === "upload";
  // Registry and uploaded packages are inspected first, so what they ask for is shown before anything is installed.
  const inspect = upload || target.item.source === "registry";
  const [step, setStep] = useState<Step>("review"),
    [info, setInfo] = useState<PluginInfo | null>(null),
    [preview, setPreview] = useState<PluginInspect | null>(null),
    [inspecting, setInspecting] = useState(inspect),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  useEffect(() => {
    if (!inspect) return;
    let live = true;
    json("POST", "/plugins/inspect", upload ? { source: "upload", package: target.data } : { source: "registry", id: target.item.id })
      .then((r) => live && setPreview(r as PluginInspect))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setInspecting(false));
    return () => {
      live = false;
    };
    // The target never changes for the life of this component (it is keyed by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tier = preview?.tier ?? (upload ? "community" : target.item.tier);
  const permissions: PluginPermission[] = preview?.permissions ?? (upload ? [] : target.item.permissions);
  const blocked = preview?.blockedReason || (!upload ? target.item.blockedReason : null);
  const already = preview?.installed;

  async function turnOn(plugin: PluginInfo) {
    setBusy(true);
    setError("");
    try {
      setInfo((await json("PATCH", `/plugins/${plugin.id}`, { enabled: true })) as PluginInfo);
      setStep("done");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      setStep("enable");
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setBusy(true);
    setError("");
    try {
      const created = (await json("POST", "/plugins", upload ? { source: "upload", package: target.data, acceptPermissions: true } : { source: target.item.source, id: target.item.id, acceptPermissions: true })) as PluginInfo;
      setInfo(created);
      onChanged();
      if (created.settingsSchema.length) setStep("configure");
      else await turnOn(created);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const stepIndex = { review: 0, configure: 1, enable: 2, done: 3 }[step];
  const labels = ["Review", "Configure", "Turn on"];
  return (
    <div className="wizard">
      <ol className="wizard__steps" aria-label="Progress">
        {labels.map((l, i) => (
          <li key={l} aria-current={i === stepIndex ? "step" : undefined} className={i < stepIndex ? "is-done" : i === stepIndex ? "is-now" : ""}>
            <span className={`step${i < stepIndex ? " is-done" : ""}`}>{i < stepIndex ? <Check aria-hidden="true" /> : i + 1}</span>
            {l}
          </li>
        ))}
      </ol>

      {step === "review" && (
        <>
          {inspecting ? (
            <Skeleton rows={3} />
          ) : (
            <>
              {preview && upload && (
                <div className="drawer-id">
                  <IconTile src={preview.icon} size={44} />
                  <div>
                    <strong>{preview.name}</strong>
                    <div className="small faint">
                      <span className="mono">v{preview.version}</span> · by {preview.author}
                    </div>
                  </div>
                  <TierBadge tier={preview.tier} />
                </div>
              )}
              {preview && upload ? <p className="muted">{preview.description}</p> : null}
              {blocked && (
                <Notice tone="bad" title="Can’t be installed">
                  {blocked}
                </Notice>
              )}
              {already && (
                <Notice tone="warn" title={`Already installed (v${already.version})`}>
                  Use Update on the Installed tab to change versions.
                </Notice>
              )}
              {tier === "community" && !blocked && (
                <Notice tone="warn" title={upload ? "This file is unsigned" : "Community plugin"}>
                  This plugin is unsigned, so Fledge can’t vouch for who made it. Only continue if you trust the source.
                </Notice>
              )}
              {preview || !inspect ? (
                <section aria-labelledby="perm-title" className="wizard__section">
                  <h3 id="perm-title">This plugin will be able to</h3>
                  <PermissionList permissions={permissions} />
                </section>
              ) : null}
            </>
          )}
          <label className="check-line">
            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
            <span>I understand and approve</span>
          </label>
          <ErrorNotice message={error} />
          <div className="modal__actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!approved || inspecting || (inspect && !preview) || !!blocked || !!already} busy={busy} onClick={() => void install()}>
              Install
            </Button>
          </div>
        </>
      )}

      {step === "configure" && info && (
        <>
          <p className="muted">
            {info.missingSettings.length ? "Fill in what this plugin needs, then continue." : "Adjust anything you like, or skip this for now. You can change it later."}
          </p>
          <SettingsForm
            info={info}
            submitLabel="Save and continue"
            onSaved={(next) => {
              setInfo(next);
              setStep("enable");
            }}
            extra={
              !info.missingSettings.length ? (
                <Button variant="ghost" onClick={() => setStep("enable")}>
                  Skip for now
                </Button>
              ) : null
            }
          />
        </>
      )}

      {step === "enable" && info && (
        <>
          <p className="muted">{info.name} is installed but still off. Turn it on to make it available to servers.</p>
          {info.missingSettings.length ? (
            <Notice tone="warn" title="Required settings are missing">
              {info.missingSettings.join(", ")}
            </Notice>
          ) : null}
          <ErrorNotice message={error} />
          <div className="modal__actions">
            <Button onClick={() => setStep("configure")} disabled={!info.settingsSchema.length}>
              Back to settings
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void turnOn(info)}>
              Turn on
            </Button>
          </div>
        </>
      )}

      {step === "done" && info && (
        <>
          <p className="muted">{info.name} is installed and turned on. You can change its settings or turn it off later.</p>
          <div className="modal__actions">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
            <Button variant="ghost" onClick={() => onConfigure(info.id)}>
              Configure
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Configure drawer ---------- */

function PluginDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [shown, setShown] = useState<string | null>(id);
  useEffect(() => {
    if (id) setShown(id);
  }, [id]);
  return (
    <Drawer open={!!id} onOpenChange={(o) => !o && onClose()} title="Configure plugin" description="Settings, permissions and logs" wide>
      {shown ? <DrawerBody key={shown} id={shown} onChanged={onChanged} /> : null}
    </Drawer>
  );
}

function DrawerBody({ id, onChanged }: { id: string; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<PluginInfo>(`/plugins/${id}`);
  const [info, setInfo] = useState<PluginInfo | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setInfo(data);
  }, [data]);
  const p = info || data;
  if (loading && !p) return <Skeleton rows={5} />;
  if (!p) return <ErrorNotice message={error || "This plugin isn’t installed any more."} />;

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      setInfo((await json("PATCH", `/plugins/${id}`, { enabled })) as PluginInfo);
      toast({ tone: "ok", title: enabled ? `${p!.name} is on` : `${p!.name} is off` });
      onChanged();
    } catch (e) {
      toast({ tone: "bad", title: `Couldn’t turn ${enabled ? "on" : "off"} ${p!.name}`, description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const homepage = safeHref(p.homepage || "");

  return (
    <>
      <div className="drawer-id">
        <IconTile src={p.icon} size={48} />
        <div>
          <strong>{p.name}</strong>
          <div className="small faint">
            <span className="mono">v{p.version}</span> · by {p.author}
          </div>
        </div>
        <TierBadge tier={p.tier} />
        <div className="drawer-id__switch">
          <Status value={p.enabled ? "active" : "stopped"} label={p.enabled ? "On" : "Off"} />
          <Switch checked={p.enabled} busy={busy} onChange={(v) => void toggle(v)} label={`${p.name} is ${p.enabled ? "on" : "off"}`} />
        </div>
      </div>
      {!p.enabled && p.disabledReason ? (
        <Notice tone="warn" title="Turned off automatically">
          {p.disabledReason}
        </Notice>
      ) : null}
      {p.lastError && p.failureCount > 0 ? (
        <Notice tone="bad" title={`${p.failureCount} recent ${p.failureCount === 1 ? "failure" : "failures"}`}>
          {p.lastError}
        </Notice>
      ) : null}
      <Tabs defaultValue="settings">
        <TabsList aria-label="Plugin sections">
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsIndicator />
        </TabsList>
        <TabsContent value="settings">
          <SettingsForm
            info={p}
            onSaved={(next) => {
              setInfo(next);
              onChanged();
            }}
          />
        </TabsContent>
        <TabsContent value="permissions">
          <PermissionList permissions={p.permissions} />
          {p.catalogs.length ? (
            <section className="wizard__section">
              <h3>Catalogs</h3>
              <ul className="perm-list">
                {p.catalogs.map((c) => (
                  <li key={c.id}>
                    <Puzzle aria-hidden="true" />
                    <span>
                      {c.label} <small>{c.kind === "mod" ? "Mods" : c.kind === "plugin" ? "Plugins" : c.kind}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </TabsContent>
        <TabsContent value="about">
          <p>{p.description}</p>
          <dl className="plug-facts">
            <div>
              <dt>License</dt>
              <dd>{p.license || "—"}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{p.source === "bundled" ? "Ships with Fledge" : p.source === "registry" ? "Plugin registry" : "Uploaded file"}</dd>
            </div>
            <div>
              <dt>Installed</dt>
              <dd>{fmtTime(p.installedAt)}</dd>
            </div>
            {homepage ? (
              <div>
                <dt>Homepage</dt>
                <dd>
                  <a className="card-link" href={homepage} target="_blank" rel="noopener noreferrer">
                    {new URL(homepage).hostname} <ExternalLink />
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
          {p.readme ? <Markdown source={p.readme} /> : null}
          {p.changelog ? (
            <section className="wizard__section">
              <h3>Changelog</h3>
              <Markdown source={p.changelog} />
            </section>
          ) : null}
        </TabsContent>
        <TabsContent value="logs">
          <PluginLogs id={id} onRefreshed={() => void reload()} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function PluginLogs({ id, onRefreshed }: { id: string; onRefreshed: () => void }) {
  const { data, error, loading, reload } = useLoad<PluginLog[]>(`/plugins/${id}/logs?limit=100`);
  return (
    <>
      <div className="toolbar">
        <span className="small faint">The 100 most recent entries</span>
        <Button
          size="sm"
          onClick={() => {
            void reload();
            onRefreshed();
          }}
        >
          <RefreshCw /> Refresh
        </Button>
      </div>
      <State loading={loading} error={error} rows={4}>
        {data?.length ? (
          <ul className="plug-logs">
            {data.map((l) => (
              <li key={l.id}>
                <span className={`tag log-level log-level--${l.level}`}>{l.level}</span>
                <span className="plug-logs__msg">{l.message}</span>
                <time className="faint small" dateTime={l.at} title={fmtTime(l.at)}>
                  {fmtAgo(l.at)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No log entries yet">Anything this plugin reports shows up here.</Empty>
        )}
      </State>
    </>
  );
}

/* ---------- Registry settings ---------- */

type RegistryConfig = { registryUrl: string; trustedKeys: string[]; allowCommunity: boolean };

function RegistrySettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { data, error, loading } = useLoad<{ plugins: RegistryConfig }>("/settings");
  const [url, setUrl] = useState<string | null>(null),
    [keys, setKeys] = useState(""),
    [community, setCommunity] = useState(false),
    [busy, setBusy] = useState(false),
    [saveError, setSaveError] = useState("");
  useEffect(() => {
    if (!data?.plugins) return;
    setUrl(data.plugins.registryUrl || "");
    setKeys((data.plugins.trustedKeys || []).join("\n"));
    setCommunity(!!data.plugins.allowCommunity);
  }, [data]);
  if (loading) return <Skeleton rows={4} />;
  if (error || url === null) return <ErrorNotice message={error || "Settings are unavailable."} />;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaveError("");
    try {
      await json("PUT", "/settings/plugins", {
        registryUrl: url!.trim(),
        trustedKeys: keys.split(/\r?\n/).map((k) => k.trim()).filter(Boolean),
        allowCommunity: community,
      });
      toast({ tone: "ok", title: "Plugin settings saved" });
      onSaved();
    } catch (ex) {
      setSaveError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form" onSubmit={save}>
      <label className="field">
        <span className="field__label">Registry URL</span>
        <input className="input mono" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/plugins/index.json" />
        <span className="field__hint">A list of plugins Fledge can offer in the store. Leave empty to show built-in plugins only.</span>
      </label>
      <label className="field">
        <span className="field__label">Trusted public keys</span>
        <textarea className="input" rows={4} spellCheck={false} value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="One key per line" />
        <span className="field__hint">Plugins signed by one of these keys show as Verified.</span>
      </label>
      <div className="toggle-row">
        <div>
          <strong id="community-label">Allow community (unsigned) plugins</strong>
          <small>Lets you install plugins that nobody has vouched for, including files from your computer.</small>
        </div>
        <Switch label="Allow community (unsigned) plugins" checked={community} onChange={setCommunity} />
      </div>
      {community && (
        <Notice tone="warn" title="Only install plugins you trust">
          An unsigned plugin can do anything its permissions allow, such as contacting the addresses it lists or changing files on servers you confirm installs for. Fledge can’t check who wrote it.
        </Notice>
      )}
      <ErrorNotice message={saveError} />
      <div className="modal__actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
