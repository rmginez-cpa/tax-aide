import { useEffect, useRef, useState } from "react";
import { Check, History, Loader2, Plus, SendHorizontal, Sparkles, Square, Trash2, TriangleAlert } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth";
import { useAssistant, type ChatMessage } from "@/lib/assistant";
import { Markdown } from "./Markdown";

const STAFF_PROMPTS = [
  "What's overdue across all clients?",
  "Which filings are waiting for manager approval?",
  "What's due in the next 14 days?",
  "Summarize this client's compliance status for this year",
];
const CLIENT_PROMPTS = [
  "What filings are due for us this month?",
  "Is anything overdue?",
  "Which documents have we already submitted?",
];

function Steps({ m }: { m: ChatMessage }) {
  if (!m.steps?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {m.steps.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          {s.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : s.status === "error" ? <TriangleAlert className="h-3 w-3 text-amber-600" /> : <Check className="h-3 w-3 text-emerald-600" />}
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Floating "Ask TaxAide" button plus the chat side panel. Mounted once in Layout. */
export function AssistantPanel() {
  const { user } = useAuth();
  const a = useAssistant();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [a.messages]);

  useEffect(() => {
    if (a.open) {
      a.refreshHistory();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [a.open]);

  if (!user) return null;
  // The generated User type predates the "client" role, so compare as a string.
  const role = user.role as string;
  const isClient = role === "client" || role === "viewer";
  const prompts = isClient ? CLIENT_PROMPTS : STAFF_PROMPTS;

  const submit = (text = draft) => {
    if (!text.trim() || a.streaming) return;
    a.send(text);
    setDraft("");
  };

  return (
    <>
      {!a.open && (
        <Button
          onClick={() => a.setOpen(true)}
          className="fixed bottom-5 right-5 z-40 rounded-full shadow-lg h-11 px-4 gap-2"
          title="Ask TaxAide (Ctrl/⌘ + J)"
        >
          <Sparkles className="h-4 w-4" />
          <span className="hidden sm:inline">Ask TaxAide</span>
        </Button>
      )}

      <Sheet open={a.open} onOpenChange={a.setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col gap-0">
          <SheetHeader className="px-4 py-3 border-b space-y-0">
            <div className="flex items-center gap-2 pr-8">
              <Sparkles className="h-4 w-4 text-primary" />
              <SheetTitle className="text-base flex-1">TaxAide Assistant</SheetTitle>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Past conversations">
                    <History className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel>Recent conversations</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {a.history.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">None yet</div>}
                  {a.history.map((c) => (
                    <DropdownMenuItem key={c.id} onSelect={() => a.loadConversation(c.id)} className="flex items-center gap-2">
                      <span className="flex-1 truncate">{c.title}</span>
                      <button
                        type="button"
                        aria-label="Delete conversation"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          a.deleteConversation(c.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={a.newChat} aria-label="New conversation" title="New conversation">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <SheetDescription className="text-xs">
              Powered by Claude. Read-only: it looks up your TaxAide records but can't change them.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-sm">
            {a.enabled === false && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 text-sm">
                The assistant isn't set up yet. An administrator needs to add an Anthropic API key
                (<code>ANTHROPIC_API_KEY</code>) to the API server's secrets.
              </div>
            )}

            {a.enabled !== false && a.messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-muted-foreground">
                  Ask about deadlines, filings, approvals or documents{isClient ? " for your company" : ""}. On a client or filing page, "this client" and "this filing" just work.
                </p>
                <div className="flex flex-col gap-2">
                  {prompts.map((p) => (
                    <button key={p} type="button" onClick={() => submit(p)} className="text-left rounded-md border px-3 py-2 hover:bg-muted transition-colors">
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {a.messages.map((m, idx) =>
              m.role === "user" ? (
                <div key={idx} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-primary text-primary-foreground px-3 py-2 whitespace-pre-wrap">{m.text}</div>
                </div>
              ) : (
                <div key={idx} className="max-w-full">
                  <Steps m={m} />
                  {m.text ? (
                    <Markdown text={m.text} />
                  ) : (
                    a.streaming && idx === a.messages.length - 1 && !m.error && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                      </div>
                    )
                  )}
                  {m.error && (
                    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">{m.error}</div>
                  )}
                </div>
              ),
            )}
            <div ref={endRef} />
          </div>

          <form
            className="border-t p-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={a.enabled === false ? "Assistant not configured" : "Ask a question…  (Enter to send, Shift+Enter for a new line)"}
              disabled={a.enabled === false}
              rows={2}
              maxLength={8000}
              className="min-h-[44px] max-h-40 resize-none"
            />
            {a.streaming ? (
              <Button type="button" size="icon" variant="outline" onClick={a.stop} aria-label="Stop">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!draft.trim() || a.enabled === false} aria-label="Send">
                <SendHorizontal className="h-4 w-4" />
              </Button>
            )}
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
