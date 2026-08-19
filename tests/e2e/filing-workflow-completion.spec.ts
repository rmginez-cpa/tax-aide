/**
 * E2E tests: filing workflow completion → deadline auto-marked "Filed"
 *
 * These tests use Playwright's `request` fixture (APIRequestContext) to drive
 * the full filing workflow through the HTTP API and assert the resulting state.
 * No browser is launched — the `request` fixture is a standalone, cookie-aware
 * HTTP client provided by @playwright/test.
 *
 * Why API-only?
 *   The compliance endpoint `GET /api/clients/:id/compliance` returns each
 *   deadline row with a `status` field that is either "pending", "overdue", or
 *   "filed".  The React compliance checklist renders this value verbatim as the
 *   row's visible label ("Filed", "Pending", "Overdue").  Asserting the API
 *   returns `status: "filed"` is therefore equivalent to asserting the UI
 *   shows "Filed" in that row.
 *
 * Test A — taxPayable = 0  (payment-N/A / auto-complete path)
 *   1. Login as manager
 *   2. Create test client (withholdsCompensation → generates 1601C deadlines)
 *   3. Generate BIR deadlines for year, pick one
 *   4. Start workflow → engagement created and linked to deadline
 *   5. Submit + approve: Source Collection, Draft Return, Confirmation
 *   6. PATCH taxPayable = 0  (payment waived; server auto-completes the filing)
 *   7. Assert deadline.status === "completed"  (direct API check)
 *   8. Assert compliance item.status === "filed"  (same data the UI renders)
 *
 * Test B — taxPayable > 0  (all four stages)
 *   1–4. Same setup as Test A
 *   5. Submit + approve: Source Collection, Draft Return
 *   6. PATCH taxPayable = 500  (payment required; payment stage reset)
 *   7. Submit + approve: Confirmation, Payment
 *   8. Assert deadline.status === "completed"
 *   9. Assert compliance item.status === "filed"
 */

import { test, expect } from "@playwright/test";

// ─── Constants ────────────────────────────────────────────────────────────────

const YEAR = 2026;
// Unique suffix so parallel/repeated runs never collide on TIN or client name.
const RUN_ID = Date.now().toString().slice(-6);

// Manager account seeded by the app at first startup.
// The manager role is authorised for both submit-stage (requireAuth) and
// approve-stage (requireRole("manager")).
const MANAGER_EMAIL = "manager@firm.ph";
const MANAGER_PASSWORD = "manager123";

// The API base URL is configured in playwright.config.ts as `baseURL`.
// Relative paths in request.get / request.post resolve against it.

// ─── Type helpers ─────────────────────────────────────────────────────────────

type StageKey = "source_collection" | "draft_return" | "confirmation" | "payment";

// ─── Shared test logic ────────────────────────────────────────────────────────

/**
 * Full workflow setup + stage progression shared by both tests.
 * Returns ids and identifiers needed for the final assertions.
 */
async function setupClientAndWorkflow(
  request: import("@playwright/test").APIRequestContext,
  suffix: string,
): Promise<{
  clientId: number;
  deadlineId: number;
  engagementId: number;
  formNumber: string;
  period: string;
}> {
  // ── 1. Login ───────────────────────────────────────────────────────────────
  // The APIRequestContext maintains a cookie jar for the lifetime of the test.
  // The session cookie set here is forwarded automatically on every subsequent
  // call within the same `request` context.
  const loginRes = await request.post("/api/auth/login", {
    data: { email: MANAGER_EMAIL, password: MANAGER_PASSWORD },
  });
  expect(loginRes.ok(), `Login failed: ${await loginRes.text()}`).toBeTruthy();

  // ── 2. Create a test client ────────────────────────────────────────────────
  const clientRes = await request.post("/api/clients", {
    data: {
      name: `Playwright Test Client ${suffix}`,
      // TIN must be unique across the database; embed the suffix.
      tin: `000-${suffix.slice(0, 3)}-${suffix.slice(3)}`,
      businessType: "Corporation",
      // withholdsCompensation = true → server generates 1601C monthly entries.
      withholdsCompensation: true,
      status: "active",
    },
  });
  expect(clientRes.ok(), `Create client failed: ${await clientRes.text()}`).toBeTruthy();
  const client = await clientRes.json();

  // ── 3. Generate BIR deadlines for the year ─────────────────────────────────
  const genRes = await request.post(`/api/clients/${client.id}/generate-deadlines`, {
    data: { year: YEAR, overwrite: false },
  });
  expect(genRes.ok(), `Generate deadlines failed: ${await genRes.text()}`).toBeTruthy();

  // Read the compliance list to discover the persisted deadline ids.
  const compRes = await request.get(`/api/clients/${client.id}/compliance?year=${YEAR}`);
  expect(compRes.ok()).toBeTruthy();
  const compliance = await compRes.json();

  const item = (compliance.items as Array<{
    deadlineId: number | null;
    formNumber: string;
    period: string;
  }>).find((i) => i.deadlineId !== null);

  expect(item, "Expected at least one compliance item with a deadlineId after generation").toBeTruthy();

  const deadlineId = item!.deadlineId!;
  const formNumber = item!.formNumber;
  const period = item!.period;

  // ── 4. Start a filing workflow on the deadline ─────────────────────────────
  const wfRes = await request.post(`/api/deadlines/${deadlineId}/start-workflow`);
  expect(wfRes.ok(), `Start workflow failed: ${await wfRes.text()}`).toBeTruthy();
  const engagement = await wfRes.json();

  return {
    clientId: client.id,
    deadlineId,
    engagementId: engagement.id,
    formNumber,
    period,
  };
}

/**
 * Submit a stage for review, then immediately approve it.
 */
async function submitAndApproveStage(
  request: import("@playwright/test").APIRequestContext,
  engagementId: number,
  stage: StageKey,
): Promise<void> {
  const submitRes = await request.post(`/api/engagements/${engagementId}/submit-stage`, {
    data: { stage },
  });
  expect(
    submitRes.ok(),
    `Submit stage "${stage}" failed: ${await submitRes.text()}`,
  ).toBeTruthy();

  const approveRes = await request.post(`/api/engagements/${engagementId}/approve-stage`, {
    data: { stage },
  });
  expect(
    approveRes.ok(),
    `Approve stage "${stage}" failed: ${await approveRes.text()}`,
  ).toBeTruthy();
}

/**
 * Assert that:
 *  - the deadline record in the DB has status "completed"
 *  - the compliance API returns status "filed" for the matching row
 *    (this is the exact same value the React frontend renders as "Filed")
 */
async function assertFiledState(
  request: import("@playwright/test").APIRequestContext,
  clientId: number,
  deadlineId: number,
  formNumber: string,
  period: string,
): Promise<void> {
  // Direct deadline status check.
  const dlRes = await request.get(`/api/deadlines/${deadlineId}`);
  expect(dlRes.ok()).toBeTruthy();
  const deadline = await dlRes.json();
  expect(deadline.status, "Deadline status should be 'completed' after filing").toBe("completed");

  // Compliance checklist check — same data the React UI renders.
  const compRes = await request.get(`/api/clients/${clientId}/compliance?year=${YEAR}`);
  expect(compRes.ok()).toBeTruthy();
  const compliance = await compRes.json();

  const item = (compliance.items as Array<{
    deadlineId: number | null;
    formNumber: string;
    period: string;
    status: string;
  }>).find((i) => i.deadlineId === deadlineId);

  expect(
    item,
    `Expected compliance item for deadline ${deadlineId} (${formNumber} ${period})`,
  ).toBeTruthy();

  expect(
    item!.status,
    `Compliance row for ${formNumber} ${period} should show "filed" — ` +
    `this is what the React checklist renders as the "Filed" label`,
  ).toBe("filed");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe("Filing workflow completion marks linked deadline as Filed", () => {
  /**
   * Test A — taxPayable = 0 (payment N/A, auto-complete path)
   *
   * After the first three stages are approved, setting taxPayable = 0
   * causes the server to:
   *   - waive the payment stage (not_applicable)
   *   - mark the engagement status = "completed"
   *   - set the linked deadline status = "completed"
   *
   * The compliance checklist then reflects status = "filed" for that row.
   */
  test("taxPayable=0: payment N/A path auto-completes filing → deadline Filed", async ({
    request,
  }) => {
    const suffix = `${RUN_ID}A`;
    const { clientId, deadlineId, engagementId, formNumber, period } =
      await setupClientAndWorkflow(request, suffix);

    // Approve the three non-payment stages in order.
    await submitAndApproveStage(request, engagementId, "source_collection");
    await submitAndApproveStage(request, engagementId, "draft_return");
    await submitAndApproveStage(request, engagementId, "confirmation");

    // PATCH taxPayable = 0 → server auto-completes the filing:
    //   paymentStatus → not_applicable, engagement.status → "completed",
    //   linked deadline.status → "completed".
    const patchRes = await request.patch(`/api/engagements/${engagementId}`, {
      data: { taxPayable: 0 },
    });
    expect(patchRes.ok(), `Set taxPayable=0 failed: ${await patchRes.text()}`).toBeTruthy();
    const updated = await patchRes.json();
    expect(updated.status, "Engagement should be 'completed' after taxPayable=0").toBe("completed");
    expect(
      updated.stageStatuses.payment,
      "Payment stage should be 'not_applicable' when taxPayable=0",
    ).toBe("not_applicable");

    // Verify the deadline and compliance row are both "filed".
    await assertFiledState(request, clientId, deadlineId, formNumber, period);
  });

  /**
   * Test B — taxPayable > 0 (all four stages approved)
   *
   * All four stages must be submitted and approved.  The server marks the
   * engagement "completed" on the final (payment) stage approval and
   * simultaneously sets the linked deadline status = "completed".
   *
   * The compliance checklist then reflects status = "filed" for that row.
   */
  test("taxPayable>0: all 4 stages approved completes filing → deadline Filed", async ({
    request,
  }) => {
    const suffix = `${RUN_ID}B`;
    const { clientId, deadlineId, engagementId, formNumber, period } =
      await setupClientAndWorkflow(request, suffix);

    // Approve first two stages.
    await submitAndApproveStage(request, engagementId, "source_collection");
    await submitAndApproveStage(request, engagementId, "draft_return");

    // Set a positive tax payable (makes the payment stage required and resets
    // paymentStatus to "not_started" if it was previously touched).
    const patchRes = await request.patch(`/api/engagements/${engagementId}`, {
      data: { taxPayable: 500 },
    });
    expect(patchRes.ok(), `Set taxPayable=500 failed: ${await patchRes.text()}`).toBeTruthy();

    // Approve the remaining two stages.
    await submitAndApproveStage(request, engagementId, "confirmation");

    // Approving payment is the final step; the server marks the engagement
    // "completed" and propagates the status to the linked deadline.
    // submit-stage first, then approve-stage (same order as the helper).
    const submitPaymentRes = await request.post(
      `/api/engagements/${engagementId}/submit-stage`,
      { data: { stage: "payment" } },
    );
    expect(
      submitPaymentRes.ok(),
      `Submit payment stage failed: ${await submitPaymentRes.text()}`,
    ).toBeTruthy();

    const finalApproveRes = await request.post(
      `/api/engagements/${engagementId}/approve-stage`,
      { data: { stage: "payment" } },
    );
    expect(
      finalApproveRes.ok(),
      `Approve payment stage failed: ${await finalApproveRes.text()}`,
    ).toBeTruthy();
    const completed = await finalApproveRes.json();
    expect(
      completed.status,
      "Engagement should be 'completed' after all 4 stages approved",
    ).toBe("completed");

    // Verify the deadline and compliance row are both "filed".
    await assertFiledState(request, clientId, deadlineId, formNumber, period);
  });
});
