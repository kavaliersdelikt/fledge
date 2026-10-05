"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { json, type User } from "@/lib/api";
import { fmtDay } from "@/lib/format";
import {
  Button,
  Card,
  Form,
  Notice,
  PageHeader,
  State,
  Switch,
  useLoad,
} from "./shared";
import { Modal } from "./feedback";
type Member = {
  id: string;
  email: string;
  isSuper: boolean;
  has2fa: boolean;
  disabled: boolean;
  permissions: string[];
  lastSignIn: string | null;
};
type Catalogue = {
  groups: Record<string, string[]>;
  presets: Record<string, string[]>;
};
export default function Team({ user }: { user: User }) {
  const members = useLoad<Member[]>("/team"),
    catalogue = useLoad<Catalogue>("/permissions"),
    [id, setId] = useState(""),
    [grants, setGrants] = useState<string[]>([]),
    [totp, setTotp] = useState(""),
    [invite, setInvite] = useState(false),
    [email, setEmail] = useState(""),
    [preset, setPreset] = useState("Read-only"),
    [problem, setProblem] = useState(""),
    [link, setLink] = useState(""),
    [transfer, setTransfer] = useState(false),
    [password, setPassword] = useState("");
  const query = useSearchParams(),
    token = query.get("transfer");
  const selected = members.data?.find((m) => m.id === id);
  useEffect(() => {
    if (selected) {
      setGrants(selected.permissions);
      setPreset(
        Object.entries(catalogue.data?.presets || {}).find(
          ([k, v]) =>
            k !== "Super admin" &&
            v.length === selected.permissions.length &&
            v.every((p) => selected.permissions.includes(p)),
        )?.[0] || "Custom",
      );
    }
  }, [selected, catalogue.data]);
  if (token)
    return (
      <Card title="Accept super administrator role">
        <Form
          onSubmit={async () => {
            await json("POST", "/team/transfer/confirm", { token, totp });
            location.href = "/team";
          }}
          submit="Confirm transfer"
        >
          <label className="field">
            <span>Authenticator code</span>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
            />
          </label>
        </Form>
      </Card>
    );
  if (!user.isSuper)
    return <Notice>Only the super administrator can manage the team.</Notice>;
  return (
    <>
      <PageHeader
        title="Team"
        description="Choose an administrator, then set what they can do."
      />
      <State
        loading={members.loading || catalogue.loading}
        error={members.error || catalogue.error}
      >
        {null}
      </State>
      {problem && <Notice tone="bad">{problem}</Notice>}
      {link && (
        <Notice title="Invitation link">
          <a href={link}>{link}</a>
        </Notice>
      )}
      <div className="mews-team">
        <Card
          title="Administrators"
          actions={
            <Button onClick={() => setInvite(true)}>
              Invite administrator
            </Button>
          }
        >
          <div className="mews-members">
            {members.data?.map((m) => (
              <button
                key={m.id}
                onClick={() => setId(m.id)}
                aria-pressed={id === m.id}
              >
                <strong>{m.email}</strong>
                <small>
                  {m.isSuper
                    ? "Super administrator"
                    : m.disabled
                      ? "Removed"
                      : "Administrator"}{" "}
                  · {m.has2fa ? "2FA on" : "2FA setup needed"}
                </small>
                <small>
                  {m.lastSignIn
                    ? `Last seen ${fmtDay(m.lastSignIn)}`
                    : "No sign-in yet"}
                </small>
              </button>
            ))}
          </div>
        </Card>
        <Card title={selected ? selected.email : "Permissions"}>
          {selected && catalogue.data ? (
            <>
              <label className="field">
                <span>Start with a preset</span>
                <select
                  className="input"
                  disabled={
                    selected.isSuper ||
                    selected.id === user.id ||
                    selected.disabled
                  }
                  value={preset}
                  onChange={(e) => {
                    setPreset(e.target.value);
                    setGrants(
                      catalogue.data!.presets[e.target.value].filter(
                        (p) => p !== "team.manage",
                      ),
                    );
                  }}
                >
                  {Object.keys(catalogue.data.presets)
                    .filter((p) => p !== "Super admin")
                    .map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                </select>
              </label>
              {Object.entries(catalogue.data.groups).map(
                ([group, permissions]) => (
                  <fieldset className="mews-permissions" key={group}>
                    <legend>
                      {group}{" "}
                      <small>
                        {permissions.filter((p) => grants.includes(p)).length}/
                        {permissions.length}
                      </small>
                    </legend>
                    {permissions.map((p) => (
                      <div className="mews-permission" key={p}>
                        <span>
                          {p === "team.manage"
                            ? "Manage team ? super administrator only"
                            : p.split(".")[1].replaceAll("_", " ")}
                        </span>
                        <Switch
                          label={
                            p === "team.manage"
                              ? "Manage team · super administrator only"
                              : p.split(".")[1].replaceAll("_", " ")
                          }
                          checked={grants.includes(p)}
                          disabled={
                            p === "team.manage" ||
                            selected.isSuper ||
                            selected.id === user.id ||
                            selected.disabled
                          }
                          onChange={(on) =>
                            setGrants(
                              on
                                ? [...grants, p]
                                : grants.filter((x) => x !== p),
                            )
                          }
                        />
                      </div>
                    ))}
                  </fieldset>
                ),
              )}
              {!selected.isSuper && !selected.disabled && (
                <Form
                  submit="Save permissions"
                  onSubmit={async () => {
                    await json("PUT", `/team/${selected.id}/permissions`, {
                      permissions: grants,
                      totp,
                    });
                    members.reload();
                  }}
                >
                  <label className="field">
                    <span>Authenticator code</span>
                    <input
                      className="input"
                      value={totp}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      onChange={(e) => setTotp(e.target.value)}
                    />
                  </label>
                  <p className="muted">
                    Changes apply to open sessions immediately.
                  </p>
                </Form>
              )}
              {!selected.isSuper && !selected.disabled && (
                <div className="btn-group">
                  <Button onClick={() => setTransfer(true)}>
                    Transfer super administrator role
                  </Button>
                  <Button
                    variant="danger"
                    onClick={async () => {
                      try {
                        await json("DELETE", `/team/${selected.id}`, { totp });
                        members.reload();
                      } catch (e) {
                        setProblem((e as Error).message);
                      }
                    }}
                  >
                    Remove administrator
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="muted">
              Select a team member to review their permissions.
            </p>
          )}
        </Card>
      </div>
      <Modal
        open={invite}
        onOpenChange={setInvite}
        title="Invite administrator"
      >
        <Form
          submit="Send invitation"
          onSubmit={async () => {
            const r = await json("POST", "/team", { email, preset, totp });
            setInvite(false);
            setLink(r.link || "");
            members.reload();
          }}
        >
          <label className="field">
            <span>Email</span>
            <input
              required
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Preset</span>
            <select
              className="input"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
            >
              {Object.keys(catalogue.data?.presets || {})
                .filter((p) => p !== "Super admin" && p !== "Custom")
                .map((p) => (
                  <option key={p}>{p}</option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Authenticator code</span>
            <input
              className="input"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              inputMode="numeric"
            />
          </label>
        </Form>
      </Modal>
      <Modal
        open={transfer}
        onOpenChange={setTransfer}
        title="Transfer super administrator role"
        description="The receiver must confirm by email. You become an administrator after they accept."
      >
        <Form
          submit="Send transfer confirmation"
          onSubmit={async () => {
            await json("POST", "/team/transfer", {
              receiverId: id,
              password,
              totp,
            });
            setTransfer(false);
          }}
        >
          <label className="field">
            <span>Your password</span>
            <input
              required
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Authenticator code</span>
            <input
              className="input"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              inputMode="numeric"
            />
          </label>
        </Form>
      </Modal>
    </>
  );
}
