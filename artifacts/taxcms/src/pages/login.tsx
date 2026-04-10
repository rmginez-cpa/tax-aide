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
import { Briefcase, Key } from "lucide-react";

const formSchema = z.object({
  email: z.string().email({ message: "Invalid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

export default function Login() {
  const [_, setLocation] = useLocation();
  const { toast } = useToast();
  const loginMutation = useLogin();
  const { user } = useAuth();

  // If already logged in, redirect to dashboard
  if (user) {
    setLocation("/dashboard");
    return null;
  }

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  function onSubmit(values: z.infer<typeof formSchema>) {
    loginMutation.mutate({ data: values }, {
      onSuccess: () => {
        toast({ title: "Welcome back", description: "Successfully logged in." });
        // The AuthContext will refetch the user and trigger a re-render
        // The router will then redirect to /dashboard
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
                        <Input placeholder="name@firm.ph" {...field} />
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
                        <Input type="password" placeholder="••••••••" {...field} />
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
          <CardFooter className="flex-col items-start gap-4 border-t bg-muted/50 p-6 mt-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Key className="h-4 w-4" /> Demo Credentials
            </div>
            <div className="grid grid-cols-1 gap-2 text-sm w-full">
              <div className="flex justify-between border-b pb-2">
                <span className="text-muted-foreground">Manager</span>
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">manager@firm.ph / manager123</code>
              </div>
              <div className="flex justify-between border-b pb-2">
                <span className="text-muted-foreground">Accountant</span>
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">accountant@firm.ph / accountant123</code>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Client Viewer</span>
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">client@example.com / client123</code>
              </div>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
