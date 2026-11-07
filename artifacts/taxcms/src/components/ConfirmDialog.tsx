// Confirmation dialogs that replace window.confirm.
//
//   const confirm = useConfirm();
//   if (!(await confirm({ title: "Delete document?", destructive: true, confirmLabel: "Delete" }))) return;
//
// or let the dialog run the action and show a pending state:
//
//   await confirm({ title: "Delete client?", destructive: true, onConfirm: () => deleteClient.mutateAsync({ id }) });
//
// <ConfirmProvider> is mounted once in App.tsx.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { errorMessage } from "@/lib/api";

/** Options shared by <ConfirmDialog> and confirm(). */
export interface ConfirmOptions {
  /** Dialog heading, e.g. "Delete this document?". */
  title: ReactNode;
  /** Optional explanation under the title. */
  description?: ReactNode;
  /** Confirm button text (default "Confirm"). */
  confirmLabel?: string;
  /** Cancel button text (default "Cancel"). */
  cancelLabel?: string;
  /** Red confirm button for irreversible actions. */
  destructive?: boolean;
  /**
   * Optional action run when the user confirms. While it runs the buttons are disabled and a spinner
   * shows; if it throws, the dialog stays open and shows the error so the user can retry or cancel.
   */
  onConfirm?: () => void | Promise<unknown>;
}

/** Props for the controlled <ConfirmDialog>. */
export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Controlled AlertDialog confirmation with destructive styling and async pending state. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (pending) return; // don't close while the action runs
    if (!next) setError(null);
    onOpenChange(next);
  };

  const handleConfirm = async () => {
    setError(null);
    if (!onConfirm) {
      onOpenChange(false);
      return;
    }
    setPending(true);
    try {
      await onConfirm();
      setPending(false);
      onOpenChange(false);
    } catch (e) {
      setPending(false);
      setError(errorMessage(e));
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription asChild={typeof description !== "string"}>
            {typeof description === "string" ? description : <div>{description}</div>}
          </AlertDialogDescription> : null}
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={pending}
            autoFocus
          >
            {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** confirm(opts) resolves true when the user confirms (after onConfirm succeeds), false when cancelled. */
export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

/** Hosts the single confirmation dialog used by useConfirm(); mount once near the app root. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PendingConfirm | null>(null);
  const [open, setOpen] = useState(false);
  const confirmedRef = useRef(false);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setCurrent(prev => {
        prev?.resolve(false); // a newer request replaces an unanswered one
        return { options, resolve };
      });
      confirmedRef.current = false;
      setOpen(true);
    });
  }, []);

  const wrappedOnConfirm = useCallback(async () => {
    await current?.options.onConfirm?.();
    confirmedRef.current = true;
  }, [current]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && current) {
      current.resolve(confirmedRef.current);
      // Keep `current` so the dialog content doesn't vanish during the close animation.
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && (
        <ConfirmDialog
          {...current.options}
          open={open}
          onOpenChange={handleOpenChange}
          onConfirm={wrappedOnConfirm}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * Promise-based replacement for window.confirm. Falls back to window.confirm when no
 * <ConfirmProvider> is mounted (e.g. in isolated component tests).
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return useCallback<ConfirmFn>(
    async (options) => {
      if (ctx) return ctx(options);
      const text = [options.title, options.description].filter(v => typeof v === "string").join("\n\n");
      if (!window.confirm(text || "Are you sure?")) return false;
      await options.onConfirm?.();
      return true;
    },
    [ctx],
  );
}
