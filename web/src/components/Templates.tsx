"use client";
import { json, request, type TemplateFull, type TemplateOutdated } from "@/lib/api";
import { fmtCpu, fmtMb } from "@/lib/format";
import { convertPterodactylEgg } from "@/lib/pterodactyl";
import { Copy, Download, FileInput, FileUp, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Drawer, Modal, useConfirm } from "./feedback";
import TemplateEditor, { fallbackAddons, type Seed } from "./TemplateEditor";
import { useToast } from "./toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button, Card, Empty, ErrorNotice, Notice, PageHeader, SearchInput, Segmented, Skeleton, State, Toolbar, btn } from "./shared";

const blank: Seed = {
  id: "",
  name: "",
  image: "itzg/minecraft-server:java21-alpine",
  internalPorts: [{ container: 25565, offset: 0, protocol: "tcp" }],
  env: { EULA: "TRUE", TYPE: "VANILLA", ENABLE_RCON: "TRUE" },
  memoryMb: 2048,
  cpuPercent: 100,
  diskMb: 10240,
  variables: [
    { key: "MAX_PLAYERS", label: "Maximum players", type: "number", min: 1, max: 1000, userEditable: true },
    { key: "MOTD", label: "Message of the day", type: "string", userEditable: true },
  ],
};

type EditorState = { existing: TemplateFull | null; seed: Seed; warnings: string[] };

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Templates() {
  const toast = useToast();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<TemplateFull[]>([]),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState<"all" | "included" | "custom">("all"),
    [editor, setEditor] = useState<EditorState | null>(null),
    [importing, setImporting] = useState(false),
    [importDoc, setImportDoc] = useState<{ document: any; name: string } | null>(null),
    [outdated, setOutdated] = useState<{ id: string; name: string } | null>(null),
    [pageError, setPageError] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await request<TemplateFull[]>("/templates"));
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const list = templates.filter(
    (t) => `${t.id} ${t.name} ${t.image} ${t.description || ""}`.toLowerCase().includes(query.toLowerCase()) && (kind === "all" || (kind === "included") === t.official),
  );
  // The add-on rules Fledge seeds for Minecraft, reused as the preset.
  const preset = templates.find((t) => t.id === "minecraft-java")?.addons || fallbackAddons;

  async function exportTemplate(t: TemplateFull, includeEnv: boolean) {
    try {
      const doc = await request(`/templates/${t.id}/export${includeEnv ? "" : "?includeEnv=0"}`);
      download(`${t.id}.fledge-template.json`, doc);
    } catch (e) {
      toast({ tone: "bad", title: "Couldn’t export", description: (e as Error).message });
    }
  }
  async function remove(t: TemplateFull) {
    if (!(await confirm(`${t.name} is removed from the template list. Servers already created from it aren’t affected, but the API refuses if any still use it.`, { title: `Delete ${t.name}?`, confirmLabel: "Delete" }))) return;
    try {
      await request(`/templates/${t.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: `${t.name} deleted` });
      void load();
    } catch (e) {
      toast({ tone: "bad", title: "Couldn’t delete", description: (e as Error).message });
    }
  }
  async function onFile(file: File | undefined) {
    if (picker.current) picker.current.value = "";
    if (!file) return;
    setPageError("");
    try {
      if (file.size > 1024 * 1024) throw new Error("That file is too large to be a template.");
      const doc = JSON.parse(await file.text());
      if (!doc || doc.format !== "fledge-template" || !doc.template) throw new Error("This isn’t a Fledge template export.");
      setImportDoc({ document: doc, name: file.name });
    } catch (e) {
      setPageError(e instanceof SyntaxError ? "That file isn’t valid JSON." : (e as Error).message);
    }
  }

  const columns: DataColumn<TemplateFull>[] = [
    {
      id: "name",
      header: "Template",
      value: (t) => t.name,
      render: (t) => (
        <div className="cell-main">
          <strong>
            {t.name} <span className="tag tpl-version" title="Template version">v{t.version}</span>
            {t.official ? null : <span className="tag tag--accent" style={{ marginLeft: 6 }}>Custom</span>}
          </strong>
          <small className="mono">{t.image}</small>
        </div>
      ),
    },
    {
      id: "ports",
      header: "Ports",
      optional: true,
      value: (t) => t.internalPorts.map((p) => p.container).join(","),
      render: (t) => <span className="mono muted small">{t.internalPorts.map((p) => `${p.container}/${p.protocol}`).join(" ")}</span>,
    },
    {
      id: "defaults",
      header: "Defaults",
      optional: true,
      value: (t) => t.memoryMb,
      render: (t) => (
        <span className="muted small num">
          {fmtMb(t.memoryMb)} · {fmtCpu(t.cpuPercent)} · {fmtMb(t.diskMb)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (t) => (
        <div className="row-actions">
          <Button size="sm" variant="ghost" className="row-hover" onClick={() => setEditor({ existing: t, seed: t, warnings: [] })}>
            <Pencil /> Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className={btn("ghost", "icon", "btn--sm row-hover")} aria-label={`More actions for ${t.name}`}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="menu">
              <DropdownMenuItem onClick={() => setEditor({ existing: null, seed: { ...t, id: `${t.id}-copy`, name: `${t.name} (copy)` }, warnings: [] })}>
                <Copy /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setOutdated({ id: t.id, name: t.name })}>
                <RefreshCw /> Update servers…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void exportTemplate(t, true)}>
                <Download /> Export
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportTemplate(t, false)}>
                <Download /> Export without environment
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="is-danger" disabled={t.official} onClick={() => void remove(t)}>
                <Trash2 /> {t.official ? "Included templates can’t be deleted" : "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Templates"
        actions={
          <>
            <Button onClick={() => picker.current?.click()}>
              <FileUp /> Import
            </Button>
            <Button onClick={() => setImporting(true)}>
              <FileInput /> Import egg
            </Button>
            <Button variant="primary" onClick={() => setEditor({ existing: null, seed: blank, warnings: [] })}>
              <Plus /> New template
            </Button>
          </>
        }
      />
      <input ref={picker} type="file" accept=".json,application/json" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void onFile(e.target.files?.[0])} />
      <ErrorNotice message={pageError} />
      {templates.some((t) => !t.official) || templates.length > 10 ? (
        <Toolbar>
          {templates.some((t) => !t.official) ? (
            <Segmented
              label="Template source"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: <>All <span className="count">{templates.length}</span></> },
                { value: "included", label: <>Included <span className="count">{templates.filter((t) => t.official).length}</span></> },
                { value: "custom", label: <>Custom <span className="count">{templates.filter((t) => !t.official).length}</span></> },
              ]}
            />
          ) : (
            <span />
          )}
          {templates.length > 10 ? <SearchInput label="Search templates" placeholder="Search templates" value={query} onChange={setQuery} /> : null}
        </Toolbar>
      ) : null}
      <Card flush>
        <State loading={loading} error={loadError} rows={5}>
          {list.length ? <DataTable data={list} columns={columns} rowKey={(t) => t.id} /> : <Empty title="No matching templates" />}
        </State>
      </Card>

      <TemplateEditor
        open={!!editor}
        existing={editor?.existing ?? null}
        seed={editor?.seed ?? blank}
        warnings={editor?.warnings ?? []}
        addonPreset={preset}
        onClose={() => setEditor(null)}
        onSaved={async (saved, previous) => {
          setEditor(null);
          const bumped = previous !== null && saved.version > previous;
          toast({ tone: "ok", title: previous === null ? `Created ${saved.name}` : `Saved ${saved.name}`, description: bumped ? `This is now version ${saved.version}.` : undefined });
          await load();
          if (bumped) {
            try {
              const o = await request<TemplateOutdated>(`/templates/${saved.id}/outdated`);
              if (o.servers.length) setOutdated({ id: saved.id, name: saved.name });
            } catch {
              /* the dialog is also reachable from the row menu */
            }
          }
        }}
      />
      <EggImport
        open={importing}
        onOpenChange={setImporting}
        onConverted={(template, notes) => {
          setImporting(false);
          setEditor({ existing: null, seed: template, warnings: notes });
        }}
      />
      <ImportDialog
        doc={importDoc}
        onClose={() => setImportDoc(null)}
        onDone={() => {
          void load();
        }}
      />
      <OutdatedDialog template={outdated} onClose={() => setOutdated(null)} onApplied={() => void load()} />
    </>
  );
}

/* ---------- Import a Fledge export ---------- */

function ImportDialog({ doc, onClose, onDone }: { doc: { document: any; name: string } | null; onClose: () => void; onDone: () => void }) {
  return (
    <Modal open={!!doc} onOpenChange={(o) => !o && onClose()} title="Import template" description={doc ? doc.name : undefined}>
      {doc ? <ImportBody key={doc.name} doc={doc.document} onClose={onClose} onDone={onDone} /> : null}
    </Modal>
  );
}

function ImportBody({ doc, onClose, onDone }: { doc: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [id, setId] = useState<string>(String(doc.template?.id || "")),
    [overwrite, setOverwrite] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [warnings, setWarnings] = useState<string[] | null>(null);
  const idOk = /^[a-z0-9][a-z0-9-]*$/.test(id);
  async function run() {
    setBusy(true);
    setError("");
    try {
      const r = (await json("POST", "/templates/import", { document: doc, id: id !== doc.template?.id ? id : undefined, overwrite })) as { template: TemplateFull; warnings: string[] };
      onDone();
      if (r.warnings.length) setWarnings(r.warnings);
      else {
        toast({ tone: "ok", title: `Imported ${r.template.name}` });
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (warnings)
    return (
      <div className="wizard">
        <Notice tone="warn" title="Imported, with notes">
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Notice>
        <div className="modal__actions">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  return (
    <div className="wizard">
      <p className="muted">
        <strong>{String(doc.template?.name || "Unnamed template")}</strong> · {String(doc.template?.image || "")}
      </p>
      <label className="field">
        <span className="field__label">Template ID</span>
        <input className="input mono" value={id} aria-invalid={!idOk} onChange={(e) => setId(e.target.value.toLowerCase())} />
        <span className="field__hint">Change it to import next to an existing template.</span>
      </label>
      <label className="check-line">
        <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
        <span>Replace the template if the ID already exists</span>
      </label>
      <ErrorNotice message={error} />
      <div className="modal__actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!idOk} onClick={() => void run()}>
          Import
        </Button>
      </div>
    </div>
  );
}

/* ---------- Servers on an older version ---------- */

function OutdatedDialog({ template, onClose, onApplied }: { template: { id: string; name: string } | null; onClose: () => void; onApplied: () => void }) {
  return (
    <Modal open={!!template} onOpenChange={(o) => !o && onClose()} title={template ? `Update servers on ${template.name}` : "Update servers"} description="Applying a new version recreates each server’s container, so it restarts briefly. Files are kept." wide>
      {template ? <OutdatedBody key={template.id} template={template} onClose={onClose} onApplied={onApplied} /> : null}
    </Modal>
  );
}

function OutdatedBody({ template, onClose, onApplied }: { template: { id: string; name: string }; onClose: () => void; onApplied: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<TemplateOutdated | null>(null),
    [error, setError] = useState(""),
    [picked, setPicked] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [skipped, setSkipped] = useState<{ id: string; reason: string }[]>([]);
  useEffect(() => {
    let live = true;
    request<TemplateOutdated>(`/templates/${template.id}/outdated`)
      .then((r) => {
        if (!live) return;
        setData(r);
        setPicked(new Set(r.servers.filter((s) => s.canApply).map((s) => s.id)));
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [template.id]);

  async function apply() {
    setBusy(true);
    setError("");
    try {
      const r = (await json("POST", `/templates/${template.id}/apply`, { confirm: true, serverIds: [...picked] })) as { queued: number; skipped: { id: string; reason: string }[] };
      toast({ tone: r.queued ? "busy" : "neutral", title: r.queued ? `Updating ${r.queued} ${r.queued === 1 ? "server" : "servers"}…` : "Nothing was updated" });
      onApplied();
      if (r.skipped.length) {
        setSkipped(r.skipped);
        setData((d) => (d ? { ...d, servers: [] } : d));
      } else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <ErrorNotice message={error} />;
  if (!data) return <Skeleton rows={3} />;
  const nameOf = (id: string) => data.servers.find((s) => s.id === id)?.name || id.slice(0, 8);
  return (
    <div className="wizard">
      {skipped.length > 0 && (
        <Notice tone="warn" title="Some servers were skipped">
          <ul>
            {skipped.map((s) => (
              <li key={s.id}>
                {nameOf(s.id)}: {s.reason}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {data.servers.length ? (
        <>
          <p className="muted small">
            {template.name} is now on version {data.template.version}. These servers still run an older one.
          </p>
          <ul className="plan-items">
            {data.servers.map((s) => (
              <li key={s.id} className="plan-item">
                <label className={`plan-item__label${s.canApply ? "" : " is-fixed"}`}>
                  <input
                    type="checkbox"
                    disabled={!s.canApply || busy}
                    checked={picked.has(s.id)}
                    onChange={() =>
                      setPicked((p) => {
                        const next = new Set(p);
                        if (next.has(s.id)) next.delete(s.id);
                        else next.add(s.id);
                        return next;
                      })
                    }
                  />
                  <span className="plan-item__text">
                    <strong>{s.name}</strong>
                    <small>
                      {s.ownerEmail} · v{s.fromVersion} → v{s.toVersion}
                    </small>
                    {s.blocker ? <small className="tpl-blocker">{s.blocker}</small> : null}
                  </span>
                </label>
                <span className="plan-item__tags">
                  {s.changes.map((c) => (
                    <span key={c} className="tag">
                      {c}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Empty title={skipped.length ? "That’s everything we could apply" : "All servers are up to date"}>{skipped.length ? "Skipped servers need attention first." : "No server runs an older version of this template."}</Empty>
      )}
      <ErrorNotice message={error} />
      <div className="modal__actions">
        <Button onClick={onClose}>{data.servers.length ? "Not now" : "Close"}</Button>
        {data.servers.length > 0 && (
          <Button variant="primary" busy={busy} disabled={!picked.size} onClick={() => void apply()}>
            Apply to {picked.size} {picked.size === 1 ? "server" : "servers"}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ---------- Pterodactyl egg ---------- */

function EggImport({
  open,
  onOpenChange,
  onConverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConverted: (template: Seed, warnings: string[]) => void;
}) {
  const [source, setSource] = useState(""),
    [image, setImage] = useState("itzg/minecraft-server:java21-alpine"),
    [port, setPort] = useState("25565"),
    [protocol, setProtocol] = useState<"tcp" | "udp">("tcp"),
    [error, setError] = useState("");
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Import a Pterodactyl egg" description="Converts the portable parts of an egg export. You review the result before it’s saved." wide>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          try {
            const parsed = convertPterodactylEgg(JSON.parse(source), { image, port: Number(port), protocol });
            onConverted(parsed.template, parsed.warnings);
            setSource("");
          } catch (ex) {
            setError((ex as Error).message);
          }
        }}
      >
        <label className="field">
          <span className="field__label">Egg export</span>
          <textarea className="input" rows={14} required spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} placeholder='{ "name": "…", "docker_images": { … }, "variables": [ … ] }' />
        </label>
        <label className="field">
          <span className="field__label">Docker image</span>
          <input className="input mono" value={image} onChange={(e) => setImage(e.target.value)} />
          <span className="field__hint">Pterodactyl’s own images usually don’t work outside Wings; pick one your nodes allow.</span>
        </label>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Game port</span>
            <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Protocol</span>
            <select className="input select" value={protocol} onChange={(e) => setProtocol(e.target.value as "tcp" | "udp")}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          </label>
        </div>
        <ErrorNotice message={error} />
        <div className="form__actions">
          <Button type="submit" variant="primary">
            Convert
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
