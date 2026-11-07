// Global search / command palette. Mounted once in components/layout.tsx.
//
// Ctrl/Cmd+K toggles it from anywhere; "/" opens it when the user is not typing in a field.
// (Ctrl/Cmd+J stays with the assistant.) Results: the navigation pages the user may open,
// clients (staff only), filings and deadlines. Lists come from the existing list endpoints,
// with the same query keys as the pages, fetched only once the palette has been opened
// and then kept in the react-query cache.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useListClients, useListEngagements, useListDeadlines,
  getListClientsQueryKey, getListEngagementsQueryKey, getListDeadlinesQueryKey,
} from "@workspace/api-client-react";
import { Briefcase, Calendar, Loader2, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useAuth } from "@/lib/auth";
import { isClientRole, isStaff } from "@/lib/permissions";
import { formatDate } from "@/lib/format";
import { navItemsFor } from "@/components/navigation";

/** Results shown per group while searching. */
const MAX_PER_GROUP = 8;
/** Cached list data counts as fresh for this long (the pages refetch on their own). */
const STALE_MS = 60_000;

/** True on Apple platforms, where the shortcut is Cmd rather than Ctrl. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X/.test(navigator.userAgent);
}

/** The palette shortcut as shown in <Kbd>: "⌘K" or "Ctrl K". */
export function PaletteShortcut({ className }: { className?: string }) {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMacPlatform()), []);
  return <Kbd className={className}>{mac ? "⌘K" : "Ctrl K"}</Kbd>;
}

/** True when a key press is aimed at a text field (so "/" must not open the palette). */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']");
}

/** Normalise for matching: lower case, accents removed. */
function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

interface Entry {
  key: string;
  label: string;
  hint?: string;
  haystack: string;
  href: string;
}

/** Every whitespace-separated term of `query` appears in the entry (digits also match without dashes). */
function matches(entry: Entry, terms: string[]): boolean {
  return terms.every((t) => entry.haystack.includes(t));
}

function haystack(...parts: Array<string | null | undefined>): string {
  const text = norm(parts.filter(Boolean).join(" "));
  // "111111111" finds "111-111-111-000".
  return `${text} ${text.replace(/[-\s]/g, "")}`;
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  // Fetch the lists the first time the palette opens, then keep observing them (cached).
  const [activated, setActivated] = useState(false);
  const role = user?.role ?? "";
  const staff = isStaff(role);
  const client = isClientRole(role);

  useEffect(() => {
    if (open) setActivated(true);
    else setQuery("");
  }, [open]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key === "k") {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !open && !isTypingTarget(e.target)) {
        // Leave "/" alone while another dialog (assistant, confirm...) is open.
        if (document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']")) return;
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const enabled = activated && !!user;
  const clientsQ = useListClients({ query: { queryKey: getListClientsQueryKey(), enabled: enabled && staff, staleTime: STALE_MS } });
  const engagementsQ = useListEngagements(undefined, { query: { queryKey: getListEngagementsQueryKey(), enabled, staleTime: STALE_MS } });
  const deadlinesQ = useListDeadlines(undefined, { query: { queryKey: getListDeadlinesQueryKey(), enabled, staleTime: STALE_MS } });

  const pages = useMemo<Array<Entry & { icon: React.ElementType }>>(
    () => navItemsFor(role).map((item) => ({
      key: `page-${item.href}`,
      label: item.name,
      haystack: haystack(item.name, item.keywords),
      href: item.href,
      icon: item.icon,
    })),
    [role],
  );

  const clients = useMemo<Entry[]>(
    () => (staff ? clientsQ.data ?? [] : []).map((c) => ({
      key: `client-${c.id}`,
      label: c.name,
      hint: [c.tradeName && c.tradeName !== c.name ? c.tradeName : null, c.tin].filter(Boolean).join(" · "),
      haystack: haystack(c.name, c.tradeName, c.tin),
      href: `/clients/${c.id}`,
    })),
    [clientsQ.data, staff],
  );

  const filings = useMemo<Entry[]>(
    () => (engagementsQ.data ?? []).map((e) => ({
      key: `filing-${e.id}`,
      label: e.title,
      hint: [e.clientName, e.taxType, e.period].filter(Boolean).join(" · "),
      haystack: haystack(e.title, e.clientName, e.taxType, e.period),
      href: `/engagements/${e.id}`,
    })),
    [engagementsQ.data],
  );

  const deadlines = useMemo<Entry[]>(
    () => (deadlinesQ.data ?? []).flatMap((d) => {
      // Clients cannot open the deadlines page: send them to the linked filing, else skip.
      const href = client
        ? d.engagementId != null ? `/engagements/${d.engagementId}` : null
        : `/deadlines?highlight=${d.id}`;
      if (!href) return [];
      return [{
        key: `deadline-${d.id}`,
        label: d.title,
        hint: [d.clientName, `Due ${formatDate(d.dueDate)}`, d.status === "completed" ? "Completed" : null].filter(Boolean).join(" · "),
        haystack: haystack(d.title, d.clientName),
        href,
      }];
    }),
    [deadlinesQ.data, client],
  );

  const terms = norm(query).split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const pick = <T extends Entry>(list: T[], limit = MAX_PER_GROUP) =>
    searching ? list.filter((e) => matches(e, terms)).slice(0, limit) : [];

  const pageResults = searching ? pages.filter((p) => matches(p, terms)) : pages;
  const clientResults = pick(clients);
  const filingResults = pick(filings);
  const deadlineResults = pick(deadlines);
  const loading = searching && (clientsQ.isFetching || engagementsQ.isFetching || deadlinesQ.isFetching);
  const failed = clientsQ.isError || engagementsQ.isError || deadlinesQ.isError;
  const nothing = !pageResults.length && !clientResults.length && !filingResults.length && !deadlineResults.length;

  const go = (href: string) => {
    onOpenChange(false);
    setLocation(href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 top-[12%] translate-y-0 data-[state=closed]:slide-out-to-top-[10%] data-[state=open]:slide-in-from-top-[10%] w-[calc(100%-2rem)] max-w-lg rounded-lg">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search pages, {staff ? "clients, " : ""}filings and deadlines. Use the arrow keys to move and Enter to open.
        </DialogDescription>
        <Command
          shouldFilter={false}
          loop
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={staff ? "Search pages, clients, filings, deadlines..." : "Search pages, filings, deadlines..."}
            aria-label="Search"
            className="pr-8"
          />
          <CommandList className="max-h-[min(60vh,420px)]">
            {nothing && !loading && (
              <CommandEmpty>{failed ? "Some results could not be loaded." : "No results found."}</CommandEmpty>
            )}
            {pageResults.length > 0 && (
              <CommandGroup heading="Pages">
                {pageResults.map((p) => (
                  <CommandItem key={p.key} value={p.key} onSelect={() => go(p.href)}>
                    <p.icon className="text-muted-foreground" aria-hidden="true" />
                    <span>{p.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {clientResults.length > 0 && (
              <CommandGroup heading="Clients">
                {clientResults.map((e) => <ResultItem key={e.key} entry={e} icon={Users} onSelect={go} />)}
              </CommandGroup>
            )}
            {filingResults.length > 0 && (
              <CommandGroup heading="Filings">
                {filingResults.map((e) => <ResultItem key={e.key} entry={e} icon={Briefcase} onSelect={go} />)}
              </CommandGroup>
            )}
            {deadlineResults.length > 0 && (
              <CommandGroup heading="Deadlines">
                {deadlineResults.map((e) => <ResultItem key={e.key} entry={e} icon={Calendar} onSelect={go} />)}
              </CommandGroup>
            )}
            {loading && nothing && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Searching...
              </div>
            )}
          </CommandList>
          <div className="hidden sm:flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
            <span className="flex items-center gap-1"><Kbd>Enter</Kbd> to open</span>
            <span className="flex items-center gap-1"><Kbd>Esc</Kbd> to close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function ResultItem({ entry, icon: Icon, onSelect }: { entry: Entry; icon: React.ElementType; onSelect: (href: string) => void }) {
  return (
    <CommandItem value={entry.key} onSelect={() => onSelect(entry.href)}>
      <Icon className="text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate">{entry.label}</p>
        {entry.hint && <p className="truncate text-xs text-muted-foreground">{entry.hint}</p>}
      </div>
    </CommandItem>
  );
}
