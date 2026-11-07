import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAuth } from "@/lib/auth";
import { isClientRole } from "@/lib/permissions";

/** True for a client (or legacy viewer) account that is not linked to a client record. */
export function useIsUnlinkedClient(): boolean {
  const { user } = useAuth();
  return !!user && isClientRole(user.role) && user.clientId == null;
}

/**
 * Shown to a client account that is not linked to a client yet: the server scopes it to
 * nothing, so every list is empty, which must not read as "nothing to do".
 */
export function UnlinkedClientNotice() {
  if (!useIsUnlinkedClient()) return null;
  return (
    <Alert className="border-amber-300 bg-amber-50 text-amber-900 [&>svg]:text-amber-700">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>Your account is not linked to a client yet</AlertTitle>
      <AlertDescription>
        You will see your filings, deadlines and documents here once it is. Contact your accounting firm.
      </AlertDescription>
    </Alert>
  );
}
