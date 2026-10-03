"use client";

import { fmtAgo, fmtTime } from "@/lib/format";
import { items, json, request, type User } from "@/lib/api";
import { useState, type ReactNode } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { CopyButton, Modal, Secret } from "./feedback";
import { Button, Card, Confirm, Field, Form, PageHeader, Row, Select, State, Status, useLoad } from "./shared";
import { Plus } from "lucide-react";
import AdminSettings from "./AdminSettings";
import { AppearanceLink } from "./AppearancePage";
import { PasskeysCard, PlanCard, SessionsCard } from "./AccountSecurity";
import NotificationsCard from "./Notifications";
import Link from "next/link";

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings__section">
      <div className="settings__intro">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="settings__body">{children}</div>
    </section>
  );
}

const scopeLabel: Record<string, string> = { read: "Read", provision: "Provision", suspend: "Suspend" };

export default function SettingsPage({ user }: { user: User }) {
  const admin = user.role === "admin";
  const { data, error, loading, reload } = useLoad<Row[]>(admin ? "/tokens" : null);
  const [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [ask, setAsk] = useState<"recovery" | "token" | null>(null);

  const tokenColumns: DataColumn<Row>[] = [
    { id: "name", header: "Name", value: (t) => t.name || "", render: (t) => <strong style={{ fontWeight: 500 }}>{t.name}</strong> },
    {
      id: "scopes",
      header: "Permissions",
      value: (t) => (t.scopes || []).join(", "),
      render: (t) => (
        <span className="btn-group">
          {(t.scopes || []).map((s: string) => (
            <span className="tag" key={s}>
              {scopeLabel[s] || s}
            </span>
          ))}
        </span>
      ),
    },
    {
      id: "created",
      header: "Created",
      optional: true,
      value: (t) => t.createdAt || t.created_at || "",
      render: (t) => (
        <time className="muted" title={fmtTime(t.createdAt || t.created_at)}>
          {fmtAgo(t.createdAt || t.created_at)}
        </time>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (t) => (
        <Confirm
          variant="ghost"
          text={`Anything using “${t.name}” loses access immediately.`}
          confirmLabel="Revoke token"
          onConfirm={async () => {
            await request(`/tokens/${t.id}`, { method: "DELETE" });
            reload();
          }}
        >
          Revoke
        </Confirm>
      ),
    },
  ];

  return (
    <>
      <PageHeader nav="settings" title="Settings" />
      <div className="settings">
        <Section title="Account">
          <Card>
            <dl className="dl">
              <dt>Email</dt>
              <dd>{user.email}</dd>
              <dt>Role</dt>
              <dd>{admin ? "Administrator" : "Customer"}</dd>
              <dt>Two-factor authentication</dt>
              <dd>
                <Status value={user.has2fa ? "active" : "stopped"} label={user.has2fa ? "On" : "Off"} />
              </dd>
            </dl>
          </Card>
        </Section>

        {!admin && <PlanCard />}

        <Section
          title="Sign-in & devices"
          description="Passkeys, and the browsers that are signed in to your account. Admins always keep an authenticator app as well."
        >
          <PasskeysCard />
          <SessionsCard />
        </Section>

        <Section
          title="Notifications"
          description="Where Fledge tells you about crashes, failed backups, offline nodes and other things that need attention."
        >
          <NotificationsCard user={user} />
        </Section>

        <Section
          title="Recovery codes"
          description="Each code resets your password and authenticator once. New codes replace the old ones."
        >
          <div>
            <Button onClick={() => setAsk("recovery")}>Generate recovery codes</Button>
          </div>
        </Section>

        {admin && (
          <Section title="Appearance" description="The panel’s name, logo, colours, sign-in page and announcements.">
            <AppearanceLink />
          </Section>
        )}

        {admin && (
          <Section title="Panel" description="Everything here takes effect immediately and is stored encrypted in the panel’s database — no .env editing or restarts.">
            <AdminSettings />
          </Section>
        )}

        {admin && (
          <Section
            title="API tokens"
            description={
              <>
                For billing systems and scripts. Give each token only the permissions it needs.{" "}
                <Link href="/api-docs" className="text-button">
                  Browse the API reference
                </Link>
              </>
            }
          >
            <Card
              flush
              actions={
                <Button size="sm" onClick={() => setAsk("token")}>
                  <Plus /> New token
                </Button>
              }
            >
              <State loading={loading} error={error}>
                <DataTable data={items(data)} rowKey={(t) => t.id} columns={tokenColumns} empty="No API tokens yet." />
              </State>
            </Card>
          </Section>
        )}
      </div>

      <Modal open={ask === "recovery"} onOpenChange={(o) => !o && setAsk(null)} title="Generate recovery codes" description="Confirm it’s you. Your current codes stop working.">
        <Form
          submit="Generate"
          success={false}
          onSubmit={async (values) => {
            const result = await json("POST", "/auth/recovery-codes", { password: values.password, code: values.code });
            setAsk(null);
            setRecovery(result.codes);
          }}
        >
          <Field label="Password" name="password" type="password" required autoComplete="current-password" />
          {user.has2fa && (
            <Field label="Authenticator code" name="code" required autoComplete="one-time-code" pattern="[0-9]{6}" placeholder="000000" />
          )}
        </Form>
      </Modal>
      <Modal open={ask === "token"} onOpenChange={(o) => !o && setAsk(null)} title="New API token">
        <Form
          submit="Create token"
          success={false}
          onSubmit={async (values) => {
            const result = (await json("POST", "/tokens", {
              name: values.name,
              scopes: String(values.scopes).split(",").filter(Boolean),
            })) as Row;
            setAsk(null);
            setSecret(result.token || result.secret || "");
            reload();
          }}
        >
          <Field label="Name" name="name" required placeholder="Billing integration" />
          <Select label="Permissions" name="scopes">
            <option value="read">Read only</option>
            <option value="read,provision">Read and provision</option>
            <option value="read,suspend">Read and suspend</option>
            <option value="read,provision,suspend">All</option>
          </Select>
        </Form>
      </Modal>
      <Modal
        open={recovery.length > 0}
        onOpenChange={(o) => !o && setRecovery([])}
        title="Your recovery codes"
        description="Store them somewhere safe, like a password manager. They aren’t shown again."
      >
        <pre className="code-block">{recovery.join("\n")}</pre>
        <div className="modal__actions">
          <CopyButton value={recovery.join("\n")} label="Copy codes" />
        </div>
      </Modal>
      <Modal
        open={!!secret}
        onOpenChange={(o) => !o && setSecret("")}
        title="API token created"
        description="Copy it now — it isn’t shown again."
      >
        <Secret value={secret} label="Token" />
      </Modal>
    </>
  );
}
