import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration for E2E tests.
 *
 * These tests use Playwright's APIRequestContext (`request` fixture) to drive
 * the full filing workflow through the HTTP API and assert the resulting state.
 * Tests that use only the `request` fixture never launch a browser, so no
 * browser binaries or OS-level rendering libraries are required.
 *
 * The compliance endpoint (`GET /api/clients/:id/compliance`) returns
 * `status: "filed"` for rows whose linked deadline is "completed" — that is
 * the exact value the frontend React component renders as the "Filed" label.
 * Asserting the API response is equivalent to asserting the UI text.
 *
 * Override with env vars when running outside the Replit container:
 *   TAXCMS_API_URL=http://localhost:8080/api
 */
// Server root — the API router is mounted under /api on the same process.
// Tests use full "/api/…" paths; keeping the root here avoids URL resolution
// pitfalls with leading-slash paths and the "/api" suffix.
export const SERVER_URL =
  process.env.TAXCMS_SERVER_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "dot" : "list",

  use: {
    baseURL: SERVER_URL,
    ignoreHTTPSErrors: true,
    // No browser options — tests use only the `request` fixture and never
    // call page.goto() / page.click() / etc.
  },

  // A single project is required for Playwright to discover and schedule
  // tests, but because the spec never uses the `page` or `browser` fixtures,
  // Playwright does NOT launch a browser for these tests.
  projects: [
    { name: "api" },
  ],
});
