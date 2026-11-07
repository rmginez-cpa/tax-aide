// The app's navigation pages and who may open them. Shared by the sidebar
// (components/layout.tsx) and the command palette, so both offer the same pages.
// The role lists mirror the route guards in App.tsx.

import {
  LayoutDashboard,
  Users,
  Briefcase,
  Calendar,
  CalendarDays,
  FileText,
  UserCog,
  Bell,
  Activity,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  roles: readonly string[];
  /** Extra words the command palette matches on. */
  keywords?: string;
}

const EVERYONE = ["super_admin", "manager", "maker", "accountant", "client", "viewer"] as const;
const STAFF = ["super_admin", "manager", "maker", "accountant"] as const;
const MANAGERS = ["super_admin", "manager"] as const;

export const NAV_ITEMS: readonly NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: EVERYONE, keywords: "home overview" },
  { name: "Clients", href: "/clients", icon: Users, roles: STAFF, keywords: "taxpayers companies" },
  { name: "Engagements", href: "/engagements", icon: Briefcase, roles: EVERYONE, keywords: "filings returns" },
  { name: "Deadlines", href: "/deadlines", icon: Calendar, roles: STAFF, keywords: "due dates" },
  { name: "Calendar", href: "/calendar", icon: CalendarDays, roles: STAFF, keywords: "month schedule" },
  { name: "Documents", href: "/documents", icon: FileText, roles: EVERYONE, keywords: "files uploads" },
  { name: "Users", href: "/users", icon: UserCog, roles: MANAGERS, keywords: "team staff" },
  { name: "Account Management", href: "/account-management", icon: ShieldCheck, roles: ["super_admin"], keywords: "accounts roles passwords" },
  { name: "Notifications", href: "/notifications", icon: Bell, roles: EVERYONE, keywords: "alerts inbox" },
  { name: "Audit Log", href: "/audit-log", icon: Activity, roles: MANAGERS, keywords: "history trail" },
];

/** The navigation pages a role may open. */
export function navItemsFor(role: string | null | undefined): NavItem[] {
  const r = String(role ?? "");
  return NAV_ITEMS.filter((item) => item.roles.includes(r));
}
