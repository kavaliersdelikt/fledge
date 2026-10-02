"use client";
import { Check, Copy } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "./ui/sheet";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`modal${wide ? " modal--wide" : ""}`}>
        <div className="modal__head">
          <DialogTitle className="modal__title">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="modal__description">{description}</DialogDescription>
          ) : null}
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Side panel used for create and edit forms. */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={`drawer${wide ? " drawer--wide" : ""}`}>
        <div className="drawer__head">
          <SheetTitle className="drawer__title">{title}</SheetTitle>
          {description ? (
            <SheetDescription className="drawer__description">{description}</SheetDescription>
          ) : null}
        </div>
        <div className="drawer__body">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

type ConfirmOptions = { danger?: boolean; confirmLabel?: string; title?: string };
type Pending = ConfirmOptions & { message: string };

const ConfirmationContext = createContext<
  (message: string, options?: ConfirmOptions) => Promise<boolean>
>(async () => false);

export function useConfirm() {
  return useContext(ConfirmationContext);
}

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolve = useRef<((value: boolean) => void) | null>(null);
  const confirm = useCallback(
    (message: string, options: ConfirmOptions = {}) =>
      new Promise<boolean>((done) => {
        resolve.current?.(false);
        resolve.current = done;
        setPending({ danger: true, ...options, message });
      }),
    [],
  );
  const finish = (value: boolean) => {
    resolve.current?.(value);
    resolve.current = null;
    setPending(null);
  };
  useEffect(
    () => () => {
      resolve.current?.(false);
    },
    [],
  );
  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <AlertDialogContent className="modal modal--confirm">
          <div className="modal__head">
            <AlertDialogTitle className="modal__title">
              {pending?.title || (pending?.confirmLabel ? `${pending.confirmLabel}?` : "Continue?")}
            </AlertDialogTitle>
            <AlertDialogDescription className="modal__description">
              {pending?.message}
            </AlertDialogDescription>
          </div>
          <div className="modal__actions">
            <button className="btn btn--secondary" autoFocus onClick={() => finish(false)}>
              Cancel
            </button>
            <button
              className={`btn ${pending?.danger ? "btn--danger-solid" : "btn--primary"}`}
              onClick={() => finish(true)}
            >
              {pending?.confirmLabel || "Continue"}
            </button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmationContext.Provider>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
}: {
  value: string;
  label?: string;
  size?: "sm" | "icon";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className={`btn btn--secondary btn--${size}`}
      aria-label={size === "icon" ? label : undefined}
      title={state === "failed" ? "Clipboard blocked — select the text and copy it manually." : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? <Check /> : <Copy />}
      {size === "icon" ? null : state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : label}
    </button>
  );
}

/** A one-time secret with a copy button. */
export function Secret({ value, label }: { value: string; label?: string }) {
  return (
    <div className="secret">
      {label ? <span className="secret__label">{label}</span> : null}
      <div className="secret__row">
        <code>{value}</code>
        <CopyButton value={value} size="icon" label={`Copy ${label || "value"}`} />
      </div>
    </div>
  );
}
