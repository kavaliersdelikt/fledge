"use client";
import { useState } from "react";
import { json } from "@/lib/api";
import { Button, Card, Form, Switch } from "./shared";

const priorities = ["low", "normal", "high", "urgent"];
const statuses = ["open", "pending", "hold", "solved", "closed"];
const triggers = [
  "created",
  "customer_replied",
  "agent_replied",
  "status_changed",
  "pending_days",
  "deadline_percent",
];
type Action = { kind: string; value: string };

export function DeskCollectionEditor({
  tab,
  data,
  reload,
}: {
  tab: string;
  data: any;
  reload: () => void;
}) {
  const [selected, setSelected] = useState<any>(null),
    [generation, setGeneration] = useState(0);
  const reset = () => {
    setSelected(null);
    setGeneration((n) => n + 1);
    reload();
  };
  return (
    <div className="mews-grid">
      <Card title={tab[0].toUpperCase() + tab.slice(1)}>
        {(data[tab] || []).map((entry: any) => (
          <div className="mews-setting" key={entry.id}>
            <span>
              <strong>{entry.name}</strong>
              <small className="muted">
                {tab === "rules"
                  ? `${entry.enabled ? "Enabled" : "Disabled"} · order ${entry.position}`
                  : entry.shortcut || ""}
              </small>
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(entry);
                setGeneration((n) => n + 1);
              }}
            >
              Edit
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          onClick={() => {
            setSelected(null);
            setGeneration((n) => n + 1);
          }}
        >
          Add {tab === "categories" ? "category" : tab.slice(0, -1)}
        </Button>
      </Card>
      <EntryForm
        key={generation}
        tab={tab}
        data={data}
        entry={selected}
        done={reset}
      />
    </div>
  );
}
function EntryForm({
  tab,
  data,
  entry,
  done,
}: {
  tab: string;
  data: any;
  entry: any;
  done: () => void;
}) {
  const [name, setName] = useState(entry?.name || ""),
    [body, setBody] = useState(entry?.body || ""),
    [shortcut, setShortcut] = useState(entry?.shortcut || ""),
    [scope, setScope] = useState(entry?.scope || "team"),
    [members, setMembers] = useState<string[]>(entry?.members || []),
    [priority, setPriority] = useState(entry?.default_priority || "normal"),
    [group, setGroup] = useState(entry?.group_id || ""),
    [tier, setTier] = useState(entry?.tier_id || "standard"),
    [visible, setVisible] = useState(entry?.public ?? true),
    [position, setPosition] = useState(entry?.position ?? entry?.sort ?? 0),
    [enabled, setEnabled] = useState(entry?.enabled ?? true),
    [trigger, setTrigger] = useState(entry?.trigger || "created"),
    [conditions, setConditions] = useState<Record<string, any>>(
      entry?.conditions || {},
    ),
    [actions, setActions] = useState<Action[]>(
      entry?.actions || [{ kind: "note", value: "" }],
    );
  const text = (
    label: string,
    value: string,
    change: (s: string) => void,
    required = false,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        required={required}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
  const select = (
    label: string,
    value: string,
    change: (s: string) => void,
    choices: { id: string; name: string }[],
    empty = false,
  ) => (
    <label className="field">
      <span>{label}</span>
      <select
        className="input"
        value={value}
        onChange={(e) => change(e.target.value)}
      >
        {empty && <option value="">Any</option>}
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
  const choices = (values: string[]) =>
    values.map((id) => ({ id, name: id.replaceAll("_", " ") }));
  const condition = (key: string, value: any) =>
    setConditions((c) => {
      const next = { ...c };
      if (value === "") delete next[key];
      else next[key] = value;
      return next;
    });
  const editAction = (index: number, patch: Partial<Action>) =>
    setActions((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  return (
    <Card
      title={`${entry ? "Edit" : "Add"} ${tab === "categories" ? "category" : tab.slice(0, -1)}`}
    >
      <Form
        submit={entry ? "Save changes" : "Create"}
        onSubmit={async () => {
          const payload =
            tab === "rules"
              ? {
                  id: entry?.id,
                  name,
                  enabled,
                  position,
                  trigger,
                  conditions,
                  actions,
                }
              : tab === "macros"
                ? { id: entry?.id, name, shortcut, body, scope }
                : tab === "groups"
                  ? { name, members }
                  : {
                      name,
                      defaultPriority: priority,
                      groupId: group || null,
                      tierId: tier,
                      public: visible,
                      sort: position,
                    };
          const updatePath = entry && ["groups", "categories"].includes(tab);
          await json(
            updatePath ? "PUT" : "POST",
            `/support/${tab}${updatePath ? "/" + entry.id : ""}`,
            payload,
          );
          done();
        }}
      >
        {text("Name", name, setName, true)}
        {tab === "macros" && (
          <>
            {text("Shortcut", shortcut, setShortcut, true)}
            {select("Visibility", scope, setScope, [
              { id: "team", name: "Team" },
              { id: "personal", name: "Personal" },
            ])}
            <label className="field">
              <span>Reply text</span>
              <textarea
                className="input"
                rows={7}
                required
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <p className="muted">
              Use {"{{customer}}"}, {"{{server}}"} and {"{{agent}}"} for names.
            </p>
          </>
        )}
        {tab === "groups" && (
          <fieldset className="mews-permissions">
            <legend>Members</legend>
            {data.agents.map((a: any) => (
              <label key={a.id}>
                <input
                  type="checkbox"
                  checked={members.includes(a.id)}
                  onChange={(e) =>
                    setMembers(
                      e.target.checked
                        ? [...members, a.id]
                        : members.filter((id) => id !== a.id),
                    )
                  }
                />{" "}
                {a.display_name || a.email}
              </label>
            ))}
          </fieldset>
        )}
        {tab === "categories" && (
          <>
            {select("Priority", priority, setPriority, choices(priorities))}
            {select("Group", group, setGroup, data.groups, true)}
            {select("Tier", tier, setTier, data.tiers)}
            <div className="mews-setting">
              <span>Visible to customers</span>
              <Switch
                label="Visible to customers"
                checked={visible}
                onChange={setVisible}
              />
            </div>
          </>
        )}
        {["categories", "rules"].includes(tab) && (
          <label className="field">
            <span>Order</span>
            <input
              className="input"
              type="number"
              value={position}
              onChange={(e) => setPosition(Number(e.target.value))}
            />
          </label>
        )}
        {tab === "rules" && (
          <>
            <div className="mews-setting">
              <span>Enabled</span>
              <Switch label="Enabled" checked={enabled} onChange={setEnabled} />
            </div>
            {select("When", trigger, setTrigger, choices(triggers))}
            <fieldset>
              <legend>Match all conditions</legend>
              {select(
                "Category",
                conditions.categoryId || "",
                (v) => condition("categoryId", v),
                data.categories,
                true,
              )}
              {select(
                "Priority",
                conditions.priority || "",
                (v) => condition("priority", v),
                choices(priorities),
                true,
              )}
              {select(
                "Group",
                conditions.groupId || "",
                (v) => condition("groupId", v),
                data.groups,
                true,
              )}
              {select(
                "Plan",
                conditions.planId || "",
                (v) => condition("planId", v),
                data.plans || [],
                true,
              )}
              {text("Tag (optional)", conditions.tag || "", (v) =>
                condition("tag", v),
              )}
              {text(
                "Message contains (optional)",
                conditions.textContains || "",
                (v) => condition("textContains", v),
              )}
              {["pending_days", "deadline_percent"].includes(trigger) && (
                <label className="field">
                  <span>
                    {trigger === "pending_days"
                      ? "Pending days"
                      : "Deadline used (%)"}
                  </span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={trigger === "pending_days" ? 3650 : 100}
                    required
                    value={
                      conditions[
                        trigger === "pending_days" ? "days" : "percent"
                      ] || ""
                    }
                    onChange={(e) =>
                      condition(
                        trigger === "pending_days" ? "days" : "percent",
                        Number(e.target.value),
                      )
                    }
                  />
                </label>
              )}
            </fieldset>
            <fieldset>
              <legend>Actions, in order</legend>
              {actions.map((a, i) => (
                <div className="mews-rule-action" key={i}>
                  {select(
                    `Action ${i + 1}`,
                    a.kind,
                    (v) => editAction(i, { kind: v, value: "" }),
                    choices([
                      "assign",
                      "group",
                      "priority",
                      "status",
                      "tag",
                      "email",
                      "notify",
                      "note",
                    ]),
                  )}
                  {["assign", "group", "priority", "status"].includes(a.kind)
                    ? select(
                        `Action ${i + 1} value`,
                        a.value,
                        (v) => editAction(i, { value: v }),
                        a.kind === "assign"
                          ? data.agents.map((x: any) => ({
                              id: x.id,
                              name: x.email,
                            }))
                          : a.kind === "group"
                            ? data.groups
                            : choices(
                                a.kind === "priority" ? priorities : statuses,
                              ),
                        true,
                      )
                    : text(
                        `Action ${i + 1} ${a.kind === "tag" ? "tag" : "message"}`,
                        a.value,
                        (v) => editAction(i, { value: v }),
                        true,
                      )}
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={actions.length === 1}
                    onClick={() =>
                      setActions((rows) => rows.filter((_, n) => n !== i))
                    }
                  >
                    Remove action
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                disabled={actions.length >= 20}
                onClick={() =>
                  setActions((rows) => [...rows, { kind: "note", value: "" }])
                }
              >
                Add action
              </Button>
            </fieldset>
          </>
        )}
      </Form>
      {entry && ["rules", "macros"].includes(tab) && (
        <Button
          variant="danger"
          onClick={async () => {
            await json("DELETE", `/support/${tab}/${entry.id}`);
            done();
          }}
        >
          Delete {tab.slice(0, -1)}
        </Button>
      )}
    </Card>
  );
}
