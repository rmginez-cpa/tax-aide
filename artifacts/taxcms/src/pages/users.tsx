import { useState } from "react";
import {
  useListUsers, useCreateUser, useDeleteUser, getListUsersQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Users, Trash2, ShieldCheck, Briefcase, Eye } from "lucide-react";
import { format, parseISO } from "date-fns";

const ROLE_INFO: Record<string, { label: string; icon: React.ElementType; variant: "default" | "secondary" | "outline" }> = {
  manager: { label: "Manager", icon: ShieldCheck, variant: "default" },
  accountant: { label: "Accountant", icon: Briefcase, variant: "secondary" },
  viewer: { label: "Client Viewer", icon: Eye, variant: "outline" },
};

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const { data: users, isLoading } = useListUsers();
  const createUser = useCreateUser();
  const deleteUser = useDeleteUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", role: "accountant" as "accountant" | "manager" | "viewer", password: "" });

  if (currentUser?.role !== "manager") {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p>You don't have permission to manage users.</p>
      </div>
    );
  }

  const filtered = users?.filter(u =>
    u.name.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase()) ||
    u.role.toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  const handleCreate = () => {
    if (!form.email || !form.name || !form.password) {
      toast({ title: "All fields are required", variant: "destructive" });
      return;
    }
    createUser.mutate({ data: form }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        setOpen(false);
        setForm({ email: "", name: "", role: "accountant", password: "" });
        toast({ title: "User created" });
      },
      onError: () => toast({ title: "Failed to create user", variant: "destructive" }),
    });
  };

  const handleDelete = (id: number, name: string) => {
    if (id === currentUser?.id) {
      toast({ title: "Cannot delete your own account", variant: "destructive" });
      return;
    }
    if (!confirm(`Delete user "${name}"?`)) return;
    deleteUser.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast({ title: "User deleted" });
      },
      onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">User Management</h2>
          <p className="text-muted-foreground">Manage firm users and their access levels.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" />Add User</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create User</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="space-y-1.5">
                <Label>Full Name *</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ana Reyes" />
              </div>
              <div className="space-y-1.5">
                <Label>Email Address *</Label>
                <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="ana@firm.ph" />
              </div>
              <div className="space-y-1.5">
                <Label>Role *</Label>
                <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manager">Manager (review, approve)</SelectItem>
                    <SelectItem value="accountant">Accountant (prepare, file)</SelectItem>
                    <SelectItem value="viewer">Client Viewer (read-only)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Password *</Label>
                <Input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Minimum 8 characters" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createUser.isPending}>
                {createUser.isPending ? "Creating..." : "Create User"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search users..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-16" />)}</div>
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
            const roleInfo = ROLE_INFO[u.role] || ROLE_INFO.accountant;
            const RoleIcon = roleInfo.icon;
            return (
              <Card key={u.id} className={u.id === currentUser?.id ? "border-primary" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-full bg-primary/15 flex items-center justify-center font-bold text-primary shrink-0">
                      {u.name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm">{u.name}</p>
                        {u.id === currentUser?.id && <span className="text-xs text-muted-foreground">(you)</span>}
                      </div>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </div>
                    <Badge variant={roleInfo.variant} className="gap-1 shrink-0">
                      <RoleIcon className="h-3 w-3" />
                      {roleInfo.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                      Joined {format(parseISO(u.createdAt), 'MMM d, yyyy')}
                    </span>
                    <Button
                      variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => handleDelete(u.id, u.name)}
                      disabled={u.id === currentUser?.id}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
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
