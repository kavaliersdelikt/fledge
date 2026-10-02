"use client";
import { API, json, request } from "@/lib/api";
import { fmtAgo, fmtBytes, fmtTime } from "@/lib/format";
import { ArrowLeft, Download, FileArchive, FileText, Folder, FolderPlus, KeyRound, RefreshCw, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Modal, Secret, useConfirm } from "./feedback";
import { Button, Card, ErrorNotice, Notice, State, useLoad } from "./shared";
import { useToast } from "./toast";

type Entry = { name: string; path: string; type: string; size: number; modifiedAt: string };
const EDIT_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 1024 ** 3;

export default function ServerFiles({ id }: { id: string }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [path, setPath] = useState("/"),
    [file, setFile] = useState<{ path: string; content: string; original: string } | null>(null),
    [message, setMessage] = useState(""),
    [opError, setOpError] = useState(""),
    [busy, setBusy] = useState(""),
    [dragging, setDragging] = useState(false),
    [folderOpen, setFolderOpen] = useState(false),
    [sftp, setSftp] = useState<{ username: string; password: string; host: string | null; port: number; hostIsPanel: boolean } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  // Transfers poll for a while; stop when the user leaves this tab.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const isAlive = () => alive.current;
  const { data, error, loading, reload } = useLoad<{ path: string; items: Entry[] }>(
    `/servers/${id}/files?path=${encodeURIComponent(path)}`,
  );
  const dirty = !!file && file.content !== file.original;
  const segments = path.split("/").filter(Boolean);
  const join = (name: string) => `${path === "/" ? "" : path}/${name}`;

  async function leaveEditor() {
    if (dirty && !(await confirm("Your unsaved changes to this file will be lost.", { confirmLabel: "Discard changes" })))
      return false;
    setFile(null);
    return true;
  }
  async function go(next: string) {
    if (file && !(await leaveEditor())) return;
    setPath(next);
    setMessage("");
    setOpError("");
  }
  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    setOpError("");
    setMessage("");
    try {
      await fn();
      setMessage("");
      if (done) toast({ tone: "ok", title: done });
      reload();
    } catch (e) {
      setMessage("");
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    } finally {
      setBusy("");
    }
  }
  async function open(entry: Entry) {
    await run("open", async () => {
      const r = await request<{ content: string }>(`/servers/${id}/files/content?path=${encodeURIComponent(entry.path)}`);
      setFile({ path: entry.path, content: r.content, original: r.content });
    });
  }
  async function uploadFile(f: File) {
    await run(
      "upload",
      async () => {
        if (f.size > UPLOAD_LIMIT) throw new Error("Files can be at most 1 GiB.");
        const transfer = await json("POST", `/servers/${id}/transfers`, { direction: "upload", path: join(f.name), size: f.size });
        setMessage(`Uploading ${f.name}…`);
        await request(`/servers/${id}/transfers/${transfer.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: f,
        });
        setMessage(`Saving ${f.name} on the server…`);
        await waitTransfer(id, transfer.id, isAlive);
      },
      `Uploaded ${f.name}`,
    );
  }
  async function download(entry: Entry) {
    await run("download", async () => {
      const transfer = await json("POST", `/servers/${id}/transfers`, { direction: "download", path: entry.path });
      setMessage(`Preparing ${entry.name}…`);
      await waitTransfer(id, transfer.id, isAlive);
      if (!alive.current) return;
      const a = document.createElement("a");
      a.href = `${API}/api/servers/${id}/transfers/${transfer.id}/content`;
      a.download = entry.name;
      a.click();
      setMessage("");
    });
  }

  function save() {
    if (!file || !dirty) return;
    if (new TextEncoder().encode(file.content).length > EDIT_LIMIT) {
      setOpError("The editor can save files up to 1 MiB.");
      return;
    }
    const content = file.content;
    void run(
      "save",
      async () => {
        await json("PUT", `/servers/${id}/files/content?path=${encodeURIComponent(file.path)}`, { content });
        setFile((current) => (current ? { ...current, original: content } : current));
      },
      "Saved",
    );
  }

  if (file)
    return (
      <Card
        flush
        title={<span className="mono">{file.path}</span>}
        description={dirty ? "Unsaved changes" : "Saved"}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={leaveEditor}>
              Close
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty}
              busy={busy === "save"}
              onClick={save}
            >
              Save
            </Button>
          </>
        }
      >
        {opError ? <div style={{ padding: 12 }}><ErrorNotice message={opError} /></div> : null}
        <textarea
          className="input editor"
          aria-label={`Contents of ${file.path}`}
          spellCheck={false}
          value={file.content}
          onChange={(e) => setFile({ ...file, content: e.target.value })}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              save();
            }
          }}
        />
      </Card>
    );

  const columns: DataColumn<Entry>[] = [
    {
      id: "name",
      header: "Name",
      value: (f) => `${f.type === "directory" ? 0 : 1}${f.name.toLowerCase()}`,
      render: (f) => {
        const dir = f.type === "directory";
        const tooBig = !dir && f.size > EDIT_LIMIT;
        return (
          <button
            type="button"
            className={`file-name${dir ? " is-dir" : ""}`}
            disabled={tooBig}
            title={tooBig ? "Too large to edit here — download it instead" : undefined}
            onClick={() => (dir ? go(f.path) : open(f))}
          >
            {dir ? <Folder /> : f.name.toLowerCase().endsWith(".zip") ? <FileArchive /> : <FileText />}
            <span>{f.name}</span>
          </button>
        );
      },
    },
    {
      id: "size",
      header: "Size",
      align: "end",
      value: (f) => (f.type === "directory" ? -1 : f.size),
      render: (f) => <span className="num muted">{f.type === "directory" ? "—" : fmtBytes(f.size)}</span>,
    },
    {
      id: "modified",
      header: "Modified",
      align: "end",
      optional: true,
      value: (f) => f.modifiedAt || "",
      render: (f) => (
        <time className="muted" title={fmtTime(f.modifiedAt)}>
          {fmtAgo(f.modifiedAt)}
        </time>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (f) =>
        f.type === "directory" ? null : (
          <span className="row-actions">
            {f.name.toLowerCase().endsWith(".zip") && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (await confirm(`Files from ${f.name} are extracted into this folder and may overwrite existing files.`, { danger: false, confirmLabel: "Extract" }))
                    void run("extract", () => json("POST", `/servers/${id}/files/extract`, { path: f.path }), `Extracted ${f.name}`);
                }}
              >
                Extract
              </Button>
            )}
            <Button size="icon" variant="ghost" className="btn--sm" aria-label={`Download ${f.name}`} onClick={() => download(f)}>
              <Download />
            </Button>
          </span>
        ),
    },
  ];

  return (
    <>
      <Card
        flush
        title={
          <nav className="path" aria-label="Folder">
            <button type="button" aria-current={path === "/" ? "page" : undefined} onClick={() => go("/")}>
              files
            </button>
            {segments.map((segment, i) => {
              const to = `/${segments.slice(0, i + 1).join("/")}`;
              return (
                <span key={to} style={{ display: "contents" }}>
                  <span>/</span>
                  <button type="button" aria-current={i === segments.length - 1 ? "page" : undefined} onClick={() => go(to)}>
                    {segment}
                  </button>
                </span>
              );
            })}
          </nav>
        }
        actions={
          <>
            {path !== "/" && (
              <Button size="icon" variant="ghost" aria-label="Up one folder" onClick={() => go(path.slice(0, path.lastIndexOf("/")) || "/")}>
                <ArrowLeft />
              </Button>
            )}
            <Button size="icon" variant="ghost" aria-label="Refresh" onClick={reload}>
              <RefreshCw />
            </Button>
            <Button size="sm" onClick={() => setFolderOpen(true)}>
              <FolderPlus /> New folder
            </Button>
            <Button size="sm" busy={busy === "upload"} onClick={() => upload.current?.click()}>
              {busy === "upload" ? null : <Upload />} Upload
            </Button>
            <input
              ref={upload}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void uploadFile(f);
              }}
            />
          </>
        }
      >
        <div
          className={`dropzone${dragging ? " is-over" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) void uploadFile(f);
          }}
        >
          {message && (
            <div style={{ padding: "12px 16px 0" }}>
              <Notice tone="busy">{message}</Notice>
            </div>
          )}
          <State loading={loading} error={error} rows={5}>
            <DataTable
              data={data?.items || []}
              columns={columns}
              rowKey={(f) => f.path}
              empty="This folder is empty. Drop a file here to upload it."
            />
          </State>
        </div>
      </Card>

      <Card
        title="SFTP"
        description="Temporary credentials for any SFTP client, valid for 15 minutes."
        actions={
          <Button
            size="sm"
            busy={busy === "sftp"}
            onClick={() => run("sftp", async () => setSftp(await json("POST", `/servers/${id}/sftp`)))}
          >
            {busy === "sftp" ? null : <KeyRound />} Get credentials
          </Button>
        }
      />

      <Modal open={!!sftp} onOpenChange={(o) => !o && setSftp(null)} title="SFTP credentials" description="They aren’t shown again.">
        {sftp && (
          <>
            <Secret label="Host" value={sftp.host ? `${sftp.host}:${sftp.port}` : `port ${sftp.port}`} />
            <Secret label="Username" value={sftp.username} />
            <Secret label="Password" value={sftp.password} />
            {sftp.hostIsPanel ? (
              <small className="muted">This is the panel’s address. If your game node has its own address, an administrator can set it on the node.</small>
            ) : null}
          </>
        )}
      </Modal>

      <Modal open={folderOpen} onOpenChange={setFolderOpen} title="New folder" description={`Created in ${path}`}>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name") || "");
            setFolderOpen(false);
            await run("mkdir", () => json("POST", `/servers/${id}/files/mkdir`, { path: join(name) }), `Created ${name}`);
          }}
        >
          <label className="field">
            <span className="field__label">Name</span>
            <input className="input" name="name" required pattern="[^/]+" autoFocus title="Folder names can’t contain slashes" />
          </label>
          <div className="modal__actions">
            <Button variant="ghost" onClick={() => setFolderOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Create
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

async function waitTransfer(serverId: string, id: string, alive: () => boolean) {
  const end = Date.now() + 30 * 60 * 1000;
  while (Date.now() < end && alive()) {
    const t = await request<{ state: string; error?: string }>(`/servers/${serverId}/transfers/${id}`);
    if (t.state === "succeeded") return;
    if (t.state === "failed") throw new Error(t.error || "Transfer failed");
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!alive()) return;
  throw new Error("The transfer is still pending. Check the Jobs tab.");
}
