"use client";

import { API, type OpenApiDoc, type OpenApiOperation } from "@/lib/api";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyButton } from "./feedback";
import { Card, Empty, PageHeader, SearchInput, State, Toolbar, useLoad } from "./shared";

type Access = NonNullable<OpenApiOperation["x-access"]>;
type Op = {
  key: string;
  method: string;
  path: string;
  op: OpenApiOperation;
  tag: string;
  access: Access;
  scope?: string;
  body?: string;
};

const METHODS = ["get", "post", "put", "patch", "delete"];
const accessLabel: Record<Access, string> = { public: "Public", session: "Signed in", admin: "Admin", agent: "Node agent" };
const accessHint: Record<Access, string> = {
  public: "Needs no sign-in.",
  session: "Needs a signed-in browser session. API tokens can’t call it.",
  admin: "Administrators only, with a browser session or an API token.",
  agent: "Used by node agents with their own credentials. Not for general use.",
};

const hintFor = (o: Op) =>
  o.scope ? `Works with a browser session or an API token that has the “${o.scope}” permission.` : accessHint[o.access];

const origin = () => API || (typeof window !== "undefined" ? window.location.origin : "https://panel.example.com");

/** `/api/servers/{id}` becomes `/api/servers/<id>` so the example reads as a placeholder. */
function exampleUrl(path: string) {
  return `${origin()}${path.replace(/\{([^}]+)\}/g, "<$1>")}`;
}

function curlFor(o: Op) {
  const method = o.method.toUpperCase();
  const lines = [`curl${method === "GET" ? "" : ` -X ${method}`} \\`, `  -H "Authorization: Bearer $FLEDGE_TOKEN" \\`];
  if (["POST", "PUT", "PATCH"].includes(method)) lines.push(`  -H "Content-Type: application/json" \\`, `  -d '{}' \\`);
  lines.push(`  '${exampleUrl(o.path)}'`);
  return lines.join("\n");
}

const tokenCapable = (o: Op) => !!o.scope;

function flatten(doc: OpenApiDoc): Op[] {
  const out: Op[] = [];
  for (const [path, item] of Object.entries(doc.paths || {}))
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      out.push({
        key: `${method} ${path}`,
        method,
        path,
        op,
        tag: op.tags?.[0] || "Other",
        access: op["x-access"] || "session",
        scope: op["x-token-scope"],
        body: op.requestBody?.content?.["application/json"]?.schema?.description || op.requestBody?.description,
      });
    }
  return out;
}

export default function ApiDocs() {
  const { data, error, loading } = useLoad<OpenApiDoc>("/openapi.json");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [tokensOnly, setTokensOnly] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const ops = useMemo(() => (data ? flatten(data) : []), [data]);
  const tags = useMemo(() => {
    const declared = (data?.tags || []).map((t) => t.name);
    const seen = [...new Set(ops.map((o) => o.tag))];
    // Documented groups first in the order the API declares them; node-agent and undocumented ones last.
    const rank = (t: string) => (t.startsWith("Undocumented") ? 2 : t === "Node agent protocol" ? 1 : 0);
    const order = [...new Set([...declared.filter((t) => seen.includes(t)), ...seen])];
    return order.sort((a, b) => rank(a) - rank(b));
  }, [data, ops]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      ops.filter(
        (o) =>
          (!tag || o.tag === tag) &&
          (!tokensOnly || tokenCapable(o)) &&
          (!q || `${o.method} ${o.path} ${o.op.summary || ""} ${o.tag} ${o.body || ""} ${o.scope || ""}`.toLowerCase().includes(q)),
      ),
    [ops, tag, tokensOnly, q],
  );
  const grouped = useMemo(() => tags.map((t) => ({ tag: t, ops: matches.filter((o) => o.tag === t) })).filter((g) => g.ops.length), [tags, matches]);
  const searching = !!(q || tag || tokensOnly);
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };

  return (
    <>
      <PageHeader
        title="API reference"
        description={data ? `Fledge API ${data.info.version || ""} · ${ops.length} operations` : undefined}
      />
      <State loading={loading} error={error} rows={6}>
        {data && (
          <div className="stack">
            <Card title="Authentication" flush={false}>
              <div className="api-intro">
                <p>{data.info.description}</p>
                <ul>
                  <li>
                    <strong>Browser sessions</strong> use the signed-in cookie. Everything the panel does goes through it.
                  </li>
                  <li>
                    <strong>API tokens</strong> are created under Settings and sent as <code>Authorization: Bearer …</code>. They only reach the operations that show a token scope.
                  </li>
                  <li>
                    <strong>Node agents</strong> authenticate with their own credentials; their endpoints are listed for completeness.
                  </li>
                </ul>
                <div className="api-intro__base">
                  <span className="faint small">Base address</span>
                  <code>{origin()}</code>
                  <CopyButton value={origin()} size="icon" label="Copy base address" />
                </div>
              </div>
            </Card>

            <Toolbar>
              <div className="chips" role="group" aria-label="Filter by group">
                <button type="button" className="chip" aria-pressed={!tag} onClick={() => setTag("")}>
                  All
                </button>
                {tags.map((t) => (
                  <button key={t} type="button" className="chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? "" : t)}>
                    {t}
                  </button>
                ))}
              </div>
              <span className="btn-group">
                <button type="button" className="chip" aria-pressed={tokensOnly} onClick={() => setTokensOnly(!tokensOnly)}>
                  Works with API tokens
                </button>
                <SearchInput label="Search the API" placeholder="Search path or summary" value={query} onChange={setQuery} />
              </span>
            </Toolbar>

            {grouped.length ? (
              grouped.map((g) => {
                const isOpen = searching || open.has(g.tag);
                const id = `api-group-${g.tag.replace(/[^a-z0-9]+/gi, "-")}`;
                return (
                  <Card key={g.tag} flush className="api-group">
                    <button
                      type="button"
                      className="api-group__head"
                      aria-expanded={isOpen}
                      aria-controls={id}
                      onClick={() => !searching && setOpen(toggle(open, g.tag))}
                    >
                      <ChevronRight aria-hidden="true" className="api-group__chevron" />
                      <strong>{g.tag}</strong>
                      <span className="count">{g.ops.length}</span>
                    </button>
                    {isOpen && (
                      <ul className="api-ops" id={id}>
                        {g.ops.map((o) => (
                          <Operation
                            key={o.key}
                            o={o}
                            expanded={expanded.has(o.key)}
                            onToggle={() => setExpanded(toggle(expanded, o.key))}
                          />
                        ))}
                      </ul>
                    )}
                  </Card>
                );
              })
            ) : (
              <Card flush>
                <Empty title="No operations match">Try a different search or clear the group filter.</Empty>
              </Card>
            )}
          </div>
        )}
      </State>
    </>
  );
}

function Operation({ o, expanded, onToggle }: { o: Op; expanded: boolean; onToggle: () => void }) {
  const params = o.op.parameters || [];
  const id = `op-${o.key.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <li className="api-op">
      <div className="api-op__row">
        <button type="button" className="api-op__toggle" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
          <span className={`api-method api-method--${o.method}`}>{o.method.toUpperCase()}</span>
          <code className="api-op__path">{o.path}</code>
          <span className="api-op__summary">{o.op.summary}</span>
          <span className="api-op__badges">
            <span className={`tag${o.access === "admin" ? " tag--accent" : ""}`} title={hintFor(o)}>
              {accessLabel[o.access]}
            </span>
            {o.scope ? (
              <span className="tag" title="An API token needs this permission to call it">
                Token: {o.scope}
              </span>
            ) : null}
          </span>
        </button>
        <CopyButton value={o.path} size="icon" label={`Copy path ${o.path}`} />
      </div>
      {expanded && (
        <div className="api-op__detail" id={id}>
          <p className="muted small">{hintFor(o)}</p>
          {params.length ? (
            <div>
              <h4>Parameters</h4>
              <dl className="api-params">
                {params.map((p) => (
                  <div key={`${p.in}:${p.name}`}>
                    <dt>
                      <code>{p.name}</code> <span className="faint small">{p.in}{p.required ? ", required" : ""}</span>
                    </dt>
                    <dd>{p.description || (p.in === "path" ? "Identifier from the path." : "")}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {o.body ? (
            <div>
              <h4>Request body</h4>
              <p className="small">{o.body}</p>
            </div>
          ) : o.op.requestBody ? (
            <div>
              <h4>Request body</h4>
              <p className="small faint">JSON object. Fields aren’t described for this operation.</p>
            </div>
          ) : null}
          {tokenCapable(o) ? (
            <div>
              <h4>Example</h4>
              <div className="api-curl">
                <pre className="code-block" tabIndex={0}>
                  {curlFor(o)}
                </pre>
                <CopyButton value={curlFor(o)} label="Copy command" />
              </div>
            </div>
          ) : (
            <p className="faint small">Not available to API tokens.</p>
          )}
        </div>
      )}
    </li>
  );
}
