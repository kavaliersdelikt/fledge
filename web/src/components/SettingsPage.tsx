"use client";

import { fmtDate, items, json, request, type User } from "@/lib/api";
import { useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { CopyButton, Modal } from "./feedback";
import { Notice } from "./shared";
import { Badge, Confirm, Empty, Field, Form, Heading, Row, Section, Select, State, useLoad } from "./shared";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function SettingsPage({ user }: { user: User }) {
  const { data, error, loading, reload } = useLoad<Row[]>(user.role === "admin" ? "/tokens" : null);
  const [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [section, setSection] = useState("account");
  const tokenColumns: DataColumn<Row>[] = [
    { id: "name", header: "Name", value: (token) => token.name || "", render: (token) => <strong className="table-primary-text">{token.name}</strong> },
    { id: "scopes", header: "Scopes", value: (token) => (token.scopes || []).join(", ") },
    { id: "created", header: "Created", value: (token) => token.createdAt || token.created_at || "", render: (token) => fmtDate(token.createdAt || token.created_at) },
    { id: "actions", header: "Actions", value: () => "", sortable: false, render: (token) => <Confirm text={`Token ${token.name} revoke?`} onConfirm={async () => { await request(`/tokens/${token.id}`, { method: "DELETE" }); reload(); }}>Revoke</Confirm> },
  ];

  return (
    <>
      <Heading eyebrow="Workspace / Settings" title="Settings" subtitle="Account access, recovery, and integrations." />
      <Tabs value={section} onValueChange={(value: string) => setSection(value)} className="settings-tabs">
        <TabsList aria-label="Settings sections">
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          {user.role === "admin" && <TabsTrigger value="tokens">API tokens</TabsTrigger>}
        </TabsList>
        <TabsContent value="account">
          <Section title="Account" description="Your identity and access level in this Fledge workspace.">
            <div className="account-summary">
              <div><span>Email</span><strong>{user.email}</strong></div>
              <div><span>Role</span><strong>{user.role === "admin" ? "Administrator" : "Customer"}</strong></div>
              <div><span>Two-factor authentication</span><Badge value={user.has2fa ? "active" : "not configured"} /></div>
            </div>
          </Section>
        </TabsContent>
        <TabsContent value="security">
          <Section title="Account recovery" description="Generate recovery codes and store them somewhere safe. A code resets your password and two-factor setup, and signs out every session.">
            <Form submit="Generate recovery codes" onSubmit={async (values) => {
              const result = await json("POST", "/auth/recovery-codes", { password: values.password, code: values.code });
              setRecovery(result.codes);
            }}>
              <div className="form-grid">
                <Field label="Current password" name="password" type="password" required />
                {user.has2fa && <Field label="Authenticator code" name="code" required />}
              </div>
            </Form>
            <Modal compact open={recovery.length > 0} onOpenChange={(open) => { if (!open) setRecovery([]); }} title="Save your recovery codes" description="Shown only once. Store them somewhere safe. Previous recovery codes are now invalid.">
              <Notice status="warning" title="Save your recovery codes" className="token-notice">{recovery.map((code) => <code key={code}>{code}</code>)}</Notice>
              <CopyButton value={recovery.join("\n")} label="Copy all codes" />
            </Modal>
          </Section>
        </TabsContent>
        {user.role === "admin" && <TabsContent value="tokens">
          <Section title="API tokens" description="Create narrowly scoped tokens for read, provisioning, and suspension actions. A token is shown only once.">
            <Form submit="Create token" onSubmit={async (values) => {
              const result = await json("POST", "/tokens", {
                name: values.name,
                scopes: values.scopes.toString().split(",").map((scope: string) => scope.trim()).filter(Boolean),
              }) as Row;
              setSecret(result.token || result.secret || "");
              reload();
            }}>
              <div className="form-grid">
                <Field label="Token name" name="name" required />
                <Select label="Permissions" name="scopes">
                  <option value="read">Read</option>
                  <option value="read,provision">Read + Provision</option>
                  <option value="read,suspend">Read + Suspend</option>
                  <option value="read,provision,suspend">All API permissions</option>
                </Select>
              </div>
            </Form>
            <Modal compact open={!!secret} onOpenChange={(open) => { if (!open) setSecret(""); }} title="Save your API token" description="This token is shown only once. Copy it before closing this window.">
              <code className="secret-value">{secret}</code><CopyButton value={secret} />
            </Modal>
            <div className="settings-subsection">
              <h3>Existing tokens</h3>
              <State loading={loading} error={error}>
                {items(data).length ? <DataTable data={items(data)} rowKey={(token) => token.id} columns={tokenColumns} /> : <Empty>No tokens created.</Empty>}
              </State>
            </div>
          </Section>
        </TabsContent>}
      </Tabs>
    </>
  );
}
