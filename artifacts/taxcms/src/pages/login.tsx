import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth, useAuthConfig } from "@/lib/auth";
import { errorMessage } from "@/lib/api";
import { roleBadgeClass, roleLabel } from "@/lib/status";
import { useLogin } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Briefcase, Key } from "lucide-react";

const formSchema = z.object({
  email: z.string().email({ message: "Invalid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

// Seeded only when the server reports demoAccounts: true (GET /api/auth/config).
const DEMO_ACCOUNTS = [
  { role: "super_admin", email: "admin@firm.ph", password: "admin123" },
  { role: "manager", email: "manager@firm.ph", password: "manager123" },
  { role: "maker", email: "accountant@firm.ph", password: "accountant123" },
  { role: "client", email: "client@example.com", password: "client123" },
];

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const loginMutation = useLogin();
  const { user, signIn } = useAuth();
  const { config } = useAuthConfig();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  // Signed in (already, or just now): go to the dashboard. setLocation is relative to the
  // router base, so this also works when the app is served under a sub-path.
  useEffect(() => {
    if (user) setLocation("/dashboard", { replace: true });
  }, [user, setLocation]);

  if (user) return null;

  function onSubmit(values: z.infer<typeof formSchema>) {
    loginMutation.mutate({ data: values }, {
      onSuccess: (res) => {
        // Put the user in the /auth/me cache so ProtectedRoute sees them; the effect above navigates.
        signIn(res.user);
        toast({ title: "Welcome back", description: "Successfully logged in." });
      },
      onError: (error) => {
        toast({
          title: "Login failed",
          description: errorMessage(error, "Invalid credentials. Please try again."),
          variant: "destructive"
        });
      }
    });
  }

  const fillCredentials = (email: string, password: string) => {
    form.setValue("email", email);
    form.setValue("password", password);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8 dark:bg-slate-900">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <div className="flex justify-center">
          <div className="h-12 w-12 bg-primary rounded-xl flex items-center justify-center shadow-lg shadow-primary/20">
            <Briefcase className="h-6 w-6 text-primary-foreground" />
          </div>
        </div>
        <h2 className="mt-6 text-center text-3xl font-extrabold text-foreground tracking-tight">
          TaxAide
        </h2>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          Compliance Cockpit for Filipino CPAs
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <Card className="border-border shadow-xl shadow-slate-200/50 dark:shadow-none">
          <CardHeader>
            <CardTitle>Sign in to your account</CardTitle>
            <CardDescription>Enter your credentials to access the system.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input placeholder="name@firm.ph" {...field} autoComplete="email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" {...field} autoComplete="current-password" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
                  {loginMutation.isPending ? "Signing in..." : "Sign in"}
                </Button>
              </form>
            </Form>
          </CardContent>
          {config.demoAccounts && <CardFooter className="flex-col items-start gap-3 border-t bg-muted/50 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Key className="h-4 w-4" /> Demo Credentials
            </div>
            <p className="text-xs text-muted-foreground -mt-1">Click an account to fill in the credentials.</p>
            <div className="grid grid-cols-1 gap-2 w-full">
              {DEMO_ACCOUNTS.map(acct => (
                <button
                  key={acct.email}
                  type="button"
                  onClick={() => fillCredentials(acct.email, acct.password)}
                  className="flex items-center justify-between w-full p-2.5 rounded-lg border hover:bg-background text-left transition-colors group"
                >
                  <div className="flex items-center gap-2.5">
                    <Badge variant="outline" className={`text-xs ${roleBadgeClass(acct.role)}`}>{roleLabel(acct.role)}</Badge>
                    <code className="text-xs text-muted-foreground font-mono">{acct.email}</code>
                  </div>
                  <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">Click to fill</span>
                </button>
              ))}
            </div>
          </CardFooter>}
        </Card>
      </div>
    </div>
  );
}
