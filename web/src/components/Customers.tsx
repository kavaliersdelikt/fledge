"use client";
import { items, json } from "@/lib/api";
import { fmtDay, fmtTime } from "@/lib/format";
import { KeyRound, MoreHorizontal, Plus, UserCheck, UserX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import DataTable, { type DataColumn } from "./DataTable";
import { Drawer, Modal, Secret, useConfirm } from "./feedback";
import { useToast } from "./toast";
import {
  Button,
  Card,
  Empty,
  Field,
  Form,
  PageHeader,
  Pager,
  Row,
  SearchInput,
  State,
  Toolbar,
  btn,
  useLoad,
} from "./shared";

export default function Customers() {
  const confirm = useConfirm();
  const [offset, setOffset] = useState(0),
    [creating, setCreating] = useState(false),
    [password, setPassword] = useState<{ email: string; value: string } | null>(null),
    [query, setQuery] = useState(""),
    toast = useToast();
  const { data, error, loading, reload } = useLoad<Row[]>(`/customers?limit=50&offset=${offset}`);
  const all = items(data);
  const list = all.filter((c) => c.email.toLowerCase().includes(query.toLowerCase()));

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) toast({ tone: "ok", title: done });
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  }

  const columns: DataColumn<Row>[] = [
    {
      id: "email",
      header: "Email",
      value: (c) => c.email,
      render: (c) => (
        <span className="ident">
          <strong style={{ fontWeight: 500 }}>{c.email}</strong>
          {c.disabled ? <span className="tag">Suspended</span> : null}
        </span>
      ),
    },
    {
      id: "servers",
      header: "Servers",
      align: "end",
      value: (c) => c.serverCount ?? 0,
      render: (c) => <span className="num">{c.serverCount ?? 0}</span>,
    },
    {
      id: "created",
      header: "Joined",
      optional: true,
      value: (c) => c.createdAt || "",
      render: (c) => (
        <time className="muted" title={fmtTime(c.createdAt)}>
          {fmtDay(c.createdAt)}
        </time>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (c) => (
        <DropdownMenu>
          <DropdownMenuTrigger className={btn("ghost", "icon", "btn--sm")} aria-label={`Actions for ${c.email}`}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="menu">
            <DropdownMenuItem
              onClick={async () => {
                if (
                  await confirm(
                    `${c.email} gets a new password and is signed out everywhere. You’ll see the password once.`,
                    { confirmLabel: "Reset password" },
                  )
                )
                  void act(async () => {
                    const next = crypto.randomUUID() + crypto.randomUUID();
                    await json("PATCH", `/customers/${c.id}`, { password: next });
                    setPassword({ email: c.email, value: next });
                  });
              }}
            >
              <KeyRound /> Reset password
            </DropdownMenuItem>
            <DropdownMenuItem
              className={c.disabled ? undefined : "is-danger"}
              onClick={async () => {
                if (
                  await confirm(
                    c.disabled
                      ? `${c.email} can sign in again.`
                      : `${c.email} can’t sign in until you enable the account again.`,
                    { danger: !c.disabled, confirmLabel: c.disabled ? "Enable" : "Suspend" },
                  )
                )
                  void act(
                    () => json("PATCH", `/customers/${c.id}`, { disabled: !c.disabled }),
                    c.disabled ? `${c.email} enabled` : `${c.email} suspended`,
                  );
              }}
            >
              {c.disabled ? <UserCheck /> : <UserX />} {c.disabled ? "Enable account" : "Suspend account"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Customers"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New customer
          </Button>
        }
      />
      {all.length > 8 && (
        <Toolbar>
          <span />
          <SearchInput label="Search customers" placeholder="Search by email" value={query} onChange={setQuery} />
        </Toolbar>
      )}
      <Card flush>
        <State loading={loading} error={error} rows={5}>
          {list.length ? (
            <DataTable data={list} rowKey={(c) => c.id} columns={columns} />
          ) : all.length ? (
            <Empty title="No matching customers" />
          ) : (
            <Empty
              title="No customers yet"
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  Create a customer
                </Button>
              }
            >
              Every server belongs to a customer account.
            </Empty>
          )}
          <Pager offset={offset} setOffset={setOffset} count={all.length} />
        </State>
      </Card>

      <Drawer
        open={creating}
        onOpenChange={setCreating}
        title="New customer"
        description="Leave the password empty to generate one. Nothing is emailed — you share the details yourself."
      >
        <Form
          submit="Create customer"
          success={false}
          onSubmit={async (v) => {
            const r = (await json("POST", "/customers", {
              email: v.email,
              password: v.password || undefined,
            })) as Row;
            setCreating(false);
            if (r.temporaryPassword) setPassword({ email: r.email, value: r.temporaryPassword });
            reload();
          }}
        >
          <Field label="Email" name="email" type="email" required autoComplete="off" />
          <Field label="Password" name="password" type="password" autoComplete="new-password" hint="Optional. At least 12 characters." />
        </Form>
        <p className="faint small">
          After creating the account, assign it a server from <Link href="/servers?new=1" className="text-button">New server</Link>.
        </p>
      </Drawer>

      <Modal
        open={!!password}
        onOpenChange={(o) => !o && setPassword(null)}
        title="Password for this account"
        description={password ? `Share it with ${password.email} securely. It isn’t shown again.` : undefined}
      >
        {password && <Secret label="Password" value={password.value} />}
      </Modal>
    </>
  );
}
