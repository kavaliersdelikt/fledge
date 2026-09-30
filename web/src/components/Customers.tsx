"use client";
import {
fmtDate,
items,
json
} from "@/lib/api";
import {
Plus
} from "lucide-react";
import {
useState
} from "react";

import { CopyButton,Modal } from "./feedback";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import DataTable, { type DataColumn } from "./DataTable";
import {
Badge,
Button,
Confirm,
Empty,
Field,
Form,
Heading,
Notice,
Pager,
Row,
Section,
State,
useLoad
} from "./shared";
export default function Customers() {
  const [offset, setOffset] = useState(0),
    [password, setPassword] = useState(""),
    [create, setCreate] = useState(false),
    [filter, setFilter] = useState("");
  const { data, error, loading, reload } = useLoad<Row[]>(
    `/customers?limit=50&offset=${offset}`,
  );
  return (
    <>
      <Heading
        eyebrow="Workspace / Customers"
        title="Customers"
        subtitle="Manage the people and permissions across your workspace."
        action={
          <Button className="primary" onClick={() => setCreate(true)}>
            <Plus size={16} />
            Create customer
          </Button>
        }
      />
      <Sheet
        open={create}
        onOpenChange={setCreate}
      >
        <SheetContent className="form-sheet" side="right">
          <SheetHeader>
            <SheetTitle>Create customer</SheetTitle>
            <SheetDescription>Customers can access only owned or explicitly shared servers. A temporary password is shown once if you leave the password blank.</SheetDescription>
          </SheetHeader>
          <Form
          submit="Create customer"
          onSubmit={async (v) => {
            const r = (await json("POST", "/customers", {
              email: v.email,
              password: v.password || undefined,
            })) as Row;
            setPassword(r.temporaryPassword || "");
            setCreate(false);
            reload();
          }}
        >
          <Field label="Email" name="email" type="email" required />
          <Field
            label="Password (optional, min. 12 characters)"
            name="password"
            type="password"
          />
          <Notice>
            If you leave the password blank, the API creates a one-time
            temporary password. It is not sent by email.
          </Notice>
          </Form>
        </SheetContent>
      </Sheet>
      <Modal
        open={!!password}
        onOpenChange={(open) => {
          if (!open) setPassword("");
        }}
        title="Save this password"
        description="Shown only once. Share it securely with the customer; no email is sent."
      >
        <code className="secret-value">{password}</code>
        <CopyButton value={password} />
      </Modal>
      <Section
        title="Customer accounts"
        action={
          <input
            className="search"
            aria-label="Search customer accounts"
            placeholder="Search this page…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        }
      >
        <State loading={loading} error={error}>
          {!items(data).filter((c) =>
            c.email.toLowerCase().includes(filter.toLowerCase()),
          ).length ? (
            <Empty>No customer accounts found.</Empty>
          ) : (
            <DataTable
              data={items(data).filter((customer) => customer.email.toLowerCase().includes(filter.toLowerCase()))}
              rowKey={(customer) => customer.id}
              columns={[
                { id: "email", header: "Customer", value: (customer) => customer.email, render: (customer) => <strong className="table-primary-text">{customer.email}</strong> },
                { id: "servers", header: "Servers", value: (customer) => customer.serverCount },
                { id: "created", header: "Created", value: (customer) => customer.createdAt || "", render: (customer) => fmtDate(customer.createdAt) },
                { id: "access", header: "Access", value: (customer) => customer.disabled ? "suspended" : "active", render: (customer) => <Badge value={customer.disabled ? "suspended" : "active"} /> },
                { id: "actions", header: "Actions", value: () => "", sortable: false, render: (customer) => <div className="table-row-actions"><Confirm danger={false} text={`Account ${customer.email} ${customer.disabled ? "enable" : "block"}?`} onConfirm={async () => { await json("PATCH", `/customers/${customer.id}`, { disabled: !customer.disabled }); reload(); }}>{customer.disabled ? "Enable" : "Suspend"}</Confirm><Confirm text={`Reset the password for ${customer.email}? The new password is shown once and all sessions will end.`} onConfirm={async () => { const nextPassword = crypto.randomUUID() + crypto.randomUUID(); await json("PATCH", `/customers/${customer.id}`, { password: nextPassword }); setPassword(nextPassword); reload(); }}>Reset password</Confirm></div> },
              ] as DataColumn<Row>[]}
              empty="No customer accounts found."
            />
          )}
          <Pager
            offset={offset}
            setOffset={setOffset}
            count={items(data).length}
          />
        </State>
      </Section>
    </>
  );
}
