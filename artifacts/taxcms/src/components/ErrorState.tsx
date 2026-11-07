// Inline error panel with a Retry button, for failed queries.
//
//   const { data, error, refetch, isError } = useListClients();
//   if (isError) return <ErrorState error={error} onRetry={refetch} />;

import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage, errorStatus } from "@/lib/api";
import { useState } from "react";

/** Props for <ErrorState>. Pass a react-query `error` and `refetch`, or a plain `message`. */
export interface ErrorStateProps {
  /** Heading (default "Something went wrong"). */
  title?: string;
  /** Explicit message; otherwise derived from `error`. */
  message?: string;
  /** Any thrown value (react-query error, ApiError, ApiRequestError...). */
  error?: unknown;
  /** Called by the Retry button; may return a promise (react-query's refetch does). Omit to hide Retry. */
  onRetry?: () => unknown;
  /** Smaller, left-aligned variant for use inside cards and table cells. */
  compact?: boolean;
  className?: string;
}

/** The server's message for 403/404 when it sent one, friendly text for other common statuses, else the error's message. */
function describe(error: unknown, fallback: string): string {
  const status = errorStatus(error);
  const serverText = (error as { data?: { error?: unknown } } | null)?.data?.error;
  if ((status === 403 || status === 404) && typeof serverText === "string" && serverText) return serverText;
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return "We couldn't find what you were looking for.";
  if (status === 0) return "Could not reach the server. Check your connection and try again.";
  if (status && status >= 500) return "The server ran into a problem. Please try again in a moment.";
  return error ? errorMessage(error, fallback) : fallback;
}

/** Error message + Retry button; render it where the failed content would have been. */
export function ErrorState({ title = "Something went wrong", message, error, onRetry, compact, className }: ErrorStateProps) {
  const [retrying, setRetrying] = useState(false);
  const text = message ?? describe(error, "Please try again.");

  const retry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try { await onRetry(); } finally { setRetrying(false); }
  };

  return (
    <div
      role="alert"
      className={cn(
        compact
          ? "flex items-center gap-3 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm"
          : "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center",
        className,
      )}
    >
      <AlertCircle className={cn("text-destructive shrink-0", compact ? "h-4 w-4" : "h-8 w-8 opacity-70")} />
      <div className={cn(compact ? "flex-1 min-w-0" : "space-y-1")}>
        <p className={cn("font-medium", compact ? "text-sm" : "text-base")}>{title}</p>
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={retry} disabled={retrying} className="gap-1.5 shrink-0">
          <RefreshCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} />
          Retry
        </Button>
      )}
    </div>
  );
}
