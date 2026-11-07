import { isStaffRole, type Actor } from "../../middlewares/auth";

/**
 * A rule violation in a service function. Routes answer it with `status` and
 * `{ error: message }`; the assistant / MCP tools return the message as a tool error.
 */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** How a write reached the service, when not through the web app. Recorded in the audit log. */
export interface WriteChannel {
  kind: "claude_connector";
  oauthClientId: string;
  oauthClientName: string | null;
  grantId: number;
}

/** Audit description suffix + metadata for a write that came through `via`. */
export function auditVia(via: WriteChannel | undefined): { suffix: string; metadata?: Record<string, unknown> } {
  if (!via) return { suffix: "" };
  return {
    suffix: " (via Claude connector)",
    metadata: { via: via.kind, oauthClientId: via.oauthClientId, oauthClientName: via.oauthClientName, grantId: via.grantId },
  };
}

/** The requireStaff() rule for callers that did not come through that middleware. */
export function assertStaff(actor: Actor): void {
  if (!isStaffRole(actor.role)) throw new ServiceError(403, "Forbidden");
}
