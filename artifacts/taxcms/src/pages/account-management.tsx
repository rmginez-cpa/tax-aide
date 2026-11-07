import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUsers,
  useListClients,
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
  type User as UserRecord,
  type UserRole,
} from "@workspace/api-client-react";
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
import { ShieldCheck, Plus, Pencil, Trash2, Loader2, User, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useConfirm } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { invalidateFilingData, invalidatePrefixes } from "@/lib/queries";
import { isClientRole } from "@/lib/permissions";
import { ASSIGNABLE_ROLES, ROLE_DESCRIPTIONS, roleBadgeClass, roleLabel } from "@/lib/status";

/** Must match the server's MIN_PASSWORD_LENGTH (api-server lib/passwordPolicy.ts). */
const MIN_PASSWORD_LENGTH = 8;
/** Select value for "no linked client" (Radix Select items cannot use ""). */
const NO_CLIENT = "none";

/** Client select value -> API clientId. "" and the "none" sentinel mean unlinked (null). */
function parseClientId(value: string): number | null {
  if (!value || value === NO_CLIENT) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Client and viewer accounts are scoped to one client, so they must be linked to one. */
const needsClientLink = (role: string) => isClientRole(role);

interface AccountForm {
  name: string;
  email: string;
  role: UserRole;
  password: string;
  clientId: string;
}

type FormErrors = Partial<Record<"name" | "email" | "password" | "clientId", string>>;

const BLANK_FORM: AccountForm = { name: "", email: "", role: "maker", password: "", clientId: "" };

/** Field errors for the create (password required) or edit (blank password = keep) form. */
function validate(form: AccountForm, mode: "create" | "edit"): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = "Name is required.";
  if (mode === "create") {
    const email = form.email.trim();
    if (!email) errors.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+$/.test(email)) errors.email = "Enter a valid email address.";
  }
  if (mode === "create" || form.password !== "") {
    if (form.password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
  }
  if (needsClientLink(form.role) && parseClientId(form.clientId) == null) {
    errors.clientId = `${roleLabel(form.role)} accounts must be linked to a client.`;
  }
  return errors;
}

/** Role change: staff roles never keep a client link. */
function withRole(form: AccountForm, role: string): AccountForm {
  const r = role as UserRole;
  return { ...form, role: r, clientId: needsClientLink(r) ? form.clientId : "" };
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={id} className="text-xs text-destructive">{message}</p>;
}

export default function AccountManagement() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserRecord | null>(null);
  const [form, setForm] = useState<AccountForm>(BLANK_FORM);
  const [editForm, setEditForm] = useState<AccountForm>(BLANK_FORM);
  const [createErrors, setCreateErrors] = useState<FormErrors | null>(null);
  const [editErrors, setEditErrors] = useState<FormErrors | null>(null);

  const { data: users = [], isLoading, isError, error, refetch, isFetching } = useListUsers();
  const { data: clients = [], isError: clientsError, error: clientsErr, refetch: refetchClients } = useListClients();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUserMutation = useDeleteUser();

  const refreshAfterChange = async () => {
    await Promise.all([
      invalidatePrefixes(queryClient, ["/api/users"]),
      // Role changes and deletions unassign filings and drop notifications.
      invalidateFilingData(queryClient),
    ]);
  };

  // Live validation once the user has tried to submit.
  const createShown = createErrors ? validate(form, "create") : {};
  const editShown = editErrors ? validate(editForm, "edit") : {};

  const handleCreate = async () => {
    const errors = validate(form, "create");
    if (Object.keys(errors).length) {
      setCreateErrors(errors);
      toast({ title: Object.values(errors)[0], variant: "destructive" });
      return;
    }
    try {
      await createUser.mutateAsync({
        data: {
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          role: form.role,
          password: form.password,
          clientId: needsClientLink(form.role) ? parseClientId(form.clientId) : null,
        },
      });
      await refreshAfterChange();
      setCreateOpen(false);
      setForm(BLANK_FORM);
      setCreateErrors(null);
      toast({ title: "Account created successfully" });
    } catch (e) {
      toast({ title: "Failed to create account", description: errorMessage(e), variant: "destructive" });
    }
  };

  const openCreate = () => {
    setForm(BLANK_FORM);
    setCreateErrors(null);
    setCreateOpen(true);
  };

  const openEdit = (u: UserRecord) => {
    setEditUser(u);
    setEditErrors(null);
    setEditForm({
      name: u.name,
      email: u.email,
      role: u.role,
      password: "",
      clientId: u.clientId != null ? String(u.clientId) : "",
    });
  };

  const handleEdit = async () => {
    if (!editUser) return;
    const errors = validate(editForm, "edit");
    if (Object.keys(errors).length) {
      setEditErrors(errors);
      toast({ title: Object.values(errors)[0], variant: "destructive" });
      return;
    }
    const isSelf = editUser.id === currentUser?.id;
    try {
      await updateUser.mutateAsync({
        id: editUser.id,
        data: {
          name: editForm.name.trim(),
          ...(isSelf ? {} : { role: editForm.role }),
          ...(editForm.password !== "" ? { password: editForm.password } : {}),
          // Staff roles are always unlinked; the "none" sentinel maps to null.
          ...(isSelf ? {} : { clientId: needsClientLink(editForm.role) ? parseClientId(editForm.clientId) : null }),
        },
      });
      await refreshAfterChange();
      setEditUser(null);
      setEditErrors(null);
      toast({ title: "Account updated" });
    } catch (e) {
      toast({ title: "Failed to update account", description: errorMessage(e), variant: "destructive" });
    }
  };

  const handleDelete = async (u: UserRecord) => {
    if (u.id === currentUser?.id) {
      toast({ title: "You cannot delete your own account", variant: "destructive" });
      return;
    }
    const deleted = await confirm({
      title: "Delete account?",
      description: (
        <>
          This permanently deletes the account for <strong>{u.name}</strong> ({u.email}). Their filings are
          unassigned. This action cannot be undone.
        </>
      ),
      confirmLabel: "Delete Account",
      destructive: true,
      onConfirm: () => deleteUserMutation.mutateAsync({ id: u.id }),
    });
    if (!deleted) return;
    await refreshAfterChange();
    toast({ title: "Account deleted" });
  };

  /** Assignable roles, plus the account's current role when it is a legacy value (e.g. accountant). */
  const roleOptions = (current?: string): string[] =>
    current && !(ASSIGNABLE_ROLES as readonly string[]).includes(current)
      ? [...ASSIGNABLE_ROLES, current]
      : [...ASSIGNABLE_ROLES];

  const clientSelect = (
    idPrefix: string,
    f: AccountForm,
    setF: (updater: (p: AccountForm) => AccountForm) => void,
    errors: FormErrors,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-client`}>Linked Client *</Label>
      {clientsError ? (
        <ErrorState compact title="Could not load clients" error={clientsErr} onRetry={refetchClients} />
      ) : (
        <Select
          value={parseClientId(f.clientId) != null ? f.clientId : ""}
          onValueChange={v => setF(p => ({ ...p, clientId: v }))}
        >
          <SelectTrigger
            id={`${idPrefix}-client`}
            aria-invalid={errors.clientId ? true : undefined}
            aria-describedby={`${idPrefix}-client-help`}
          >
            <SelectValue placeholder="Select client…" />
          </SelectTrigger>
          <SelectContent>
            {clients.map(c => (
              <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <FieldError id={`${idPrefix}-client-error`} message={errors.clientId} />
      <p id={`${idPrefix}-client-help`} className="text-xs text-muted-foreground">
        {roleLabel(f.role)} accounts can only see filings for this client.
      </p>
    </div>
  );

  const editingSelf = editUser != null && editUser.id === currentUser?.id;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            Create Account
          </Button>
        </div>
      </div>

      {/* Role summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {ASSIGNABLE_ROLES.map(role => {
          const count = users.filter(u => u.role === role || (role === "maker" && u.role === "accountant")).length;
          return (
            <Card key={role} className="p-3">
              <div className="flex items-center justify-between mb-1">
                <Badge variant="outline" className={`text-xs ${roleBadgeClass(role)}`}>{roleLabel(role)}</Badge>
                <span className="text-lg font-bold text-foreground">{count}</span>
              </div>
              <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
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
          ) : isError ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={refetch} />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Email</TableHead>
                  <TableHead className="hidden sm:table-cell">Role</TableHead>
                  <TableHead className="hidden sm:table-cell">Linked Client</TableHead>
                  <TableHead className="hidden lg:table-cell">Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map(u => {
                  const linkedClient = u.clientId ? clients.find(c => c.id === u.clientId) : null;
                  const isSelf = u.id === currentUser?.id;
                  const unlinkedClientAccount = isClientRole(u.role) && !u.clientId;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0" aria-hidden="true">
                            {u.name.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="break-words">{u.name}</span>
                              {isSelf && <Badge variant="outline" className="text-xs h-4 px-1">You</Badge>}
                            </div>
                            <p className="text-xs font-normal text-muted-foreground break-all md:hidden">{u.email}</p>
                            <Badge variant="outline" className={`text-xs mt-1 sm:hidden ${roleBadgeClass(u.role)}`}>{roleLabel(u.role)}</Badge>
                            {(linkedClient || unlinkedClientAccount) && (
                              <p className="text-xs font-normal text-muted-foreground sm:hidden">
                                {linkedClient ? linkedClient.name : <span className="text-amber-700">No linked client</span>}
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground hidden md:table-cell">{u.email}</TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="outline" className={`text-xs ${roleBadgeClass(u.role)}`}>{roleLabel(u.role)}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground hidden sm:table-cell">
                        {linkedClient ? linkedClient.name
                          : unlinkedClientAccount ? <span className="text-amber-700">Not linked</span>
                          : <span className="text-muted-foreground/50">—</span>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground hidden lg:table-cell">
                        {formatDate(u.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => openEdit(u)}
                            aria-label={`Edit ${u.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                            onClick={() => handleDelete(u)}
                            disabled={isSelf}
                            aria-label={isSelf ? "You cannot delete your own account" : `Delete ${u.name}`}
                            title={isSelf ? "You cannot delete your own account" : undefined}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
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
              <Label htmlFor="create-name">Full Name *</Label>
              <Input
                id="create-name"
                placeholder="e.g. Maria Santos"
                value={form.name}
                aria-invalid={createShown.name ? true : undefined}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              />
              <FieldError id="create-name-error" message={createShown.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-email">Email Address *</Label>
              <Input
                id="create-email"
                type="email"
                placeholder="name@firm.ph"
                value={form.email}
                aria-invalid={createShown.email ? true : undefined}
                onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
              />
              <FieldError id="create-email-error" message={createShown.email} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-role">Role *</Label>
              <Select value={form.role} onValueChange={v => setForm(p => withRole(p, v))}>
                <SelectTrigger id="create-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map(r => (
                    <SelectItem key={r} value={r}>
                      <div>
                        <span className="font-medium">{roleLabel(r)}</span>
                        <span className="text-muted-foreground ml-1.5 text-xs">— {ROLE_DESCRIPTIONS[r]}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsClientLink(form.role) && clientSelect("create", form, setForm, createShown)}
            <div className="space-y-1.5">
              <Label htmlFor="create-password">Password *</Label>
              <Input
                id="create-password"
                type="password"
                placeholder={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
                value={form.password}
                onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                autoComplete="new-password"
                aria-invalid={createShown.password ? true : undefined}
                aria-describedby="create-password-help"
              />
              <FieldError id="create-password-error" message={createShown.password} />
              <p id="create-password-help" className="text-xs text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createUser.isPending}>
              {createUser.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
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
              <Label htmlFor="edit-name">Full Name *</Label>
              <Input
                id="edit-name"
                value={editForm.name}
                aria-invalid={editShown.name ? true : undefined}
                onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))}
              />
              <FieldError id="edit-name-error" message={editShown.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-email">Email</Label>
              <Input id="edit-email" value={editUser?.email ?? ""} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">Email cannot be changed.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-role">Role *</Label>
              <Select value={editForm.role} onValueChange={v => setEditForm(p => withRole(p, v))} disabled={editingSelf}>
                <SelectTrigger id="edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions(editUser?.role).map(r => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}{(ASSIGNABLE_ROLES as readonly string[]).includes(r) ? "" : ` (legacy "${r}")`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editingSelf && (
                <p className="text-xs text-muted-foreground">You cannot change your own role.</p>
              )}
            </div>
            {!editingSelf && needsClientLink(editForm.role) && clientSelect("edit", editForm, setEditForm, editShown)}
            <div className="space-y-1.5">
              <Label htmlFor="edit-password">
                New Password <span className="text-muted-foreground font-normal">(leave blank to keep current)</span>
              </Label>
              <Input
                id="edit-password"
                type="password"
                placeholder="Enter new password…"
                value={editForm.password}
                onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))}
                autoComplete="new-password"
                aria-invalid={editShown.password ? true : undefined}
                aria-describedby="edit-password-help"
              />
              <FieldError id="edit-password-error" message={editShown.password} />
              <p id="edit-password-help" className="text-xs text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={updateUser.isPending}>
              {updateUser.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
