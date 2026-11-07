// Small fetch layer for the endpoints the generated client does not cover
// (file content, multipart uploads, ad-hoc JSON calls). Prefer the generated
// hooks from @workspace/api-client-react when one exists.

/** The app's base path (import.meta.env.BASE_URL) without a trailing slash; "" when served at "/". */
export const BASE_PATH = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");

/**
 * Absolute-from-origin URL for an API path, honouring the base path.
 * Accepts "/documents/1" or "/api/documents/1" (both give `${BASE_PATH}/api/documents/1`).
 */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const withApi = p === "/api" || p.startsWith("/api/") || p.startsWith("/api?") ? p : `/api${p}`;
  return `${BASE_PATH}${withApi}`;
}

/** Error thrown by apiFetch: message is the server's `{ error }` text, `status` the HTTP status (0 = network error). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly data: unknown;
  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.data = data;
  }
}

let unauthorizedHandler: ((err: ApiRequestError) => void) | null = null;

/** Register the app-wide 401 handler (App.tsx uses it to end an expired session). Returns an unregister function. */
export function setUnauthorizedHandler(handler: ((err: ApiRequestError) => void) | null): () => void {
  unauthorizedHandler = handler;
  return () => { if (unauthorizedHandler === handler) unauthorizedHandler = null; };
}

/** Options for apiFetch: a RequestInit plus `json` (serialised as the JSON body) and `responseType`. */
export type ApiFetchInit = Omit<RequestInit, "body"> & {
  /** Sent as a JSON body with Content-Type: application/json. */
  json?: unknown;
  /** Raw body (FormData, Blob, string...). Ignored when `json` is given. */
  body?: BodyInit | null;
  /** How to read a successful response; "auto" (default) parses JSON when the server sends JSON, else text. */
  responseType?: "auto" | "json" | "text" | "blob" | "response";
};

function serverMessage(data: unknown): string | null {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      if (typeof d[key] === "string" && d[key]) return d[key] as string;
    }
  }
  if (typeof data === "string" && data.trim() && data.length < 300 && !data.trimStart().startsWith("<")) {
    return data.trim();
  }
  return null;
}

/**
 * fetch() for the TaxAide API: sends cookies, encodes `json`, decodes the response and
 * throws ApiRequestError (with the server's `{ error }` message and `.status`) on non-2xx.
 * Usage: `const doc = await apiFetch<Doc>("/documents/upload", { method: "POST", body: formData })`.
 */
export async function apiFetch<T = unknown>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const { json, responseType = "auto", headers, body, ...rest } = init;
  const h = new Headers(headers);
  let finalBody: BodyInit | null | undefined = body;
  if (json !== undefined) {
    h.set("Content-Type", "application/json");
    finalBody = JSON.stringify(json);
  }
  if (!h.has("Accept") && (responseType === "auto" || responseType === "json")) {
    h.set("Accept", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(path), { credentials: "include", ...rest, headers: h, body: finalBody });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiRequestError("Could not reach the server. Check your connection and try again.", 0);
  }

  if (!res.ok) {
    let data: unknown = null;
    const text = await res.text().catch(() => "");
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    const error = new ApiRequestError(serverMessage(data) ?? `Request failed (${res.status})`, res.status, data);
    if (res.status === 401) unauthorizedHandler?.(error);
    throw error;
  }

  if (responseType === "response") return res as unknown as T;
  if (responseType === "blob") return (await res.blob()) as unknown as T;
  if (responseType === "text") return (await res.text()) as unknown as T;
  if (res.status === 204 || res.status === 205) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  if (responseType === "json" || isJson) return JSON.parse(text) as T;
  return text as unknown as T;
}

/** HTTP status of any API error (apiFetch's ApiRequestError or the generated client's ApiError), else undefined. */
export function errorStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * Human-readable message for any thrown value. For the generated client's ApiError it
 * prefers the server's `{ error }` text over the "HTTP 400 Bad Request: ..." message.
 */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!err) return fallback;
  const data = (err as { data?: unknown }).data;
  const fromData = serverMessage(data);
  if (fromData) return fromData;
  const msg = (err as { message?: unknown }).message;
  if (typeof msg === "string" && msg) return msg.replace(/^HTTP \d{3}[^:]*:\s*/, "");
  if (typeof err === "string") return err;
  return fallback;
}

/** Download a document's file (GET /api/documents/:id/content) and save it under `filename`. Throws on failure. */
export async function downloadDocument(id: number, filename: string, signal?: AbortSignal): Promise<void> {
  const blob = await apiFetch<Blob>(`/documents/${id}/content`, { responseType: "blob", signal });
  saveBlob(blob, filename);
}

/** Trigger a browser download for a Blob. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has started in every browser.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
