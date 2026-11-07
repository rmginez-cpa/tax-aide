import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useListUsers } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { can, isManager } from "@/lib/permissions";
import { roleBadgeClass, roleLabel } from "@/lib/status";
import { formatDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ErrorState";
import { Search, Users, ShieldCheck, Briefcase, Eye, Settings2 } from "lucide-react";

const ROLE_ICONS: Record<string, React.ElementType> = {
  super_admin: ShieldCheck,
  manager: ShieldCheck,
  maker: Briefcase,
  accountant: Briefcase,
  client: Eye,
  viewer: Eye,
};

// Read-only team directory for managers and super admins. Creating, editing and
// deleting accounts is super_admin-only and lives on /account-management.
export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const { data: users, isLoading, isError, error, refetch } = useListUsers();
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const urlQ = useMemo(() => new URLSearchParams(search).get("q") ?? "", [search]);
  const [query, setQuery] = useState(urlQ);

  // Keep the search box in the URL (?q=), debounced while typing.
  useEffect(() => {
    setQuery(prev => (prev.trim() === urlQ ? prev : urlQ));
  }, [urlQ]);
  useEffect(() => {
    const typed = query.trim();
    if (typed === urlQ) return;
    const t = setTimeout(() => {
      const sp = new URLSearchParams(search);
      if (typed) sp.set("q", typed); else sp.delete("q");
      const qs = sp.toString();
      setLocation(qs ? `${location}?${qs}` : location, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [query, urlQ, search, location, setLocation]);

  if (!isManager(currentUser?.role)) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p>You don't have permission to view this page.</p>
      </div>
    );
  }

  const needle = urlQ.toLowerCase();
  const filtered = users?.filter(u =>
    u.name.toLowerCase().includes(needle) ||
    u.email.toLowerCase().includes(needle) ||
    roleLabel(u.role).toLowerCase().includes(needle)
  ) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Users</h2>
          <p className="text-muted-foreground">Firm users and their access levels.</p>
        </div>
        {can(currentUser, "manageUsers") && (
          <Button asChild variant="outline" className="self-start sm:self-auto">
            <Link href="/account-management"><Settings2 className="h-4 w-4 mr-2" />Manage accounts</Link>
          </Button>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search users..."
          aria-label="Search users"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No users found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(u => {
            const RoleIcon = ROLE_ICONS[u.role] ?? Users;
            const isSelf = u.id === currentUser?.id;
            return (
              <Card key={u.id} className={isSelf ? "border-primary" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="h-10 w-10 rounded-full bg-primary/15 flex items-center justify-center font-bold text-primary shrink-0" aria-hidden="true">
                      {u.name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="font-semibold text-sm truncate">{u.name}</p>
                        {isSelf && <span className="text-xs text-muted-foreground shrink-0">(you)</span>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>
                    <Badge variant="outline" className={`gap-1 shrink-0 ${roleBadgeClass(u.role)}`}>
                      <RoleIcon className="h-3 w-3" />
                      {roleLabel(u.role)}
                    </Badge>
                    <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                      Joined {formatDate(u.createdAt)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
