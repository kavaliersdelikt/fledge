"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API, json, request, type User, type Server } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { fmtAgo, fmtTime } from "@/lib/format";
import {
  Button,
  Card,
  Form,
  Notice,
  PageHeader,
  State,
  useLoad,
} from "./shared";
import {
  MessageCircle,
  Search,
  Star,
  Paperclip,
  Clock,
  LockKeyhole,
  BookOpen,
} from "lucide-react";
export type Ticket = {
  id: string;
  number: number;
  subject: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  created_at?: string;
  updated_at?: string;
  requester_email?: string;
  first_reply_due_at?: string;
  solve_due_at?: string;
  first_reply_at?: string;
  assignee_id?: string;
  group_id?: string;
  priority?: string;
  server_id?: string;
  suspension_id?: string;
  rating?: number;
  reopenUntil?: string;
  messages?: any[];
  attachments?: any[];
  context?: any;
  viewers?: any[];
  events?: any[];
  diagnostics?: any;
  tags?: string[];
  linked_ticket_ids?: string[];
  linkedTickets?: Ticket[];
  unread?: boolean;
};
function Deadline({ ticket: t }: { ticket: Ticket }) {
  const due = t.first_reply_at ? t.solve_due_at : t.first_reply_due_at;
  if (!due || ["solved", "closed", "pending"].includes(t.status)) return null;
  const minutes = Math.ceil((new Date(due).getTime() - Date.now()) / 60000);
  return (
    <span
      className={`tag ${minutes < 0 ? "is-danger" : ""}`}
      title={fmtTime(due)}
    >
      <Clock size={13} />
      {minutes < 0
        ? `${Math.abs(minutes)} min overdue`
        : minutes >= 60
          ? `${Math.ceil(minutes / 60)} h left`
          : `${minutes} min left`}
    </span>
  );
}
export function TicketThread({
  id,
  agent = false,
  compact = false,
  user,
}: {
  id: string;
  agent?: boolean;
  compact?: boolean;
  user?: User;
}) {
  const {
      data: t,
      error,
      loading,
      reload,
    } = useLoad<Ticket>(`/support/tickets/${id}`, 20000),
    macros = useLoad<any[]>(agent ? "/support/macros" : null),
    articles = useLoad<any[]>(agent ? "/support/articles" : null);
  const [body, setBody] = useState(""),
    [kind, setKind] = useState("reply"),
    [status, setStatus] = useState("open"),
    [problem, setProblem] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [ratingComment, setRatingComment] = useState(""),
    [draftLoaded, setDraftLoaded] = useState(false),
    [rating, setRating] = useState(5),
    [linkId, setLinkId] = useState(""),
    [linkQuery, setLinkQuery] = useState("");
  const linkCandidates = useLoad<Ticket[]>(
    agent && linkQuery.trim()
      ? `/support/tickets?search=${encodeURIComponent(linkQuery)}`
      : null,
  );
  const config = useLoad<any>(agent ? "/support/config" : null);
  const canReply =
      !agent ||
      !!user?.isSuper ||
      !!user?.permissions?.includes("support.reply"),
    canAssign =
      !!user?.isSuper || !!user?.permissions?.includes("support.assign");
  useEffect(() => {
    if (!compact)
      request<{ body: { body?: string } }>(`/support/drafts/${id}`)
        .then((r) => setBody(r.body.body || ""))
        .catch(() => {})
        .finally(() => setDraftLoaded(true));
  }, [id, compact]);
  useEffect(() => {
    if (!draftLoaded || compact) return;
    const timer = window.setTimeout(
      () => void json("PUT", `/support/drafts/${id}`, { body }).catch(() => {}),
      600,
    );
    return () => clearTimeout(timer);
  }, [body, draftLoaded, id, compact]);
  const patch = async (b: any) => {
    try {
      await json("PATCH", `/support/tickets/${id}`, b);
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  return (
    <>
      <State loading={loading} error={error}>
        {null}
      </State>
      {t && (
        <div className={agent && !compact ? "mews-ticket-layout" : ""}>
          <div>
            <div className="mews-ticket-head">
              {!compact && (
                <>
                  <h1>
                    #{t.number} {t.subject}
                  </h1>
                  <span className="tag">
                    {t.status === "pending"
                      ? agent
                        ? "Waiting for customer"
                        : "Waiting for you"
                      : t.status}
                  </span>
                </>
              )}
              {agent && <Deadline ticket={t} />}
            </div>
            {t.viewers?.length ? (
              <Notice tone="warn">
                {t.viewers.map((v) => v.display_name || v.email).join(", ")}{" "}
                {t.viewers.length === 1 ? "is" : "are"} viewing this ticket.
              </Notice>
            ) : null}
            <div className="mews-thread">
              {t.messages?.map((m) => (
                <article
                  key={m.id}
                  className={`mews-message ${m.kind === "note" ? "mews-message--note" : ""}`}
                >
                  <header>
                    <strong>
                      {m.kind === "note" ? (
                        <>
                          <LockKeyhole size={14} /> Internal note
                        </>
                      ) : (
                        m.authorName ||
                        m.display_name ||
                        ((m.author_kind || m.authorKind) === "customer"
                          ? "Customer"
                          : "Support")
                      )}
                    </strong>
                    <time>{fmtAgo(m.createdAt || m.created_at)}</time>
                  </header>
                  <Markdown source={m.body} />
                  {t.attachments
                    ?.filter((a) => a.message_id === m.id)
                    .map((a) => (
                      <a
                        className="mews-attachment"
                        href={`${API}/api/support/tickets/${id}/attachments/${a.id}`}
                        key={a.id}
                      >
                        <Paperclip size={14} />
                        {a.name}
                      </a>
                    ))}
                </article>
              ))}
            </div>
            {problem && <Notice tone="bad">{problem}</Notice>}
            {["solved", "closed"].includes(t.status) ? (
              <Card title="This ticket is solved">
                <div className="btn-group">
                  {(t.status === "solved" ||
                    (compact && t.status === "closed")) && (
                    <Button
                      onClick={async () => {
                        try {
                          await json(
                            "POST",
                            `/support/tickets/${id}/reopen`,
                            {},
                          );
                          reload();
                        } catch (e) {
                          setProblem((e as Error).message);
                        }
                      }}
                    >
                      Reopen ticket
                    </Button>
                  )}
                  {!agent && !compact && !t.rating && (
                    <>
                      <label className="field">
                        <span>Your rating</span>
                        <select
                          className="input"
                          value={rating}
                          onChange={(e) => setRating(Number(e.target.value))}
                        >
                          {[5, 4, 3, 2, 1].map((n) => (
                            <option key={n} value={n}>
                              {n} stars
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Comment (optional)</span>
                        <input
                          className="input"
                          maxLength={2000}
                          value={ratingComment}
                          onChange={(e) => setRatingComment(e.target.value)}
                        />
                      </label>
                      <Button
                        onClick={async () => {
                          try {
                            await json(
                              "POST",
                              `/support/tickets/${id}/rating`,
                              { rating, comment: ratingComment },
                            );
                            reload();
                          } catch (e) {
                            setProblem((e as Error).message);
                          }
                        }}
                      >
                        <Star size={15} /> Send rating
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            ) : (
              canReply && (
                <Form
                  submit={kind === "note" ? "Save internal note" : "Send reply"}
                  onSubmit={async () => {
                    const attachments = [];
                    for (const file of files) {
                      const form = new FormData();
                      form.append("file", file);
                      const a = await request<{ id: string }>(
                        `/support/tickets/${id}/attachments`,
                        { method: "POST", body: form },
                      );
                      attachments.push(a.id);
                    }
                    await json("POST", `/support/tickets/${id}/messages`, {
                      body,
                      kind,
                      ...(agent && kind === "reply" ? { status } : {}),
                      attachments,
                    });
                    setBody("");
                    setFiles([]);
                    if (!compact)
                      await json("PUT", `/support/drafts/${id}`, {});
                    reload();
                  }}
                >
                  {agent && (
                    <div className="btn-group">
                      <Button
                        onClick={() => setKind("reply")}
                        variant={kind === "reply" ? "primary" : "ghost"}
                      >
                        Public reply
                      </Button>
                      <Button
                        onClick={() => setKind("note")}
                        variant={kind === "note" ? "primary" : "ghost"}
                      >
                        Internal note
                      </Button>
                      <select
                        className="input"
                        aria-label="Insert macro"
                        value=""
                        onChange={(e) => {
                          const m = macros.data?.find(
                            (x) => x.id === e.target.value,
                          );
                          if (m)
                            setBody(
                              body +
                                m.body
                                  .replaceAll(
                                    "{{customer}}",
                                    t.requester_email || "customer",
                                  )
                                  .replaceAll("{{ticket}}", "#" + t.number)
                                  .replaceAll(
                                    "{{server}}",
                                    t.context?.servers?.find(
                                      (s: any) => s.id === t.server_id,
                                    )?.name || "server",
                                  )
                                  .replaceAll(
                                    "{{agent}}",
                                    user?.email || "Support",
                                  ),
                            );
                        }}
                      >
                        <option value="">Insert macro</option>
                        {macros.data?.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({m.shortcut})
                          </option>
                        ))}
                      </select>
                      <select
                        className="input"
                        aria-label="Insert article"
                        value=""
                        onChange={(e) => {
                          const a = articles.data?.find(
                            (x) => x.slug === e.target.value,
                          );
                          if (a)
                            setBody(
                              body +
                                `\n[${a.title}](${location.origin}/support/articles/${a.slug})`,
                            );
                        }}
                      >
                        <option value="">Insert article</option>
                        {articles.data?.map((a) => (
                          <option key={a.id} value={a.slug}>
                            {a.title}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <label className="field">
                    <span>
                      {kind === "note"
                        ? "Internal note · visible only to the team"
                        : "Your reply"}
                    </span>
                    <textarea
                      required
                      className="input"
                      rows={compact ? 3 : 6}
                      maxLength={t.suspension_id || compact ? 2000 : 20000}
                      value={body}
                      onChange={(e) => {
                        const typed = e.target.value,
                          m =
                            agent &&
                            macros.data?.find((x) =>
                              typed.endsWith(x.shortcut + " "),
                            );
                        setBody(
                          m
                            ? typed.slice(0, -m.shortcut.length - 1) +
                                m.body
                                  .replaceAll(
                                    "{{customer}}",
                                    t.requester_email || "customer",
                                  )
                                  .replaceAll("{{ticket}}", "#" + t.number)
                                  .replaceAll(
                                    "{{server}}",
                                    t.context?.servers?.find(
                                      (s: any) => s.id === t.server_id,
                                    )?.name || "server",
                                  )
                                  .replaceAll(
                                    "{{agent}}",
                                    user?.email || "Support",
                                  )
                            : typed,
                        );
                      }}
                    />
                  </label>
                  {!compact && (
                    <label className="field">
                      <span>Attachments · up to 5 MB each</span>
                      <input
                        type="file"
                        multiple
                        accept=".png,.jpg,.jpeg,.webp,.gif,.txt,.log,.json,.zip,.pdf"
                        onChange={(e) =>
                          setFiles(
                            Array.from(e.target.files || []).slice(0, 10),
                          )
                        }
                      />
                    </label>
                  )}
                  {agent && kind === "reply" && (
                    <label className="field">
                      <span>After sending</span>
                      <select
                        className="input"
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                      >
                        <option value="open">Keep open</option>
                        <option value="pending">Wait for customer</option>
                        <option value="solved">Mark as solved</option>
                      </select>
                    </label>
                  )}
                </Form>
              )
            )}
            {!agent && !compact && !["solved", "closed"].includes(t.status) && (
              <Button
                variant="ghost"
                onClick={() => patch({ status: "solved" })}
              >
                Mark as solved
              </Button>
            )}
          </div>
          {agent && !compact && (
            <aside className="mews-ticket-context">
              <Card title="Activity">
                <details>
                  <summary>Show ticket history</summary>
                  {t.events?.map((e) => (
                    <p key={e.id}>
                      <strong>
                        {e.kind === "rule"
                          ? `Automation: ${e.data.name}`
                          : e.kind.replaceAll("_", " ")}
                      </strong>
                      <small className="muted"> {fmtTime(e.created_at)}</small>
                      {e.data?.after && (
                        <span>
                          {" "}
                          {Array.isArray(e.data.after)
                            ? e.data.after.join(", ")
                            : String(e.data.after)}
                        </span>
                      )}
                    </p>
                  ))}
                </details>
              </Card>
              <Card title="Linked tickets">
                {t.linkedTickets?.map((x) => (
                  <div className="mews-setting" key={x.id}>
                    <Link href={`/support/${x.id}`}>
                      #{x.number} {x.subject}
                    </Link>
                    {canAssign && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          patch({
                            linkedTicketIds: t.linked_ticket_ids?.filter(
                              (v) => v !== x.id,
                            ),
                          })
                        }
                      >
                        Unlink
                      </Button>
                    )}
                  </div>
                ))}
                {canAssign && (
                  <Form
                    submit="Link ticket"
                    onSubmit={async () => {
                      await patch({
                        linkedTicketIds: [
                          ...new Set([...(t.linked_ticket_ids || []), linkId]),
                        ],
                      });
                      setLinkId("");
                    }}
                  >
                    <label className="field">
                      <span>Find a ticket</span>
                      <input
                        className="input"
                        placeholder="Number, subject or requester"
                        value={linkQuery}
                        onChange={(e) => {
                          setLinkQuery(e.target.value);
                          setLinkId("");
                        }}
                      />
                    </label>
                    <label className="field">
                      <span>Ticket to link</span>
                      <select
                        className="input"
                        required
                        value={linkId}
                        onChange={(e) => setLinkId(e.target.value)}
                      >
                        <option value="">Choose a ticket</option>
                        {linkCandidates.data
                          ?.filter(
                            (x) =>
                              x.id !== id &&
                              !t.linked_ticket_ids?.includes(x.id),
                          )
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              #{x.number} {x.subject}
                            </option>
                          ))}
                      </select>
                    </label>
                  </Form>
                )}
              </Card>
              <Card title="Customer">
                <strong>
                  {t.context?.customer?.email || t.requester_email}
                </strong>
                <p className="muted">
                  {t.context?.customer?.status}{" "}
                  {t.context?.customer?.created_at &&
                    `· Customer since ${fmtTime(t.context.customer.created_at)}`}
                </p>
                {!!t.context?.subscriptions?.length && (
                  <p className="muted">
                    Monthly value:{" "}
                    {Object.entries(
                      t.context.subscriptions.reduce(
                        (total: Record<string, number>, s: any) => {
                          total[s.currency] =
                            (total[s.currency] || 0) +
                            s.price_cents /
                              ({
                                month: 1,
                                quarter: 3,
                                semiannual: 6,
                                year: 12,
                              }[s.cycle as "month"] || 1);
                          return total;
                        },
                        {},
                      ),
                    )
                      .map(
                        ([currency, value]) =>
                          `${(Number(value) / 100).toFixed(2)} ${currency}`,
                      )
                      .join(" / ")}
                  </p>
                )}
                {t.context?.subscriptions?.map((s: any) => (
                  <p key={s.id}>
                    {s.plan} · {s.status} · {(s.price_cents / 100).toFixed(2)}{" "}
                    {s.currency} / {s.cycle}
                  </p>
                ))}
                {t.context?.customer && (
                  <Link href="/customers">Open customers</Link>
                )}
                {t.context?.invoices?.map((i: any) => (
                  <p key={i.number}>
                    Invoice {i.number} · {i.status}
                  </p>
                ))}
              </Card>
              <Card title="Assignment">
                <label className="field">
                  <span>Assignee</span>
                  <select
                    className="input"
                    disabled={!canAssign}
                    value={t.assignee_id || ""}
                    onChange={(e) =>
                      patch({ assigneeId: e.target.value || null })
                    }
                  >
                    <option value="">Unassigned</option>
                    {config.data?.agents?.map((a: any) => (
                      <option value={a.id} key={a.id}>
                        {a.display_name || a.email}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Group</span>
                  <select
                    className="input"
                    disabled={!canAssign}
                    value={t.group_id || ""}
                    onChange={(e) => patch({ groupId: e.target.value || null })}
                  >
                    <option value="">No group</option>
                    {config.data?.groups?.map((g: any) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Tags (comma separated)</span>
                  <input
                    className="input"
                    disabled={!canAssign}
                    defaultValue={t.tags?.join(", ")}
                    onBlur={(e) => {
                      const tags = e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean);
                      if (tags.join(",") !== t.tags?.join(","))
                        void patch({ tags });
                    }}
                  />
                </label>
                <label className="field">
                  <span>Priority</span>
                  <select
                    className="input"
                    disabled={!canAssign}
                    value={t.priority || "normal"}
                    onChange={(e) => patch({ priority: e.target.value })}
                  >
                    {["low", "normal", "high", "urgent"].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <Button
                  disabled={!canAssign}
                  onClick={() => patch({ assigneeId: user!.id })}
                >
                  Assign to me
                </Button>
                <label className="field">
                  <span>Status</span>
                  <select
                    className="input"
                    disabled={!canAssign}
                    value={t.status}
                    onChange={(e) => patch({ status: e.target.value })}
                  >
                    {["open", "pending", "hold", "solved", "closed"].map(
                      (p) => (
                        <option key={p}>{p}</option>
                      ),
                    )}
                  </select>
                </label>
                <Deadline ticket={t} />
              </Card>
              {t.suspension_id &&
                (user?.isSuper ||
                  user?.permissions?.includes("customers.suspend")) && (
                  <Card title="Suspension appeal">
                    <p>
                      {t.context?.suspension?.reference}{" "}
                      {t.context?.suspension?.lifted_at
                        ? "(lifted)"
                        : "(active)"}
                    </p>
                    <Button
                      disabled={!!t.context?.suspension?.lifted_at}
                      onClick={async () => {
                        await json(
                          "DELETE",
                          `/customers/${t.context.customer.id}/suspension`,
                          { note: "Appeal reviewed" },
                        );
                        reload();
                      }}
                    >
                      Lift suspension
                    </Button>
                  </Card>
                )}
              <Card title="Servers">
                {t.context?.servers?.map((s: any) => (
                  <div className="mews-server" key={s.id}>
                    <span>
                      <strong>{s.name}</strong>
                      <small>{s.observed_status}</small>
                    </span>
                    <div className="btn-group">
                      <Link href={`/servers/${s.id}`}>Open</Link>
                      {(user?.isSuper ||
                        user?.permissions?.includes("servers.power")) &&
                        !s.suspended && (
                          <Button
                            variant="ghost"
                            onClick={async () => {
                              await json("POST", `/servers/${s.id}/actions`, {
                                action: "restart",
                              });
                              reload();
                            }}
                          >
                            Restart
                          </Button>
                        )}
                      {[
                        ["servers.console", "console", "Console"],
                        ["servers.files", "files", "Files"],
                        ["servers.backups", "backups", "Backups"],
                      ]
                        .filter(
                          ([grant]) =>
                            user?.isSuper || user?.permissions?.includes(grant),
                        )
                        .map(([, tab, label]) => (
                          <Link key={tab} href={`/servers/${s.id}?tab=${tab}`}>
                            {label}
                          </Link>
                        ))}
                    </div>
                  </div>
                ))}
              </Card>
              {t.diagnostics && Object.keys(t.diagnostics).length > 0 && (
                <Card title="Diagnostics">
                  <pre className="mews-diagnostics">
                    {JSON.stringify(t.diagnostics, null, 2)}
                  </pre>
                </Card>
              )}
              <Card title="Other tickets">
                {t.context?.otherTickets?.map((x: any) => (
                  <p key={x.id}>
                    <Link href={`/support/${x.id}`}>
                      #{x.number} {x.subject}
                    </Link>
                  </p>
                ))}
              </Card>
            </aside>
          )}
        </div>
      )}
    </>
  );
}
export default function Support({ user, id }: { user: User; id?: string }) {
  const agent = user.role === "admin",
    router = useRouter(),
    [view, setView] = useState("needs-answer"),
    [search, setSearch] = useState(""),
    [selection, setSelection] = useState<string[]>([]),
    [categoryFilter, setCategoryFilter] = useState(""),
    [priorityFilter, setPriorityFilter] = useState(""),
    [groupFilter, setGroupFilter] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [assigneeFilter, setAssigneeFilter] = useState(""),
    [tagFilter, setTagFilter] = useState(""),
    [offset, setOffset] = useState(0),
    [bulkPriority, setBulkPriority] = useState("normal"),
    [bulkTag, setBulkTag] = useState("");
  const config = useLoad<any>("/support/config"),
    tickets = useLoad<Ticket[]>(
      id
        ? null
        : `/support/tickets?view=${view}&search=${encodeURIComponent(search)}&offset=${offset}&sort=deadline&categoryId=${categoryFilter}&priority=${priorityFilter}&groupId=${groupFilter}&status=${statusFilter}&assigneeId=${assigneeFilter}&tag=${encodeURIComponent(tagFilter)}`,
      30000,
    ),
    articles = useLoad<any[]>(
      !id
        ? !agent && search.trim()
          ? `/support/search?q=${encodeURIComponent(search)}`
          : "/support/articles"
        : null,
    );
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setOffset(0);
    setSelection([]);
  }, [
    view,
    search,
    categoryFilter,
    priorityFilter,
    groupFilter,
    tagFilter,
    statusFilter,
    assigneeFilter,
  ]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (agent && ["j", "k"].includes(e.key)) {
        e.preventDefault();
        const links = Array.from(
          document.querySelectorAll<HTMLAnchorElement>(".mews-ticket-row>a"),
        );
        const index = links.indexOf(
          document.activeElement as HTMLAnchorElement,
        );
        links[
          Math.max(
            0,
            Math.min(links.length - 1, index + (e.key === "j" ? 1 : -1)),
          )
        ]?.focus();
      }
      if (e.key === "n" && !agent) router.push("/support/new");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [agent, router]);
  if (id) return <TicketThread id={id} agent={agent} user={user} />;
  return (
    <>
      <PageHeader
        title={agent ? "Help desk" : "Help centre"}
        description={
          agent
            ? "Every question, with its customer and server context."
            : `Find an answer or ask your host. ${config.data?.tier || "Standard"} support.`
        }
      />
      <div className="mews-desk-tools">
        <label className="field">
          <span>Search {agent ? "tickets" : "answers and tickets"}</span>
          <input
            ref={searchRef}
            className="input"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {agent ? (
          <div className="btn-group">
            {(user.isSuper ||
              user.permissions?.includes("support.articles")) && (
              <Link className="btn" href="/support/knowledge">
                Knowledge base
              </Link>
            )}
            {(user.isSuper || user.permissions?.includes("support.manage")) && (
              <Link className="btn" href="/support/settings">
                Desk settings
              </Link>
            )}
            {(user.isSuper ||
              user.permissions?.includes("support.reports")) && (
              <Link className="btn" href="/support/reports">
                Reports
              </Link>
            )}
          </div>
        ) : (
          <Link className="btn btn--primary" href="/support/new">
            <MessageCircle size={16} /> New ticket
          </Link>
        )}
      </div>
      {agent && (
        <nav className="mews-views" aria-label="Queue view">
          {[
            ["needs-answer", "Needs an answer"],
            ["mine", "Mine"],
            ["unassigned", "Unassigned"],
            ["deadline", "Close to deadline"],
            ["appeals", "Suspension appeals"],
            ["pending", "Waiting for customer"],
            ["solved", "Solved recently"],
            ...(config.data?.groups || []).map((g: any) => [
              "group:" + g.id,
              g.name,
            ]),
          ].map(([v, label]) => (
            <Button
              key={v}
              variant={view === v ? "primary" : "ghost"}
              onClick={() => {
                setView(v);
                setGroupFilter(v.startsWith("group:") ? v.slice(6) : "");
              }}
            >
              {label}
            </Button>
          ))}
        </nav>
      )}
      {agent && (
        <div className="mews-filters">
          <select
            className="input"
            aria-label="Filter status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All states</option>
            {["open", "pending", "hold", "solved", "closed"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Filter assignee"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
          >
            <option value="">All agents</option>
            {config.data?.agents?.map((a: any) => (
              <option key={a.id} value={a.id}>
                {a.display_name || a.email}
              </option>
            ))}
          </select>

          <select
            className="input"
            aria-label="Filter category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="">All categories</option>
            {config.data?.categories?.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Filter priority"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
          >
            <option value="">All priorities</option>
            {["low", "normal", "high", "urgent"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Filter group"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="">All groups</option>
            {config.data?.groups?.map((g: any) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            aria-label="Filter tag"
            placeholder="Tag"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
          />
        </div>
      )}
      {!agent && (
        <Card title="Popular answers">
          <div className="mews-articles">
            {articles.data?.map((a) => (
              <Link href={`/support/articles/${a.slug}`} key={a.id}>
                <BookOpen size={18} />
                <span>
                  <strong>{a.title}</strong>
                  <small>{a.category}</small>
                </span>
              </Link>
            ))}
            {articles.data?.length === 0 && (
              <p className="muted">
                No published articles yet. Your host can help through a ticket.
              </p>
            )}
          </div>
        </Card>
      )}
      <State loading={tickets.loading} error={tickets.error}>
        {null}
      </State>
      {agent &&
        (user.isSuper || user.permissions?.includes("support.assign")) &&
        selection.length > 0 && (
          <div className="btn-group">
            <Button
              onClick={async () => {
                await json("POST", "/support/tickets/bulk", {
                  ids: selection,
                  assigneeId: user.id,
                });
                setSelection([]);
                tickets.reload();
              }}
            >
              Assign selected to me
            </Button>
            <Button
              onClick={async () => {
                await json("POST", "/support/tickets/bulk", {
                  ids: selection,
                  status: "solved",
                });
                setSelection([]);
                tickets.reload();
              }}
            >
              Solve selected
            </Button>
            <select
              className="input"
              aria-label="Selected ticket priority"
              value={bulkPriority}
              onChange={(e) => setBulkPriority(e.target.value)}
            >
              {["low", "normal", "high", "urgent"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <Button
              onClick={async () => {
                await json("POST", "/support/tickets/bulk", {
                  ids: selection,
                  priority: bulkPriority,
                });
                setSelection([]);
                tickets.reload();
              }}
            >
              Set priority
            </Button>
            <input
              className="input"
              aria-label="Selected ticket tag"
              placeholder="Tag"
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
            />
            <Button
              disabled={!bulkTag.trim()}
              onClick={async () => {
                await json("POST", "/support/tickets/bulk", {
                  ids: selection,
                  tag: bulkTag,
                });
                setSelection([]);
                tickets.reload();
              }}
            >
              Add tag
            </Button>
          </div>
        )}
      <Card title={agent ? "Queue" : "Your tickets"}>
        <div className="mews-ticket-list">
          {tickets.data?.map((t) => (
            <div
              className={`mews-ticket-row ${t.unread ? "mews-ticket-row--unread" : ""}`}
              key={t.id}
            >
              {agent && (
                <input
                  aria-label={`Select ticket ${t.number}`}
                  type="checkbox"
                  checked={selection.includes(t.id)}
                  onChange={(e) =>
                    setSelection(
                      e.target.checked
                        ? [...selection, t.id]
                        : selection.filter((x) => x !== t.id),
                    )
                  }
                />
              )}
              <Link href={`/support/${t.id}`}>
                <strong>
                  {t.unread && <span className="tag">Unread</span>} #{t.number}{" "}
                  {t.subject}
                </strong>
                <small>
                  {agent ? t.requester_email : fmtAgo(t.updatedAt)}{" "}
                  {agent && t.priority ? `· ${t.priority}` : ""}
                </small>
              </Link>
              <span className="tag">{t.status}</span>
              {agent && <Deadline ticket={t} />}
            </div>
          ))}
          {tickets.data?.length === 0 && (
            <p className="muted">No tickets in this view.</p>
          )}
        </div>
      </Card>
      <div className="btn-group">
        <Button
          variant="ghost"
          disabled={!offset}
          onClick={() => setOffset((n) => Math.max(0, n - 100))}
        >
          Previous page
        </Button>
        <span className="muted">Page {offset / 100 + 1}</span>
        <Button
          variant="ghost"
          disabled={tickets.data?.length !== 100}
          onClick={() => setOffset((n) => n + 100)}
        >
          Next page
        </Button>
      </div>
    </>
  );
}
export function NewTicket() {
  const router = useRouter(),
    config = useLoad<any>("/support/config"),
    servers = useLoad<Server[]>("/servers");
  const [categoryId, setCategory] = useState(""),
    [serverId, setServer] = useState(""),
    [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [includeDiagnostics, setInclude] = useState(false),
    [ready, setReady] = useState(false);
  const diagnostics = useLoad<any>(
      serverId ? `/support/diagnostics/${serverId}` : null,
    ),
    answers = useLoad<any[]>(
      subject.trim()
        ? `/support/search?q=${encodeURIComponent(subject)}`
        : null,
    );
  useEffect(() => {
    request<any>("/support/drafts/new")
      .then((r) => {
        setSubject(r.body.subject || "");
        setBody(r.body.body || "");
        setCategory(r.body.categoryId || "");
        setServer(r.body.serverId || "");
      })
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(
      () =>
        void json("PUT", "/support/drafts/new", {
          subject,
          body,
          categoryId,
          serverId,
        }).catch(() => {}),
      600,
    );
    return () => window.clearTimeout(timer);
  }, [subject, body, categoryId, serverId, ready]);
  return (
    <>
      <PageHeader
        title="New ticket"
        description="Tell your host what happened and what you’ve tried."
      />
      <div className="mews-grid">
        <Card title="Your question">
          <Form
            submit="Send ticket"
            onSubmit={async () => {
              const ticket = await json("POST", "/support/tickets", {
                subject,
                body,
                categoryId,
                serverId: serverId || null,
                includeDiagnostics,
              });
              await json("PUT", "/support/drafts/new", {});
              router.push(`/support/${ticket.id}`);
            }}
          >
            <label className="field">
              <span>Category</span>
              <select
                aria-label="Category"
                required
                className="input"
                value={categoryId}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Choose a topic</option>
                {config.data?.categories.map((c: any) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Server (optional)</span>
              <select
                className="input"
                value={serverId}
                onChange={(e) => setServer(e.target.value)}
              >
                <option value="">No server</option>
                {servers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Subject</span>
              <input
                required
                maxLength={200}
                className="input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Message</span>
              <textarea
                required
                maxLength={20000}
                className="input"
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            {serverId && diagnostics.data && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={includeDiagnostics}
                    onChange={(e) => setInclude(e.target.checked)}
                  />{" "}
                  Include these server diagnostics
                </label>
                <pre className="mews-diagnostics">
                  {JSON.stringify(diagnostics.data, null, 2)}
                </pre>
              </>
            )}
            <p className="muted">
              Your draft is saved. Attachments can be added to the ticket after
              sending.
            </p>
          </Form>
        </Card>
        <aside>
          <Card title="These answers might help">
            {answers.data?.map((a) => (
              <p key={a.id}>
                <Link href={`/support/articles/${a.slug}`}>{a.title}</Link>
              </p>
            ))}
            {!answers.data?.length && (
              <p className="muted">
                Suggested articles appear as you type your subject.
              </p>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
export function Article({ slug }: { slug: string }) {
  const { data: a, error, loading } = useLoad<any>(`/support/articles/${slug}`),
    [voted, setVoted] = useState(false);
  return (
    <>
      <State loading={loading} error={error}>
        {null}
      </State>
      {a && (
        <article className="mews-article">
          <h1>{a.title}</h1>
          <p className="muted">{a.category}</p>
          <Markdown source={a.body} />
          <div className="mews-article-footer">
            <p>Did this solve it?</p>
            {voted ? (
              <Notice>Thank you for your feedback.</Notice>
            ) : (
              <div className="btn-group">
                <Button
                  onClick={async () => {
                    await json("POST", `/support/articles/${slug}/vote`, {
                      helpful: true,
                    });
                    setVoted(true);
                  }}
                >
                  Yes
                </Button>
                <Button
                  onClick={async () => {
                    await json("POST", `/support/articles/${slug}/vote`, {
                      helpful: false,
                    });
                    setVoted(true);
                  }}
                >
                  No
                </Button>
              </div>
            )}
            <Link className="btn" href="/support/new">
              I still need help
            </Link>
          </div>
        </article>
      )}
    </>
  );
}
