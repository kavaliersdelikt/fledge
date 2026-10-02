"use client";
import { json, request } from "@/lib/api";
import { fmtCpu, fmtMb } from "@/lib/format";
import { convertPterodactylEgg } from "@/lib/pterodactyl";
import { Copy, FileInput, Plus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Drawer } from "./feedback";
import { Button, Card, Empty, ErrorNotice, Notice, PageHeader, SearchInput, Segmented, State, Toolbar } from "./shared";

type Template = {
  id: string;
  name: string;
  image: string;
  startup?: string;
  internalPorts: { container: number; offset: number; protocol: string }[];
  env: Record<string, string>;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  editableVariables: string[];
  official: boolean;
};

const blank = {
  id: "my-game",
  name: "My game",
  image: "itzg/minecraft-server:java21-alpine",
  internalPorts: [{ container: 25565, offset: 0, protocol: "tcp" }],
  env: { EULA: "TRUE", TYPE: "VANILLA", ENABLE_RCON: "TRUE" },
  memoryMb: 2048,
  cpuPercent: 100,
  diskMb: 10240,
  editableVariables: ["MOTD", "MAX_PLAYERS"],
};

function parseError(source: string) {
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "The template must be a JSON object.";
    for (const key of ["id", "name", "image"]) if (typeof value[key] !== "string" || !value[key]) return `“${key}” is required.`;
    if (!Array.isArray(value.internalPorts) || !value.internalPorts.length) return "“internalPorts” needs at least one port.";
    return "";
  } catch (e) {
    return (e as Error).message.replace(/^JSON\.parse: /, "");
  }
}

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState<"all" | "included" | "custom">("all"),
    [editor, setEditor] = useState<string | null>(null),
    [warnings, setWarnings] = useState<string[]>([]),
    [importing, setImporting] = useState(false),
    [saved, setSaved] = useState("");

  async function load() {
    try {
      setTemplates(await request("/templates"));
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const list = templates.filter(
    (t) =>
      `${t.id} ${t.name} ${t.image}`.toLowerCase().includes(query.toLowerCase()) &&
      (kind === "all" || (kind === "included") === t.official),
  );
  const open = (value: object, notes: string[] = []) => {
    setEditor(JSON.stringify(value, null, 2));
    setWarnings(notes);
    setSaved("");
  };

  const columns: DataColumn<Template>[] = [
    {
      id: "name",
      header: "Template",
      value: (t) => t.name,
      render: (t) => (
        <div className="cell-main">
          <strong>
            {t.name} {t.official ? null : <span className="tag tag--accent" style={{ marginLeft: 6 }}>Custom</span>}
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
      render: (t) => (
        <span className="mono muted small">{t.internalPorts.map((p) => `${p.container}/${p.protocol}`).join(" ")}</span>
      ),
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
        <Button
          size="sm"
          variant="ghost"
          className="row-hover"
          onClick={() => {
            const { official: _official, ...draft } = t;
            open({ ...draft, id: `${t.id}-custom`, name: `${t.name} (custom)` });
          }}
        >
          <Copy /> Duplicate
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Templates"
        actions={
          <>
            <Button onClick={() => setImporting(true)}>
              <FileInput /> Import egg
            </Button>
            <Button variant="primary" onClick={() => open(blank)}>
              <Plus /> New template
            </Button>
          </>
        }
      />
      {saved && <Notice tone="ok">{saved}</Notice>}
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
        ) : <span />}
        {templates.length > 10 ? <SearchInput label="Search templates" placeholder="Search templates" value={query} onChange={setQuery} /> : null}
      </Toolbar>
      ) : null}
      <Card flush>
        <State loading={loading} error={loadError} rows={5}>
          {list.length ? (
            <DataTable data={list} columns={columns} rowKey={(t) => t.id} />
          ) : (
            <Empty title="No matching templates" />
          )}
        </State>
      </Card>

      <TemplateEditor
        value={editor}
        warnings={warnings}
        onChange={setEditor}
        onClose={() => setEditor(null)}
        onSaved={async (name) => {
          setEditor(null);
          setWarnings([]);
          setSaved(`Saved ${name}.`);
          await load();
        }}
      />
      <EggImport
        open={importing}
        onOpenChange={setImporting}
        onConverted={(template, notes) => {
          setImporting(false);
          open(template, notes);
        }}
      />
    </>
  );
}

function TemplateEditor({
  value,
  warnings,
  onChange,
  onClose,
  onSaved,
}: {
  value: string | null;
  warnings: string[];
  onChange: (v: string) => void;
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const invalid = value === null ? "" : parseError(value);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (value === null || invalid) return;
    setBusy(true);
    setError("");
    try {
      const body = JSON.parse(value);
      await json("POST", "/templates", body);
      await onSaved(body.name);
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      open={value !== null}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setError("");
        }
      }}
      title="Template"
      description="Use an ID that isn’t taken yet. The image must be on your panel’s allowlist."
      wide
    >
      {warnings.length > 0 && (
        <Notice tone="warn" title="Check these before saving">
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      <form className="form" onSubmit={save}>
        <label className="field">
          <span className="field__label">Configuration (JSON)</span>
          <textarea
            className="input"
            rows={22}
            spellCheck={false}
            value={value || ""}
            aria-invalid={!!invalid}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="field__hint" style={invalid ? { color: "var(--bad)" } : undefined}>
            {invalid || "Valid JSON."}
          </span>
        </label>
        <ErrorNotice message={error} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={busy} disabled={!!invalid}>
            Save template
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function EggImport({
  open,
  onOpenChange,
  onConverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConverted: (template: object, warnings: string[]) => void;
}) {
  const [source, setSource] = useState(""),
    [image, setImage] = useState("itzg/minecraft-server:java21-alpine"),
    [port, setPort] = useState("25565"),
    [protocol, setProtocol] = useState<"tcp" | "udp">("tcp"),
    [error, setError] = useState("");
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Import a Pterodactyl egg"
      description="Converts the portable parts of an egg export. You review the result before it’s saved."
      wide
    >
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
          <textarea
            className="input"
            rows={14}
            required
            spellCheck={false}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder='{ "name": "…", "docker_images": { … }, "variables": [ … ] }'
          />
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
