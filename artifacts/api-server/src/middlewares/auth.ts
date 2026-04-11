import type { Request, Response, NextFunction } from "express";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    userRole?: string;
    userClientId?: number | null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// super_admin bypasses all role checks (they can do anything)
// maker is treated as equivalent to accountant everywhere
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const role = req.session.userRole || "";
    // super_admin passes all role gates
    if (role === "super_admin") {
      next();
      return;
    }
    // maker and accountant are equivalent
    const expandedRoles = new Set(roles);
    if (expandedRoles.has("accountant")) expandedRoles.add("maker");
    if (expandedRoles.has("maker")) expandedRoles.add("accountant");

    if (!expandedRoles.has(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

// Client-scoped auth: only allows access to data for the client's own clientId
export function requireClient(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.session.userRole === "client" && !req.session.userClientId) {
    res.status(403).json({ error: "Client account is not linked to a client record" });
    return;
  }
  next();
}
