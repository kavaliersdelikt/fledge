"use client";
import { json, request, type NotificationItem, type NotificationList } from "@/lib/api";
import { fmtAgo, fmtTime } from "@/lib/format";
import { Bell, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "./feedback";
import { Button, ErrorNotice, Skeleton } from "./shared";

const POLL_MS = 30_000;
const PAGE = 30;

export type NotificationCenter = { unread: number; open: boolean; setOpen: (open: boolean) => void; setUnread: (n: number) => void };

/** Unread count for the bell. Polls while the tab is visible and stops while it is hidden. */
export function useNotifications(): NotificationCenter {
  const [unread, setUnread] = useState(0),
    [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      request<{ unread: number }>("/notifications/summary")
        .then((r) => live && setUnread(r.unread))
        .catch(() => {});
    };
    check();
    const timer = setInterval(check, POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return { unread, open, setOpen, setUnread };
}

const badge = (n: number) => (n > 99 ? "99+" : String(n));

/** The bell in the sidebar (full row) or the mobile bar (icon). */
export function BellButton({ center, variant }: { center: NotificationCenter; variant: "row" | "icon" }) {
  const label = center.unread ? `Notifications, ${center.unread} unread` : "Notifications";
  if (variant === "icon")
    return (
      <button type="button" className="btn btn--ghost btn--icon notif-btn" aria-label={label} onClick={() => center.setOpen(true)}>
        <Bell />
        {center.unread ? <span className="notif-dot" aria-hidden="true" /> : null}
      </button>
    );
  return (
    <button type="button" className="sidebar-search sidebar-search--bell" aria-label={label} onClick={() => center.setOpen(true)}>
      <Bell />
      <span>Notifications</span>
      {center.unread ? (
        <span className="nav__badge nav__badge--bad" aria-hidden="true">
          {badge(center.unread)}
        </span>
      ) : null}
    </button>
  );
}

const icons = { info: Info, warn: TriangleAlert, bad: CircleAlert, ok: CircleCheck };

export function NotificationDrawer({ center }: { center: NotificationCenter }) {
  return (
    <Drawer open={center.open} onOpenChange={center.setOpen} title="Notifications" description="Things that happened on your servers and nodes">
      {center.open ? <Body center={center} /> : null}
    </Drawer>
  );
}

function Body({ center }: { center: NotificationCenter }) {
  const [items, setItems] = useState<NotificationItem[]>([]),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState(false),
    [loadingMore, setLoadingMore] = useState(false),
    [error, setError] = useState(""),
    [unread, setLocalUnread] = useState(0);
  const { setUnread } = center;
  const markedFor = useRef<number | null>(null);

  const markRead = useCallback(async () => {
    try {
      await json("POST", "/notifications/read", {});
      setUnread(0);
      setLocalUnread(0);
    } catch {
      /* the badge simply stays until the next check */
    }
  }, [setUnread]);

  useEffect(() => {
    let live = true;
    request<NotificationList>(`/notifications?limit=${PAGE}`)
      .then((r) => {
        if (!live) return;
        setItems(r.items);
        setMore(r.items.length >= PAGE);
        setLocalUnread(r.unread);
        markedFor.current = r.items[0]?.id ?? 0;
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  // Opening the list is what marks it read, after a moment so the unread dots can be seen.
  useEffect(() => {
    if (loading || !unread) return;
    const t = setTimeout(() => void markRead(), 1500);
    return () => clearTimeout(t);
  }, [loading, unread, markRead]);

  async function older() {
    const before = items[items.length - 1]?.id;
    if (!before) return;
    setLoadingMore(true);
    try {
      const r = await request<NotificationList>(`/notifications?limit=${PAGE}&before=${before}`);
      setItems((xs) => [...xs, ...r.items]);
      setMore(r.items.length >= PAGE);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="small faint">{items.length ? `${items.length} shown` : ""}</span>
        <Button size="sm" disabled={!unread && !center.unread} onClick={() => void markRead()}>
          Mark all read
        </Button>
      </div>
      <ErrorNotice message={error} />
      {loading ? (
        <Skeleton rows={4} />
      ) : items.length ? (
        <ul className="notif-list">
          {items.map((n) => {
            const Icon = icons[n.severity] || Info;
            return (
              <li key={n.id} className={`notif notif--${n.severity}${n.unread ? " is-unread" : ""}`}>
                <Icon className="notif__icon" aria-hidden="true" />
                <div className="notif__text">
                  <strong>
                    {n.title}
                    {n.unread ? <span className="sr-only"> (unread)</span> : null}
                  </strong>
                  {n.body ? <p>{n.body}</p> : null}
                  <div className="notif__meta small faint">
                    <time dateTime={n.createdAt} title={fmtTime(n.createdAt)}>
                      {fmtAgo(n.createdAt)}
                    </time>
                    {n.serverId ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <Link href={`/servers/${n.serverId}`} className="card-link" onClick={() => center.setOpen(false)}>
                          {n.serverName || "Open server"}
                        </Link>
                      </>
                    ) : null}
                  </div>
                </div>
                {n.unread ? <span className="notif__dot" aria-hidden="true" /> : null}
              </li>
            );
          })}
        </ul>
      ) : error ? null : (
        <div className="empty">
          <strong>You’re all caught up</strong>
          <p>Crashes, failed backups and offline nodes show up here.</p>
        </div>
      )}
      {more && !loading ? (
        <Button busy={loadingMore} onClick={() => void older()}>
          Load older
        </Button>
      ) : null}
    </>
  );
}
