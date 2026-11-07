// Where to send the user after signing in (/login?next=...). The value comes from the URL, so
// anyone can craft it: only same-origin, app-relative paths are accepted, otherwise the login
// page would become an open redirect.

/** Query parameter of /login that carries the return path. */
export const RETURN_TO_PARAM = "next";

/**
 * The path to return to, or null when `raw` is not a safe in-app path. Accepts "/x?y#z" only:
 * absolute ("https://..."), protocol-relative ("//host"), backslash ("/\host", which browsers
 * treat like "//") and control characters are rejected, and the result must resolve to this
 * origin. /login itself is rejected so the page cannot loop.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** "/login?next=<path>" for the given in-app path ("/login" alone when it is not worth returning to). */
export function loginHref(returnTo: string | null | undefined): string {
  const safe = safeReturnTo(returnTo);
  if (!safe || safe === "/" || safe === "/dashboard") return "/login";
  return `/login?${RETURN_TO_PARAM}=${encodeURIComponent(safe)}`;
}
