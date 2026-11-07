import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const api = (path: string) => `${BASE}/api/assistant${path}`;

export interface ToolStep {
  id: string;
  label: string;
  status: "running" | "done" | "error";
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  steps?: ToolStep[];
  error?: string;
}

export interface ConversationSummary {
  id: number;
  title: string;
  updatedAt: string;
}

interface AssistantContextType {
  open: boolean;
  setOpen: (open: boolean) => void;
  enabled: boolean | null;
  messages: ChatMessage[];
  conversationId: number | null;
  streaming: boolean;
  send: (text: string) => void;
  stop: () => void;
  newChat: () => void;
  history: ConversationSummary[];
  refreshHistory: () => void;
  loadConversation: (id: number) => void;
  deleteConversation: (id: number) => void;
}

const AssistantContext = createContext<AssistantContextType | null>(null);

/** Parse a fetch() body of Server-Sent Events, calling onEvent for each one. */
async function readEvents(res: Response, onEvent: (event: string, data: any) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, JSON.parse(data.join("\n")));
    }
  }
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Reset when the signed-in user changes (logout / switch account).
  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    setHistory([]);
    setOpen(false);
    setEnabled(null);
    if (!user) return;
    fetch(api("/status"), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((s) => setEnabled(!!s.enabled))
      .catch(() => setEnabled(false));
  }, [user?.id]);

  // Ctrl/Cmd + J toggles the panel from anywhere.
  useEffect(() => {
    if (!user) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user?.id]);

  const updateLast = (fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));

  const refreshHistory = useCallback(() => {
    fetch(api("/conversations"), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then(setHistory)
      .catch(() => {});
  }, []);

  const send = useCallback(
    (text: string) => {
      const message = text.trim();
      if (!message || streaming) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      setMessages((ms) => [...ms, { role: "user", text: message }, { role: "assistant", text: "", steps: [] }]);

      // The page's main heading tells Claude what "this client" / "this filing" means.
      const title = document.querySelector("main h1")?.textContent?.trim() ?? "";

      (async () => {
        try {
          const res = await fetch(api("/chat"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, conversationId, page: { path: location, title } }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Request failed (${res.status})`);
          }
          await readEvents(res, (event, data) => {
            if (event === "text") updateLast((m) => ({ ...m, text: m.text + data.delta }));
            if (event === "tool") {
              updateLast((m) => {
                const steps = [...(m.steps ?? [])];
                const i = steps.findIndex((s) => s.id === data.id);
                const step = { id: data.id, label: data.label, status: data.status };
                if (i >= 0) steps[i] = step;
                else steps.push(step);
                return { ...m, steps };
              });
            }
            if (event === "error") updateLast((m) => ({ ...m, error: data.message }));
            if (event === "done" && data.conversationId) setConversationId(data.conversationId);
          });
        } catch (err) {
          if (!controller.signal.aborted) {
            updateLast((m) => ({ ...m, error: err instanceof Error ? err.message : "Something went wrong." }));
          }
        } finally {
          setStreaming(false);
          abortRef.current = null;
          refreshHistory();
        }
      })();
    },
    [conversationId, location, streaming, refreshHistory],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(null);
  }, []);

  const loadConversation = useCallback((id: number) => {
    abortRef.current?.abort();
    fetch(api(`/conversations/${id}`), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((conv) => {
        setConversationId(conv.id);
        setMessages(
          conv.messages.map((m: { role: "user" | "assistant"; text: string; steps?: string[] }) => ({
            role: m.role,
            text: m.text,
            steps: m.steps?.map((label, i) => ({ id: `${conv.id}-${i}`, label, status: "done" as const })),
          })),
        );
      })
      .catch(() => {});
  }, []);

  const deleteConversation = useCallback(
    (id: number) => {
      fetch(api(`/conversations/${id}`), { method: "DELETE", credentials: "include" }).finally(() => {
        if (id === conversationId) newChat();
        refreshHistory();
      });
    },
    [conversationId, newChat, refreshHistory],
  );

  return (
    <AssistantContext.Provider
      value={{ open, setOpen, enabled, messages, conversationId, streaming, send, stop, newChat, history, refreshHistory, loadConversation, deleteConversation }}
    >
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider");
  return ctx;
}
