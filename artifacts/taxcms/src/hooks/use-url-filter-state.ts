// List filters kept in the URL query string, so a filtered list can be shared,
// bookmarked and restored with the Back button.
//
//   const [filters, setFilters] = useUrlFilterState({ status: "all", q: "" });
//   setFilters({ status: "overdue" });   // -> ?status=overdue (replaces the history entry)
//
// A value equal to its default is removed from the URL. Query parameters the hook
// does not manage (e.g. ?highlight=) are kept unless `clear` lists them.

import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";

export function useUrlFilterState<K extends string>(
  defaults: Record<K, string>,
): [Record<K, string>, (patch: Partial<Record<K, string>>, options?: { clear?: string[]; push?: boolean }) => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  // Callers pass an object literal; key it by content so the memo stays stable.
  const defaultsKey = JSON.stringify(defaults);

  const values = useMemo(() => {
    const d = JSON.parse(defaultsKey) as Record<K, string>;
    const out = { ...d };
    for (const key of Object.keys(d) as K[]) {
      const v = params.get(key);
      if (v != null) out[key] = v;
    }
    return out;
  }, [params, defaultsKey]);

  const update = useCallback(
    (patch: Partial<Record<K, string>>, options?: { clear?: string[]; push?: boolean }) => {
      const d = JSON.parse(defaultsKey) as Record<K, string>;
      // Read the live URL, not the render's copy, so two updates in one tick both apply.
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch) as [K, string | undefined][]) {
        if (value == null || value === "" || value === d[key]) next.delete(key);
        else next.set(key, value);
      }
      for (const key of options?.clear ?? []) next.delete(key);
      const qs = next.toString();
      if (qs === new URLSearchParams(window.location.search).toString()) return;
      navigate(qs ? `${location}?${qs}` : location, { replace: !options?.push });
    },
    [navigate, location, defaultsKey],
  );

  return [values, update];
}
