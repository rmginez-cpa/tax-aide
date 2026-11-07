import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { FileQuestion, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Friendly 404. Inside the app shell for signed-in users; centred on its own page otherwise
 * (the dashboard link then leads to the sign-in page).
 */
export default function NotFound({ signedIn = true }: { signedIn?: boolean }) {
  return (
    <div
      className={cn(
        "w-full flex items-center justify-center px-4",
        signedIn ? "min-h-[60vh]" : "min-h-screen bg-slate-50 dark:bg-slate-900",
      )}
    >
      <div className="max-w-md text-center space-y-4">
        <div className="mx-auto h-14 w-14 rounded-full bg-muted flex items-center justify-center">
          <FileQuestion className="h-7 w-7 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">Page not found</h1>
          <p className="text-sm text-muted-foreground">
            The page you're looking for doesn't exist or may have been moved.
            Check the address, or head back to your dashboard.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {signedIn ? "Back to dashboard" : "Go to TaxAide"}
          </Link>
        </Button>
      </div>
    </div>
  );
}
