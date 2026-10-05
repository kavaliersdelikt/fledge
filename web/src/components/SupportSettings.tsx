"use client";
import { useState } from "react";
import { json, API } from "@/lib/api";
import {
  Button,
  Card,
  ErrorNotice,
  Form,
  Notice,
  PageHeader,
  State,
  Switch,
  useLoad,
} from "./shared";
import { DeskCollectionEditor } from "./DeskCollectionEditor";
import { Captcha } from "./Auth";
import { BrandMark } from "@/lib/brand";
import { CopyButton, useConfirm } from "./feedback";
export function SupportSettings() {
  const { data: d, error, loading, reload } = useLoad<any>("/support/settings"),
    [tab, setTab] = useState("general");
  return (
    <>
      <PageHeader
        title="Desk settings"
        description="Enable support and set the hours, goals and tools your team uses."
      />
      <State loading={loading} error={error}>
        {null}
      </State>
      <nav className="mews-views" aria-label="Desk settings">
        {[
          "general",
          "inbound",
          "suspension",
          "hours",
          "tiers",
          "categories",
          "groups",
          "macros",
          "rules",
          "articles",
        ].map((t) => (
          <Button
            key={t}
            variant={tab === t ? "primary" : "ghost"}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </nav>
      {d && <DeskEditor key={tab} tab={tab} data={d} reload={reload} />}
    </>
  );
}
function InboundEmailEditor({ data, reload }: { data: { enabled: boolean }; reload: () => void }) {
  const confirm = useConfirm();
  const [enabled, setEnabled] = useState(!!data?.enabled),
    [secret, setSecret] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function toggle(value: boolean) {
    setBusy(true); setError("");
    try {
      const result = await json("PUT", "/support/inbound/settings", { enabled: value }) as { enabled: boolean };
      setEnabled(result.enabled); reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function generate() {
    if (!(await confirm("This replaces any existing secret and disables inbound replies until you update the trusted bridge.", { title: "Rotate inbound email secret?", confirmLabel: "Replace secret" }))) return;
    setBusy(true); setError(""); setSecret("");
    try {
      const result = await json("POST", "/support/inbound/secret", {}) as { secret: string };
      setSecret(result.secret); setEnabled(false); reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Card title="Inbound email bridge">
    <div className="form"><ErrorNotice message={error}/>
      <p className="muted">Fledge does not read mailboxes. A trusted inbox bridge can post signed ticket replies to the panel. Its shared secret is stored encrypted and never shown again after generation.</p>
      <div className="mews-setting"><span>Accept signed inbound replies</span><Switch label="Accept signed inbound replies" checked={enabled} disabled={busy} onChange={(value) => void toggle(value)}/></div>
      <p className="field__hint">Turning this off rejects inbound replies immediately. Outbound email and panel replies are unchanged.</p>
      <Button variant="ghost" busy={busy} onClick={() => void generate()}>Generate or rotate bridge secret</Button>
      {secret && <Notice><p>Copy this secret into your trusted inbox bridge now. Fledge will not display it again.</p><code className="mono">{secret}</code> <CopyButton value={secret}/></Notice>}
      <p className="small muted">Rotating the secret disables inbound replies until you enable them again and update the bridge. See the <a href="https://kavaliersdelikt.github.io/fledge/operate/support-setup#optional-inbound-email" target="_blank" rel="noreferrer">inbound email setup guide</a>.</p>
    </div>
  </Card>;
}
function DeskEditor({
  tab,
  data: d,
  reload,
}: {
  tab: string;
  data: any;
  reload: () => void;
}) {
  const [value, setValue] = useState<any>(
      tab === "suspension" ? d.suspension : d.settings,
    ),
    [calendar, setCalendar] = useState<any>(d.hours),
    [name, setName] = useState(""),
    [body, setBody] = useState(""),
    [shortcut, setShortcut] = useState(""),
    [slug, setSlug] = useState(""),
    [category, setCategory] = useState("General"),
    [visibility, setVisibility] = useState("customers"),
    [trigger, setTrigger] = useState("created"),
    [action, setAction] = useState("note"),
    [condition, setCondition] = useState(""),
    [priority, setPriority] = useState("normal"),
    [group, setGroup] = useState(""),
    [tier, setTier] = useState("standard"),
    [members, setMembers] = useState<string[]>([]);
  if (tab === "general")
    return (
      <Card title="Support availability">
        <Form
          onSubmit={async () => {
            await json("PUT", "/support/settings", value);
            reload();
          }}
        >
          {[
            ["enabled", "Enable help desk"],
            ["publicHelp", "Publish public articles"],
            ["abuseEnabled", "Accept public abuse reports"],
            [
              "collaboratorTickets",
              "Allow server managers to view related tickets",
            ],
          ].map(([k, label]) => (
            <div className="mews-setting" key={k}>
              <span>{label}</span>
              <Switch
                label={label}
                checked={!!value[k]}
                onChange={(v) => setValue({ ...value, [k]: v })}
              />
            </div>
          ))}
          {[
            ["ticketsPerDay", "New tickets per day"],
            ["reopenDays", "Reopen window (days)"],
            ["retentionDays", "Closed ticket retention (days)"],
            ["pendingNudgeDays", "Nudge waiting customers after (days)"],
            ["pendingCloseDays", "Close unanswered tickets after (days)"],
          ].map(([k, label]) => (
            <label className="field" key={k}>
              <span>{label}</span>
              <input
                className="input"
                type="number"
                min={1}
                max={3650}
                value={value[k]}
                onChange={(e) =>
                  setValue({ ...value, [k]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <p className="muted">
            Suspension appeals remain available when the general help desk is
            disabled. Abuse reports require the bot protection configured for
            sign-up.
          </p>
        </Form>
      </Card>
    );
  if (tab === "inbound")
    return <InboundEmailEditor data={d.inboundEmail} reload={reload} />;
  if (tab === "suspension")
    return (
      <Card title="Account suspension">
        <Form
          onSubmit={async () => {
            await json("PUT", "/support/suspension-settings", value);
            reload();
          }}
        >
          {[
            ["appealsEnabled", "Allow suspension appeals"],
            ["defaultServers", "Stop servers by default"],
            ["autoTerminate", "Delete account-held servers after retention"],
          ].map(([k, label]) => (
            <div className="mews-setting" key={k}>
              <span>{label}</span>
              <Switch
                label={label}
                checked={!!value[k]}
                onChange={(v) => setValue({ ...value, [k]: v })}
              />
            </div>
          ))}
          {[
            ["retentionDays", "Retention (days, 0 keeps indefinitely)"],
            ["appealsPerDay", "New appeals per day"],
          ].map(([k, label]) => (
            <label className="field" key={k}>
              <span>{label}</span>
              <input
                className="input"
                type="number"
                min={k === "retentionDays" ? 0 : 1}
                value={value[k]}
                onChange={(e) =>
                  setValue({ ...value, [k]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <p className="muted">
            Termination is off by default. When enabled, only account-held
            servers are scheduled for deletion, with a two-hour cooling period.
          </p>
        </Form>
      </Card>
    );
  if (tab === "hours")
    return (
      <Card title="Business hours">
        <Form
          onSubmit={async () => {
            await json("PUT", "/support/hours", calendar);
            reload();
          }}
        >
          <label className="field">
            <span>Time zone</span>
            <input
              className="input"
              value={calendar.timezone}
              onChange={(e) =>
                setCalendar({ ...calendar, timezone: e.target.value })
              }
            />
          </label>
          {[
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ].map((day, i) => {
            const windows: number[][] = calendar.weekly[String(i)] || [];
            const time = (n: number) =>
              `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
            const minute = (value: string) => {
              const [h, m] = value.split(":").map(Number);
              return h * 60 + m;
            };
            const update = (next: number[][]) =>
              setCalendar({
                ...calendar,
                weekly: { ...calendar.weekly, [String(i)]: next },
              });
            return (
              <fieldset key={day}>
                <legend>{day}</legend>
                {windows.map((w, n) => (
                  <div className="mews-setting" key={n}>
                    <input
                      type="time"
                      aria-label={`${day} window ${n + 1} opens`}
                      className="input"
                      value={time(w[0])}
                      onChange={(e) =>
                        update(
                          windows.map((row, j) =>
                            j === n ? [minute(e.target.value), row[1]] : row,
                          ),
                        )
                      }
                    />
                    <input
                      type="time"
                      aria-label={`${day} window ${n + 1} closes`}
                      className="input"
                      value={time(w[1])}
                      onChange={(e) =>
                        update(
                          windows.map((row, j) =>
                            j === n ? [row[0], minute(e.target.value)] : row,
                          ),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => update(windows.filter((_, j) => j !== n))}
                    >
                      Remove hours
                    </Button>
                  </div>
                ))}
                {windows.length === 0 && <p className="muted">Closed</p>}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={windows.length >= 4}
                  onClick={() =>
                    update([
                      ...windows,
                      [
                        windows.at(-1)?.[1] || 540,
                        Math.min(1439, (windows.at(-1)?.[1] || 540) + 60),
                      ],
                    ])
                  }
                >
                  Add hours
                </Button>
              </fieldset>
            );
          })}
          <label className="field">
            <span>Holidays (one YYYY-MM-DD date per line)</span>
            <textarea
              className="input"
              rows={4}
              value={calendar.holidays.join("\n")}
              onChange={(e) =>
                setCalendar({
                  ...calendar,
                  holidays: e.target.value.split("\n").filter(Boolean),
                })
              }
            />
          </label>
        </Form>
      </Card>
    );
  if (tab === "tiers")
    return (
      <div className="mews-cards">
        {d.tiers.map((t: any) => (
          <TierEditor key={t.id} tier={t} reload={reload} />
        ))}
      </div>
    );
  if (tab === "articles")
    return (
      <Card title="Write a help article">
        <Form
          submit="Publish article"
          onSubmit={async () => {
            await json("POST", "/support/articles", {
              slug,
              title: name,
              body,
              category,
              visibility,
            });
            setName("");
            setBody("");
            reload();
          }}
        >
          <Text label="Title" value={name} onChange={setName} />
          <Text label="Slug" value={slug} onChange={setSlug} />
          <Text label="Category" value={category} onChange={setCategory} />
          <label className="field">
            <span>Visibility</span>
            <select
              className="input"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              {["draft", "customers", "public"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Article (Markdown)</span>
            <textarea
              required
              className="input"
              rows={14}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        </Form>
      </Card>
    );
  return <DeskCollectionEditor tab={tab} data={d} reload={reload} />;
}

function Text({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        required
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function TierEditor({ tier: t, reload }: { tier: any; reload: () => void }) {
  const [reply, setReply] = useState(t.first_reply_minutes),
    [solve, setSolve] = useState(t.solve_minutes),
    [warn, setWarn] = useState(t.warn_percent);
  return (
    <Card title={t.name}>
      <Form
        onSubmit={async () => {
          await json("PUT", `/support/tiers/${t.id}`, {
            firstReplyMinutes: reply,
            solveMinutes: solve,
            warnPercent: warn,
          });
          reload();
        }}
      >
        {[
          ["First reply (business minutes)", reply, setReply],
          ["Resolution (business minutes)", solve, setSolve],
          ["Warn at (%)", warn, setWarn],
        ].map(([label, value, setter]) => (
          <label className="field" key={String(label)}>
            <span>{String(label)}</span>
            <input
              className="input"
              type="number"
              min={1}
              value={Number(value)}
              onChange={(e) =>
                (setter as (n: number) => void)(Number(e.target.value))
              }
            />
          </label>
        ))}
      </Form>
    </Card>
  );
}
export function SupportReports() {
  const { data: d, error, loading } = useLoad<any>("/support/reports");
  return (
    <>
      <PageHeader
        title="Support reports"
        description="Ticket activity over the last 30 days."
      />
      <a className="btn" href={`${API}/api/support/reports?format=csv`}>
        Download CSV
      </a>
      <State loading={loading} error={error}>
        {null}
      </State>
      {d && (
        <>
          <Card title="Daily activity">
            <div className="mews-report-table">
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Received</th>
                    <th>Solved</th>
                    <th>First reply</th>
                    <th>Resolution</th>
                    <th>Deadlines met</th>
                    <th>Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {d.daily.map((r: any) => (
                    <tr key={r.day}>
                      <td>{String(r.day).slice(0, 10)}</td>
                      <td>{r.received}</td>
                      <td>{r.solved}</td>
                      <td>
                        {r.first_reply_seconds
                          ? `${Math.round(r.first_reply_seconds / 60)} min`
                          : "—"}
                      </td>
                      <td>
                        {r.resolution_seconds == null
                          ? "\u2014"
                          : `${Math.round(Number(r.resolution_seconds) / 60)} min`}
                      </td>
                      <td>{r.deadline_met}</td>
                      <td>{r.rating ? Number(r.rating).toFixed(1) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="mews-grid">
            <Card title="By category">
              {d.byCategory.map((r: any) => (
                <div className="mews-setting" key={r.name}>
                  <span>{r.name}</span>
                  <strong>{r.tickets}</strong>
                </div>
              ))}
            </Card>
            <Card title="By agent">
              {d.byAgent.map((r: any) => (
                <div className="mews-setting" key={r.email || "unassigned"}>
                  <span>{r.email || "Unassigned"}</span>
                  <strong>{r.tickets}</strong>
                </div>
              ))}
            </Card>
          </div>
          <Card title="Article feedback">
            <p>
              {d.articleFeedback.helpful} helpful votes ·{" "}
              {d.articleFeedback.unhelpful} unhelpful votes
            </p>
          </Card>
          <Card title="Searches without an answer">
            {d.unansweredSearches.map((r: any) => (
              <div className="mews-setting" key={r.query}>
                <span>{r.query}</span>
                <strong>{r.no_results}</strong>
              </div>
            ))}
          </Card>
        </>
      )}
    </>
  );
}
export function AbuseForm() {
  const { data: d, error, loading } = useLoad<any>("/support/abuse/config"),
    [email, setEmail] = useState(""),
    [address, setAddress] = useState(""),
    [category, setCategory] = useState("spam"),
    [body, setBody] = useState(""),
    [captcha, setCaptcha] = useState(""),
    [number, setNumber] = useState<number | null>(null);
  return (
    <main className="mews-public">
      <div className="brand">
        <BrandMark />
      </div>
      <h1>Report abuse</h1>
      <State loading={loading} error={error}>
        {null}
      </State>
      {number ? (
        <Notice title="Report received">
          Your reference is #{number}. The host will review your report.
        </Notice>
      ) : d?.enabled ? (
        <Card>
          <Form
            submit="Send report"
            onSubmit={async () => {
              const r = await json("POST", "/support/abuse", {
                email,
                address,
                category,
                body,
                captcha,
              });
              setNumber(r.number);
            }}
          >
            <Text label="Your email" value={email} onChange={setEmail} />
            <Text
              label="Server address and port"
              value={address}
              onChange={setAddress}
            />
            <label className="field">
              <span>Category</span>
              <select
                className="input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {[
                  "spam",
                  "attacks",
                  "malware",
                  "copyright",
                  "harassment",
                  "other",
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>What happened?</span>
              <textarea
                required
                rows={8}
                className="input"
                maxLength={10000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <p className="muted">
              Your email is shared with the host’s support team. It is not shown
              to the reported customer.
            </p>
            {d.captcha && <Captcha config={d.captcha} onToken={setCaptcha} />}
          </Form>
        </Card>
      ) : (
        d && (
          <Notice>
            Public abuse reports are unavailable. Contact the host through their
            published support address.
          </Notice>
        )
      )}
    </main>
  );
}
