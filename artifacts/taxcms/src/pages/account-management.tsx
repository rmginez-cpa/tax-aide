import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ShieldCheck, Plus, Pencil, Trash2, Loader2, User, RefreshCw } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useAuth } from "@/lib/auth";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
function apiUrl(path: string) { return `${BASE}/api${path}`; }

async function apiFetch(method: string, path: string, body?: object) {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || "Request failed");
  }
  if (res.status === 204) return null;
  return res.json();
}

const ROLES = [
  { value: "super_admin", label: "Super Admin", desc: "Full system access, account management", badgeClass: "bg-violet-100 text-violet-800 border-violet-200" },
  { value: "manager", label: "Manager", desc: "Approves filings, views all data", badgeClass: "bg-blue-100 text-blue-800 border-blue-200" },
  { value: "maker", label: "Maker", desc: "Prepares and submits filings", badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  { value: "client", label: "Client", desc: "Read-only view of own filings", badgeClass: "bg-amber-100 text-amber-800 border-amber-200" },
  { value: "viewer", label: "Viewer", desc: "Read-only access", badgeClass: "bg-gray-100 text-gray-700 border-gray-200" },
];

function getRoleInfo(role: string) {
  return ROLES.find(r => r.value === role) ?? { value: role, label: role, desc: "", badgeClass: "bg-gray-100 text-gray-700 border-gray-200" };
}

interface UserRecord {
  id: number;
  email: string;
  name: string;
  role: string;
  clientId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Client {
  id: number;
  name: string;
}

const BLANK_FORM = { name: "", email: "", role: "maker", password: "", clientId: "" };

export default function AccountManagement() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserRecord | null>(null);
  const [deleteUser, setDeleteUser] = useState<UserRecord | null>(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [editForm, setEditForm] = useState({ name: "", role: "", password: "", clientId: "" });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data: users = [], isLoading, refetch } = useQuery<UserRecord[]>({
    queryKey: ["admin-users"],
    queryFn: () => apiFetch("GET", "/users"),
  });

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["clients-list"],
    queryFn: () => apiFetch("GET", "/clients"),
  });

  const handleCreate = async () => {
    if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
      toast({ title: "Name, email, and password are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiFetch("POST", "/users", {
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        role: form.role,
        password: form.password,
        clientId: form.clientId ? parseInt(form.clientId) : null,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setCreateOpen(false);
      setForm(BLANK_FORM);
      toast({ title: "Account created successfully" });
    } catch (e: any) {
      toast({ title: e.message || "Failed to create account", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (u: UserRecord) => {
    setEditUser(u);
    setEditForm({ name: u.name, role: u.role, password: "", clientId: u.clientId ? String(u.clientId) : "" });
  };

  const handleEdit = async () => {
    if (!editUser) return;
    if (!editForm.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiFetch("PATCH", `/users/${editUser.id}`, {
        name: editForm.name.trim(),
        role: editForm.role,
        ...(editForm.password.trim() ? { password: editForm.password.trim() } : {}),
        clientId: editForm.clientId ? parseInt(editForm.clientId) : null,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setEditUser(null);
      toast({ title: "Account updated" });
    } catch (e: any) {
      toast({ title: e.message || "Failed to update account", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    setDeleting(true);
    try {
      await apiFetch("DELETE", `/users/${deleteUser.id}`);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setDeleteUser(null);
      toast({ title: "Account deleted" });
    } catch (e: any) {
      toast({ title: e.message || "Failed to delete account", variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  const needsClientLink = (role: string) => role === "client";

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Account Management
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Create and manage all user accounts. Only Super Admins can access this page.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button onClick={() => { setForm(BLANK_FORM); setCreateOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" />
            Create Account
          </Button>
        </div>
      </div>

      {/* Role summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {ROLES.map(r => {
          const count = users.filter(u => u.role === r.value || (r.value === "maker" && u.role === "accountant")).length;
          return (
            <Card key={r.value} className="p-3">
              <div className="flex items-center justify-between mb-1">
                <Badge variant="outline" className={`text-xs ${r.badgeClass}`}>{r.label}</Badge>
                <span className="text-lg font-bold text-foreground">{count}</span>
              </div>
              <p className="text-xs text-muted-foreground">{r.desc}</p>
            </Card>
          );
        })}
      </div>

      {/* Users table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">All Accounts</CardTitle>
          <CardDescription>{users.length} account{users.length !== 1 ? "s" : ""} total</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Linked Client</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map(u => {
                  const roleInfo = getRoleInfo(u.role);
                  const linkedClient = u.clientId ? clients.find(c => c.id === u.clientId) : null;
                  const isSelf = u.id === currentUser?.id;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                            {u.name.charAt(0)}
                          </div>
                          <span>{u.name}</span>
                          {isSelf && <Badge variant="outline" className="text-xs h-4 px-1">You</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{u.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${roleInfo.badgeClass}`}>{roleInfo.label}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {linkedClient ? linkedClient.name : <span className="text-muted-foreground/50">—</span>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(parseISO(u.createdAt), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(u)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {!isSelf && (
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-500 hover:text-rose-700 hover:bg-rose-50" onClick={() => setDeleteUser(u)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Create Account Dialog ───────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={v => { if (!v) setCreateOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="h-5 w-5" /> Create Account
            </DialogTitle>
            <DialogDescription>Fill in the details to create a new user account.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Full Name *</Label>
              <Input placeholder="e.g. Maria Santos" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Email Address *</Label>
              <Input type="email" placeholder="name@firm.ph" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Role *</Label>
              <Select value={form.role} onValueChange={v => setForm(p => ({ ...p, role: v, clientId: v === "client" ? p.clientId : "" }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map(r => (
                    <SelectItem key={r.value} value={r.value}>
                      <div>
                        <span className="font-medium">{r.label}</span>
                        <span className="text-muted-foreground ml-1.5 text-xs">— {r.desc}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsClientLink(form.role) && (
              <div className="space-y-1.5">
                <Label>Linked Client Account *</Label>
                <Select value={form.clientId} onValueChange={v => setForm(p => ({ ...p, clientId: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select client…" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map(c => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Client-role users can only see filings for this client.</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Password *</Label>
              <Input type="password" placeholder="Minimum 6 characters" value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))} autoComplete="new-password" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
              Create Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Account Dialog ─────────────────────────────────────── */}
      <Dialog open={!!editUser} onOpenChange={v => { if (!v) setEditUser(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" /> Edit Account
            </DialogTitle>
            <DialogDescription>Update the account details for {editUser?.name}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Full Name *</Label>
              <Input value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={editUser?.email ?? ""} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">Email cannot be changed.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Role *</Label>
              <Select value={editForm.role} onValueChange={v => setEditForm(p => ({ ...p, role: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsClientLink(editForm.role) && (
              <div className="space-y-1.5">
                <Label>Linked Client Account</Label>
                <Select value={editForm.clientId} onValueChange={v => setEditForm(p => ({ ...p, clientId: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select client…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {clients.map(c => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>New Password <span className="text-muted-foreground font-normal">(leave blank to keep current)</span></Label>
              <Input type="password" placeholder="Enter new password…" value={editForm.password} onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))} autoComplete="new-password" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ─────────────────────────────────────── */}
      <AlertDialog open={!!deleteUser} onOpenChange={v => { if (!v) setDeleteUser(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Account</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete the account for <strong>{deleteUser?.name}</strong> ({deleteUser?.email})? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-rose-600 hover:bg-rose-700"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete Account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
