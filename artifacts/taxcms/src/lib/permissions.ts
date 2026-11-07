// Client-side mirror of the server's authorization policy.
// The generated User type's role union is stale (no 'client' / 'maker' /
// 'super_admin'), so roles are compared as plain strings.

type RoleHolder = { role?: string | null } | null | undefined;

function roleOf(user: RoleHolder): string {
  return String(user?.role ?? "");
}

/** Route-level role check. super_admin always passes; maker == accountant, client == viewer. */
export function roleMatches(userRole: string, allowedRoles: string[]): boolean {
  if (!userRole) return false;
  if (userRole === "super_admin") return true;
  const expanded = new Set(allowedRoles);
  if (expanded.has("accountant")) expanded.add("maker");
  if (expanded.has("maker")) expanded.add("accountant");
  if (expanded.has("client")) expanded.add("viewer");
  if (expanded.has("viewer")) expanded.add("client");
  return expanded.has(userRole);
}

export function isClientRole(role: string | null | undefined): boolean {
  return role === "client" || role === "viewer";
}

export function isStaff(role: string | null | undefined): boolean {
  return role === "maker" || role === "accountant" || role === "manager" || role === "super_admin";
}

export function isManager(role: string | null | undefined): boolean {
  return role === "manager" || role === "super_admin";
}

export function isSuperAdmin(role: string | null | undefined): boolean {
  return role === "super_admin";
}

export type Action =
  | "manageClients"
  | "deleteClients"
  | "editFilings"
  | "approveStages"
  | "uploadDocuments"
  | "deleteDocuments"
  | "manageDeadlines"
  | "deleteDeadlines"
  | "viewAuditLog"
  | "manageUsers"
  | "seedSamples"
  | "comment";

export function can(user: RoleHolder, action: Action): boolean {
  const role = roleOf(user);
  switch (action) {
    case "manageClients":
    case "editFilings":
    case "uploadDocuments":
    case "deleteDocuments":
    case "manageDeadlines":
    case "comment":
      return isStaff(role);
    case "deleteClients":
    case "approveStages":
    case "deleteDeadlines":
    case "viewAuditLog":
    case "seedSamples":
      return isManager(role);
    case "manageUsers":
      return isSuperAdmin(role);
    default:
      return false;
  }
}
