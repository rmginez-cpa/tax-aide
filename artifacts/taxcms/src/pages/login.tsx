import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
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

const DEMO_ACCOUNTS = [
  { label: "Super Admin", role: "super_admin", email: "admin@firm.ph", password: "admin123", badgeClass: "bg-violet-100 text-violet-800 border-violet-200" },
  { label: "Manager", role: "manager", email: "manager@firm.ph", password: "manager123", badgeClass: "bg-blue-100 text-blue-800 border-blue-200" },
  { label: "Maker", role: "maker", email: "accountant@firm.ph", password: "accountant123", badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  { label: "Client", role: "client", email: "client@example.com", password: "client123", badgeClass: "bg-amber-100 text-amber-800 border-amber-200" },
];

export default function Login() {
  const [_, setLocation] = useLocation();
  const { toast } = useToast();
  const loginMutation = useLogin();
  const { user } = useAuth();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  // If already logged in, redirect to dashboard
  if (user) {
    setLocation("/dashboard");
    return null;
  }

  function onSubmit(values: z.infer<typeof formSchema>) {
    loginMutation.mutate({ data: values }, {
      onSuccess: () => {
        toast({ title: "Welcome back", description: "Successfully logged in." });
        window.location.href = "/dashboard";
      },
      onError: (error: any) => {
        toast({ 
          title: "Login failed", 
          description: error.message || "Invalid credentials. Please try again.",
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
          <CardFooter className="flex-col items-start gap-3 border-t bg-muted/50 p-5">
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
                    <Badge variant="outline" className={`text-xs ${acct.badgeClass}`}>{acct.label}</Badge>
                    <code className="text-xs text-muted-foreground font-mono">{acct.email}</code>
                  </div>
                  <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">Click to fill</span>
                </button>
              ))}
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
