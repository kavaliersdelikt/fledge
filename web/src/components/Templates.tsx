"use client";
import { json,request } from "@/lib/api";
import { convertPterodactylEgg } from "@/lib/pterodactyl";
import { Box,Copy,FileInput,LoaderCircle,Plus } from "lucide-react";
import { useEffect,useState,type FormEvent } from "react";
import { Modal } from "./feedback";
import { Notice } from "./shared";

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
export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]),
    [editor, setEditor] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [showConverter, setShowConverter] = useState(false),
    [source, setSource] = useState(""),
    [image, setImage] = useState("itzg/minecraft-server:java21-alpine"),
    [port, setPort] = useState("25565"),
    [protocol, setProtocol] = useState<"tcp" | "udp">("tcp"),
    [warnings, setWarnings] = useState<string[]>([]);
  async function load() {
    try {
      setTemplates(await request("/templates"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await json("POST", "/templates", JSON.parse(editor));
      setEditor("");
      setWarnings([]);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function convert() {
    setError("");
    setWarnings([]);
    try {
      const parsed = convertPterodactylEgg(JSON.parse(source), {
        image,
        port: Number(port),
        protocol,
      });
      setEditor(JSON.stringify(parsed.template, null, 2));
      setWarnings(parsed.warnings);
      setShowConverter(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Workspace / Templates</div>
          <h1>Game templates</h1>
          <p className="muted">
            Reusable game configurations for every node in your fleet.
          </p>
        </div>
        <div className="template-actions">
          <button className="btn" onClick={() => setShowConverter((v) => !v)}>
            <FileInput size={15} />
            Convert Pterodactyl egg
          </button>
          <button
            className="btn primary"
            onClick={() => setEditor(JSON.stringify(blank, null, 2))}
          >
            <Plus size={15} />
            Create template
          </button>
        </div>
      </div>
      {error && <Notice status="danger">{error}</Notice>}
      <Modal
        open={showConverter}
        onOpenChange={setShowConverter}
        title="Import a Pterodactyl egg"
        description="Convert portable settings, then review the resulting template before saving."
      >
        {error && <Notice status="danger">{error}</Notice>}
        <div className="section-title">
          <div>
            <h2>Convert a Pterodactyl egg</h2>
            <p className="muted">
              Paste one egg export JSON. Review the generated Fledge JSON and
              compatibility notes before saving.
            </p>
          </div>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Docker image to use</span>
            <input
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="itzg/minecraft-server:java21-alpine"
            />
            <small className="muted">
              Pterodactyl daemon images and install scripts may not work with
              Fledge.
            </small>
          </label>
          <div className="form-grid">
            <label className="field">
              <span>Primary container port</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Protocol</span>
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as "tcp" | "udp")}
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </label>
          </div>
        </div>
        <label className="field converter-source">
          <span>Pterodactyl egg export</span>
          <textarea
            className="mono"
            rows={14}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            placeholder={"Paste the exported egg JSON here…"}
          />
        </label>
        <div className="form-actions">
          <button className="btn primary" type="button" onClick={convert}>
            Convert to Fledge JSON
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setShowConverter(false);
              setSource("");
              setWarnings([]);
            }}
          >
            Cancel
          </button>
        </div>
      </Modal>
      {warnings.length > 0 && (
        <Notice status="warning" className="converter-warnings" title="Review before saving">
          <ul>{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
        </Notice>
      )}
      <Modal
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor("");
        }}
        title="Template editor"
        description="Review the configuration and use a unique template ID."
      >
        {error && <Notice status="danger">{error}</Notice>}
        {warnings.length > 0 && (
          <Notice status="warning" title="Compatibility notes">
            <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </Notice>
        )}
        <div className="section-title">
          <div>
            <h2>Create a reusable template</h2>
            <p className="muted">
              Choose a unique ID. Images must be allowed by your panel and
              agents.
            </p>
          </div>
        </div>
        <form className="form" onSubmit={save}>
          <label className="field">
            <span>Template configuration (JSON)</span>
            <textarea
              className="mono"
              rows={20}
              value={editor}
              onChange={(e) => setEditor(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="form-actions">
            <button className="btn primary" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />}Save template
            </button>
            <button type="button" className="btn" onClick={() => setEditor("")}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
      {loading ? (
        <div className="skeleton" />
      ) : (
        <div className="template-grid">
          {templates.map((t) => (
            <article className="template-card" key={t.id}>
              <div className="template-top">
                <Box size={21} />
                <span className="muted small">
                  {t.official ? "INCLUDED" : "CUSTOM"}
                </span>
              </div>
              <h2>{t.name}</h2>
              <p className="muted mono small">{t.image}</p>
              <div className="template-specs">
                <span>{t.memoryMb} MB RAM</span>
                <span>{t.cpuPercent}% CPU</span>
                <span>{(t.diskMb / 1024).toFixed(0)} GB disk</span>
              </div>
              <p className="muted small">
                {t.internalPorts
                  .map((p) => `${p.container}/${p.protocol}`)
                  .join(" · ")}
              </p>
              <button
                className="btn"
                onClick={() => {
                  const { official, ...draft } = t;
                  setEditor(
                    JSON.stringify(
                      {
                        ...draft,
                        id: `${t.id}-custom`,
                        name: `${t.name} custom`,
                      },
                      null,
                      2,
                    ),
                  );
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                <Copy size={13} />
                Use as starting point
              </button>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
