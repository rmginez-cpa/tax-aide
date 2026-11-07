// TaxAide documents-list / upload integration tests: GET /api/documents filters (q, stage,
// mimeType), limit/offset pagination with X-Total-Count, client scoping of every new
// parameter, and the upload error statuses (unsupported type 400, too large 413).
// Dependency-free Node 22+ ES module, shared harness (_harness.mjs), env vars and guard.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table. Point it only at a
// !! throwaway database. The script refuses to run unless TAXAIDE_TEST_RESET_DB=1.
//
// Run:  see tests/api/README.md (swap the file name)
// Env:  API_BASE, FIXTURE, UPLOADS_DIR (must equal the server's UPLOADS_DIR),
//       PGHOST/PGUSER/PGDATABASE/PGPASSWORD, ONLY=<group substring>, DRY_RUN=1
import {
  guard, BASE, cookies, sql, sqlNum, reset, CLIENT_ERR,
  CREATED, pred, arr, EMPTY, record, check, assert, group, main,
} from "./_harness.mjs";

guard({ allowDryRun: true });

const STAFF = ["maker", "manager", "admin"];
const CLIENTS = ["client", "viewer"]; // both scoped to Alpha

// ── Test data ────────────────────────────────────────────────────────────────
// Fixture docs: 1 = Alpha alpha-payroll.txt (eng 1, source_collection), 2 = Bravo bravo-sales.txt
// (eng 2, source_collection). seedDocs() adds more with fixed created_at so ordering is known.
// Ids 1..2 are the fixture (created "now"); 10.. are older, so ascending order is 10..16, 1, 2.
function seedDocs() {
  sql(`
    insert into documents (id, client_id, engagement_id, filename, original_name, mime_type, file_size, file_url, uploaded_by, stage, created_at)
    values
      (10, 1, 1,    'a.txt', 'Alpha_Payroll_Summary.pdf', 'application/pdf', 5, '/api/documents/10/content', 3, 'draft_return', '2026-01-01T00:00:00Z'),
      (11, 1, 1,    'a.txt', 'alpha receipt.png',         'image/png',       5, '/api/documents/11/content', 3, 'confirmation', '2026-01-02T00:00:00Z'),
      (12, 1, null, 'a.txt', '100%_alpha_report.xlsx',    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 5, '/api/documents/12/content', 3, null, '2026-01-03T00:00:00Z'),
      (13, 1, null, 'a.txt', 'alpha_sls.dat',             'application/octet-stream', 5, '/api/documents/13/content', 3, null, '2026-01-04T00:00:00Z'),
      (14, 2, 2,    'b.txt', 'Bravo_Payroll.pdf',         'application/pdf', 5, '/api/documents/14/content', 3, 'draft_return', '2026-01-05T00:00:00Z'),
      (15, 2, null, 'b.txt', 'bravo photo.jpeg',          'image/jpeg',      5, '/api/documents/15/content', 3, null, '2026-01-06T00:00:00Z'),
      (16, null, null, 'a.txt', 'firm_payroll_policy.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 5, '/api/documents/16/content', 2, null, '2026-01-07T00:00:00Z');
    select setval('documents_id_seq', 100);
  `);
}
const ALL_IDS = [10, 11, 12, 13, 14, 15, 16, 1, 2];
const ALPHA_IDS = [10, 11, 12, 13, 1];
const BRAVO_IDS = [14, 15, 2];

const ids = (a) => a.map((d) => d.id);
const sameIds = (a, expected) => JSON.stringify(ids(a)) === JSON.stringify(expected);
function idsAre(expected) {
  return arr(`ids ${JSON.stringify(expected)}`, (a) => sameIds(a, expected) || `got ${JSON.stringify(ids(a))}`);
}
function idSetIs(expected) {
  const want = [...expected].sort((x, y) => x - y);
  return arr(`id set ${JSON.stringify(want)}`, (a) => {
    const got = ids(a).sort((x, y) => x - y);
    return JSON.stringify(got) === JSON.stringify(want) || `got ${JSON.stringify(got)}`;
  });
}
/** 200 + array with these ids (in order) + X-Total-Count = total. */
function pageIs(expected, total) {
  return {
    desc: `200 + ids ${JSON.stringify(expected)} + X-Total-Count ${total}`,
    test: (r) => {
      if (r.status !== 200 || !Array.isArray(r.json)) return false;
      const header = r.headers.get("x-total-count");
      if (header !== String(total)) return `X-Total-Count ${header}`;
      return sameIds(r.json, expected) || `got ${JSON.stringify(ids(r.json))}`;
    },
  };
}
function errorMentions(status, ...words) {
  return pred(`error mentions ${words.join(", ")}`, (j) => {
    const msg = String(j?.error ?? "");
    return words.every((w) => msg.toLowerCase().includes(w.toLowerCase())) || `error "${msg}"`;
  }, status);
}

function fileUpload(fields, { content = "hello", name = "docs-test.txt", type = "text/plain" } = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) Filters (staff)
// ═════════════════════════════════════════════════════════════════════════════
group("1 list filters", async () => {
  await reset();
  seedDocs();
  for (const role of STAFF) {
    await check("GET /documents unfiltered (asc)", role, "GET", "/documents", null, pageIs(ALL_IDS, ALL_IDS.length));
    await check("q=payroll (case-insensitive name contains)", role, "GET", "/documents?q=PAYROLL", null, idsAre([10, 14, 16, 1]));
    await check("q trims whitespace", role, "GET", "/documents?q=%20%20bravo%20", null, idsAre([14, 15, 2]));
    await check("q=% matches a literal percent only", role, "GET", "/documents?q=%25", null, idsAre([12]));
    await check("q=_ matches a literal underscore only", role, "GET", "/documents?q=_", null, idsAre([10, 12, 13, 14, 16]));
    await check("q matches nothing", role, "GET", "/documents?q=zzz-nothing", null, pageIs([], 0));
    await check("stage=draft_return", role, "GET", "/documents?stage=draft_return", null, idsAre([10, 14]));
    await check("stage=source_collection", role, "GET", "/documents?stage=source_collection", null, idsAre([1, 2]));
    await check("stage=none (no stage)", role, "GET", "/documents?stage=none", null, idsAre([12, 13, 15, 16]));
    await check("stage invalid -> 400", role, "GET", "/documents?stage=bogus", null, errorMentions(400, "stage"));
    await check("mimeType=image/", role, "GET", "/documents?mimeType=image%2F", null, idsAre([11, 15]));
    await check("mimeType=application/pdf", role, "GET", "/documents?mimeType=application%2Fpdf", null, idsAre([10, 14]));
    await check("mimeType list = any of", role, "GET", "/documents?mimeType=application%2Fpdf,image%2F", null, idsAre([10, 11, 14, 15]));
    await check("mimeType prefix is case-insensitive", role, "GET", "/documents?mimeType=IMAGE%2FPNG", null, idsAre([11]));
    await check("mimeType wildcard is literal", role, "GET", "/documents?mimeType=%25", null, 400);
    await check("mimeType invalid -> 400", role, "GET", "/documents?mimeType=%3Cscript%3E", null, 400);
    await check("filters combine (client + q + mimeType)", role, "GET", "/documents?clientId=1&q=alpha&mimeType=application%2Fpdf", null, idsAre([10]));
    await check("filters combine (engagement + stage)", role, "GET", "/documents?engagementId=1&stage=confirmation", null, idsAre([11]));
    await check("order=desc", role, "GET", "/documents?order=desc", null, idsAre([...ALL_IDS].reverse()));
    await check("order invalid -> 400", role, "GET", "/documents?order=sideways", null, 400);
    await check("q too long -> 400", role, "GET", `/documents?q=${"a".repeat(201)}`, null, 400);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) Pagination
// ═════════════════════════════════════════════════════════════════════════════
group("2 pagination", async () => {
  await reset();
  seedDocs();
  const M = "manager";
  await check("limit=2 offset=0", M, "GET", "/documents?limit=2&offset=0", null, pageIs([10, 11], 9));
  await check("limit=2 offset=2", M, "GET", "/documents?limit=2&offset=2", null, pageIs([12, 13], 9));
  await check("limit=4 offset=8 (last, partial)", M, "GET", "/documents?limit=4&offset=8", null, pageIs([2], 9));
  await check("offset past the end", M, "GET", "/documents?limit=5&offset=50", null, pageIs([], 9));
  await check("limit without offset", M, "GET", "/documents?limit=3", null, pageIs([10, 11, 12], 9));
  await check("offset without limit", M, "GET", "/documents?offset=7", null, pageIs([1, 2], 9));
  await check("desc + paging", M, "GET", "/documents?order=desc&limit=3&offset=0", null, pageIs([2, 1, 16], 9));
  await check("total counts the filter, not the table", M, "GET", "/documents?q=payroll&limit=1&offset=1", null, pageIs([14], 4));
  // Walking every page returns every document exactly once.
  const seen = [];
  for (let offset = 0; offset < 20; offset += 4) {
    const r = await check(`walk offset=${offset}`, M, "GET", `/documents?limit=4&offset=${offset}`, null,
      pred("array + total 9", (j, res) => Array.isArray(j) && res.headers.get("x-total-count") === "9"));
    seen.push(...ids(r.json ?? []));
  }
  assert("pages cover every document once, in order", () => JSON.stringify(seen) === JSON.stringify(ALL_IDS),
    JSON.stringify(ALL_IDS), JSON.stringify(seen));
  for (const [desc, qs] of [
    ["limit=0", "limit=0"], ["limit=201", "limit=201"], ["limit=abc", "limit=abc"], ["limit=-1", "limit=-1"],
    ["limit=1.5", "limit=1.5"], ["offset=-1", "offset=-1"], ["offset=x", "offset=x"],
  ]) {
    await check(`${desc} -> 400`, M, "GET", `/documents?${qs}`, null, 400);
  }
  await check("limit=200 allowed", M, "GET", "/documents?limit=200", null, pageIs(ALL_IDS, 9));
  await check("response shape unchanged (fields present)", M, "GET", "/documents?limit=1", null,
    arr("serialized document", (a) => a.length === 1 && ["id", "originalName", "mimeType", "fileSize", "clientName", "uploadedByName", "stage", "createdAt"]
      .every((k) => k in a[0])));
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) Client scoping of the new parameters
// ═════════════════════════════════════════════════════════════════════════════
group("3 client scoping", async () => {
  await reset();
  seedDocs();
  for (const role of CLIENTS) {
    await check("unfiltered: only Alpha", role, "GET", "/documents", null, pageIs(ALPHA_IDS, ALPHA_IDS.length));
    await check("q=bravo finds nothing", role, "GET", "/documents?q=bravo", null, pageIs([], 0));
    await check("q=payroll: only Alpha's", role, "GET", "/documents?q=payroll", null, idsAre([10, 1]));
    await check("q=firm: unlinked firm docs hidden", role, "GET", "/documents?q=firm", null, EMPTY);
    await check("stage=draft_return: only Alpha's", role, "GET", "/documents?stage=draft_return", null, idsAre([10]));
    await check("stage=none: no Bravo / firm docs", role, "GET", "/documents?stage=none", null, idsAre([12, 13]));
    await check("mimeType=image/: only Alpha's", role, "GET", "/documents?mimeType=image%2F", null, idsAre([11]));
    await check("X-Total-Count counts only own docs", role, "GET", "/documents?limit=2", null, pageIs([10, 11], ALPHA_IDS.length));
    await check("offset cannot reach other clients' docs", role, "GET", "/documents?limit=50&offset=5", null, pageIs([], ALPHA_IDS.length));
    await check("clientId=2 + paging", role, "GET", "/documents?clientId=2&limit=5", null, pageIs([], 0));
    await check("engagementId=2 + stage", role, "GET", "/documents?engagementId=2&stage=draft_return", null, pageIs([], 0));
    await check("invalid stage still 400", role, "GET", "/documents?stage=bogus", null, 400);
  }
  await check("clientb: only Bravo", "clientb", "GET", "/documents?order=desc&limit=10", null, pageIs([2, 15, 14], BRAVO_IDS.length));
  await check("clientb q=alpha", "clientb", "GET", "/documents?q=alpha", null, pageIs([], 0));
  await check("orphan client: nothing, total 0", "orphan", "GET", "/documents?limit=5", null, pageIs([], 0));
  await check("orphan client q", "orphan", "GET", "/documents?q=payroll", null, pageIs([], 0));
  await check("signed out", null, "GET", "/documents?q=payroll", null, 401);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) Upload errors and linking
// ═════════════════════════════════════════════════════════════════════════════
group("4 upload", async () => {
  await reset();
  const count = () => sqlNum("select count(*) from documents");
  const before = count();
  for (const role of STAFF) {
    await check("unsupported type -> 400 listing allowed types", role, "POST", "/documents/upload",
      () => fileUpload({}, { name: "setup.exe", type: "application/x-msdownload" }),
      errorMentions(400, "unsupported file type", "allowed", "pdf", "excel", "word", "csv"));
    await check("text/html -> 400", role, "POST", "/documents/upload",
      () => fileUpload({}, { name: "page.html", type: "text/html", content: "<script>1</script>" }), 400);
  }
  assert("no document stored by rejected uploads", () => count() === before, before, count);
  await check("too large -> 413", "maker", "POST", "/documents/upload",
    () => fileUpload({}, { content: new Uint8Array(50 * 1024 * 1024 + 1), name: "big.pdf", type: "application/pdf" }),
    errorMentions(413, "too large", "50 MB"));
  assert("no document stored by the oversized upload", () => count() === before, before, count);
  await check("malformed multipart -> 400", "maker", "POST", "/documents/upload", null, CLIENT_ERR);
  {
    const r = await (async () => {
      const res = await fetch(`${BASE}/documents/upload`, {
        method: "POST",
        headers: { Cookie: cookies.maker, "Content-Type": "multipart/form-data; boundary=XYZ" },
        body: "--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhel",
      });
      return { status: res.status, text: await res.text() };
    })();
    record("[maker] truncated multipart body -> 400 (not 500)", r.status === 400, 400, `${r.status} ${r.text.slice(0, 120)}`);
  }
  await check("second file field -> 400", "maker", "POST", "/documents/upload", () => {
    const fd = fileUpload({});
    fd.append("other", new Blob(["x"], { type: "text/plain" }), "x.txt");
    return fd;
  }, 400);
  await check(".dat as octet-stream accepted", "maker", "POST", "/documents/upload",
    () => fileUpload({ clientId: 1 }, { name: "sls.dat", type: "application/octet-stream" }), CREATED);
  await check(".csv with an odd MIME type accepted (by extension)", "maker", "POST", "/documents/upload",
    () => fileUpload({ clientId: 1 }, { name: "slp.csv", type: "application/vnd.ms-office" }), CREATED);
  // The documents page links an upload to client + filing + stage.
  const up = await check("client + filing + stage upload", "maker", "POST", "/documents/upload",
    () => fileUpload({ clientId: 2, engagementId: 2, stage: "draft_return" }, { name: "bravo-draft.pdf", type: "application/pdf" }),
    pred("linked", (j) => j?.clientId === 2 && j?.engagementId === 2 && j?.stage === "draft_return", 201));
  await check("the upload is found by the page's filters", "manager", "GET",
    "/documents?clientId=2&engagementId=2&stage=draft_return&mimeType=application%2Fpdf&q=draft&limit=25&offset=0&order=desc", null,
    pageIs(up.json?.id ? [up.json.id] : [-1], 1));
  await check("client role upload still 403 (unsupported type too)", "client", "POST", "/documents/upload",
    () => fileUpload({}, { name: "setup.exe", type: "application/x-msdownload" }), 403);
  await check("client sees the Bravo upload? no", "client", "GET", "/documents?q=bravo-draft", null, pageIs([], 0));
  await check("clientb sees its new upload", "clientb", "GET", "/documents?q=bravo-draft", null, idSetIs(up.json?.id ? [up.json.id] : [-1]));
});

// ── Main ─────────────────────────────────────────────────────────────────────
await main({ reset });
