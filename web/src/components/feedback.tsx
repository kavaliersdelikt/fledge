"use client";
import { Check,Copy,TriangleAlert } from "lucide-react";
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
AlertDialogHeader,
AlertDialogTitle,
} from "./ui/alert-dialog";
import {
Dialog,
DialogContent,
DialogDescription,
DialogHeader,
DialogTitle,
} from "./ui/dialog";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  compact = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`app-modal ${compact ? "compact" : ""}`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

const ConfirmationContext = createContext<
  (message: string) => Promise<boolean>
>(async () => false);
export function useConfirm() {
  return useContext(ConfirmationContext);
}
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const resolve = useRef<((value: boolean) => void) | null>(null);
  const confirm = useCallback(
    (text: string) =>
      new Promise<boolean>((done) => {
        resolve.current?.(false);
        resolve.current = done;
        setMessage(text);
      }),
    [],
  );
  const finish = (value: boolean) => {
    resolve.current?.(value);
    resolve.current = null;
    setMessage("");
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
        open={!!message}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <AlertDialogContent className="app-confirm">
          <AlertDialogHeader>
            <div className="confirm-icon">
              <TriangleAlert size={22} />
            </div>
            <AlertDialogTitle>Confirm this action</AlertDialogTitle>
            <AlertDialogDescription>{message}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="form-actions dialog-actions">
            <button className="btn" autoFocus onClick={() => finish(false)}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => finish(true)}>
              Confirm action
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
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        className="btn"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
        {copied ? "Copied" : label}
      </button>
      {failed && (
        <span role="status" className="muted small">
          Select the text and copy it manually.
        </span>
      )}
    </>
  );
}
