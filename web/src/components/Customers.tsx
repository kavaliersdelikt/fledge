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
      <Modal
        open={create}
        onOpenChange={setCreate}
        title="Create customer"
        description="Customers can access only owned or explicitly shared servers."
      >
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
      </Modal>
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
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Server</th>
                    <th>Created</th>
                    <th>Access</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items(data)
                    .filter((c) =>
                      c.email.toLowerCase().includes(filter.toLowerCase()),
                    )
                    .map((c) => (
                      <tr key={c.id}>
                        <td>{c.email}</td>
                        <td>{c.serverCount}</td>
                        <td>{fmtDate(c.createdAt)}</td>
                        <td>
                          <Badge value={c.disabled ? "suspended" : "active"} />
                        </td>
                        <td className="row-actions">
                          <Confirm
                            text={`Account ${c.email} ${c.disabled ? "enable" : "block"}?`}
                            onConfirm={async () => {
                              await json("PATCH", `/customers/${c.id}`, {
                                disabled: !c.disabled,
                              });
                              reload();
                            }}
                          >
                            {c.disabled ? "Enable" : "Suspend"}
                          </Confirm>
                          <Confirm
                            text={`Reset the password for ${c.email}? The new password is shown once and all sessions will end.`}
                            onConfirm={async () => {
                              const p =
                                crypto.randomUUID() + crypto.randomUUID();
                              await json("PATCH", `/customers/${c.id}`, {
                                password: p,
                              });
                              setPassword(p);
                              reload();
                            }}
                          >
                            Reset password
                          </Confirm>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
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
