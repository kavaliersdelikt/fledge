"use client";
import {
fmtDate,
items,
json,
request,
type User
} from "@/lib/api";
import {
useState
} from "react";

import { CopyButton,Modal } from "./feedback";
import { Notice } from "./shared";
import {
Badge,
Confirm,
Empty,
Field,
Form,
Heading,
Row,
Section,
Select,
State,
useLoad
} from "./shared";
export default function SettingsPage({ user }: { user: User }) {
  const { data, error, loading, reload } = useLoad<Row[]>(
    user.role === "admin" ? "/tokens" : null,
  );
  const [secret, setSecret] = useState(""),
    [recovery, setRecovery] = useState<string[]>([]),
    [section, setSection] = useState("account");
  return (
    <>
      <Heading
        eyebrow="Workspace / Settings"
        title="Settings"
        subtitle="Account access and integrations."
      />
      <div className="filter-toolbar">
        <div className="segmented" aria-label="Settings sections">
          {[
            "account",
            "security",
            ...(user.role === "admin" ? ["tokens"] : []),
          ].map((value) => (
            <button
              key={value}
              aria-pressed={section === value}
              onClick={() => setSection(value)}
            >
              {value === "tokens" ? "API tokens" : value}
            </button>
          ))}
        </div>
      </div>
      {section === "account" && (
        <Section title="Account">
          <div className="kv">
            <span>Email</span>
            <strong>{user.email}</strong>
            <span>Role</span>
            <strong>
              {user.role === "admin" ? "Administrator" : "Customer"}
            </strong>
            <span>Two-factor authentication</span>
            <Badge value={user.has2fa ? "active" : "not configured"} />
          </div>
        </Section>
      )}
      {section === "security" && (
        <Section
          title="Account recovery"
          description="Generate recovery codes and store them somewhere safe. A code resets your password and two-factor setup, and signs out every session."
        >
          <Form
            submit="Generate recovery codes"
            onSubmit={async (v) => {
              const r = await json("POST", "/auth/recovery-codes", {
                password: v.password,
                code: v.code,
              });
              setRecovery(r.codes);
            }}
          >
            <div className="form-grid">
              <Field
                label="Current password"
                name="password"
                type="password"
                required
              />
              {user.has2fa && (
                <Field label="Authenticator code" name="code" required />
              )}
            </div>
          </Form>
          <Modal
            compact
            open={recovery.length > 0}
            onOpenChange={(open) => {
              if (!open) setRecovery([]);
            }}
            title="Save your recovery codes"
            description="Shown only once. Store them somewhere safe. Previous recovery codes are now invalid."
          >
            <Notice status="warning" title="Save your recovery codes" className="token-notice">
              {recovery.map((c) => (
                <code key={c}>{c}</code>
              ))}
            </Notice>
            <CopyButton value={recovery.join("\n")} label="Copy all codes" />
          </Modal>
        </Section>
      )}
      {user.role === "admin" && section === "tokens" && (
        <Section
          title="API tokens"
          description="For narrowly scoped read, provisioning, and suspension actions. Token is shown only once."
        >
          <Form
            submit="Create token"
            onSubmit={async (v) => {
              const r = (await json("POST", "/tokens", {
                name: v.name,
                scopes: v.scopes
                  .toString()
                  .split(",")
                  .map((s: string) => s.trim())
                  .filter(Boolean),
              })) as Row;
              setSecret(r.token || r.secret || "");
              reload();
            }}
          >
            <Field label="Name" name="name" required />
            <Select label="Permissions" name="scopes">
              <option value="read">Read</option>
              <option value="read,provision">Read + Provision</option>
              <option value="read,suspend">Read + Suspend</option>
              <option value="read,provision,suspend">
                All API permissions
              </option>
            </Select>
          </Form>
          <Modal
            compact
            open={!!secret}
            onOpenChange={(open) => {
              if (!open) setSecret("");
            }}
            title="Save your API token"
            description="This token is shown only once. Copy it before closing this window."
          >
            <code className="secret-value">{secret}</code>
            <CopyButton value={secret} />
          </Modal>
          <State loading={loading} error={error}>
            {!items(data).length ? (
              <Empty>No tokens created.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Scopes</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items(data).map((t) => (
                      <tr key={t.id}>
                        <td>{t.name}</td>
                        <td>{(t.scopes || []).join(", ")}</td>
                        <td>{fmtDate(t.createdAt || t.created_at)}</td>
                        <td>
                          <Confirm
                            text={`Token ${t.name} revoke?`}
                            onConfirm={async () => {
                              await request(`/tokens/${t.id}`, {
                                method: "DELETE",
                              });
                              reload();
                            }}
                          >
                            Revoke
                          </Confirm>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </State>
        </Section>
      )}
    </>
  );
}
