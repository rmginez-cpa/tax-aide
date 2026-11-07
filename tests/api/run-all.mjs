// Runs every TaxAide API suite (tests/api/*.test.mjs) one after another, each in its own
// Node process with this process's environment, and prints a per-suite summary.
// Exits 1 if any suite fails (or crashes / refuses to run), 0 otherwise.
//
// Usage:  node tests/api/run-all.mjs [suite ...]     e.g. `node tests/api/run-all.mjs authz docs`
//         (pnpm --filter @workspace/tests run test:api)
// Env:    the suites' env (TAXAIDE_TEST_RESET_DB=1, API_BASE, PG*, UPLOADS_DIR, TRUST_PROXY, ONLY, ...),
//         plus VERBOSE=1 to stream every PASS line (default: only FAIL / SKIP lines and summaries).
//
// The suites share one database and reset it themselves, so they must not run in parallel.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.env.VERBOSE === "1";

const available = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => f.slice(0, -".test.mjs".length))
  .sort();
const wanted = process.argv.slice(2).map((a) => a.replace(/\.test\.mjs$/, ""));
const unknown = wanted.filter((w) => !available.includes(w));
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(", ")}. Available: ${available.join(", ")}`);
  process.exit(2);
}
const suites = wanted.length ? wanted : available;

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, `${name}.test.mjs`)], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let buffered = "";
    const onData = (chunk) => {
      const s = chunk.toString();
      out += s;
      buffered += s;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (VERBOSE || /^(FAIL|SKIP) /.test(line)) console.log(`  [${name}] ${line}`);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      if (buffered && (VERBOSE || /^(FAIL|SKIP) /.test(buffered))) console.log(`  [${name}] ${buffered}`);
      const m = out.match(/^(\d+) passed, (\d+) failed, (\d+) total(?:, (\d+) skipped)?$/m);
      resolve({
        name,
        code,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : 0,
        skipped: m && m[4] ? Number(m[4]) : 0,
        summary: !!m,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
        tail: out.trim().split("\n").slice(-5).join("\n"),
      });
    });
  });
}

const results = [];
for (const name of suites) {
  console.log(`\n▶ ${name}`);
  const r = await runSuite(name);
  results.push(r);
  if (r.summary) console.log(`  ${r.passed} passed, ${r.failed} failed${r.skipped ? `, ${r.skipped} skipped` : ""} (${r.seconds}s, exit ${r.code})`);
  else console.log(`  no summary line (exit ${r.code}); last output:\n${r.tail.replace(/^/gm, "    ")}`);
}

const ok = (r) => r.code === 0 && r.summary && r.failed === 0;
const width = Math.max(...results.map((r) => r.name.length), 5);
console.log("\n── Summary ─────────────────────────────────────────────");
for (const r of results) {
  const status = ok(r) ? "ok  " : "FAIL";
  const detail = r.summary ? `${String(r.passed).padStart(4)} passed ${String(r.failed).padStart(3)} failed${r.skipped ? ` ${r.skipped} skipped` : ""}` : `exit ${r.code}, no summary`;
  console.log(`${status} ${r.name.padEnd(width)}  ${detail}`);
}
const sum = (k) => results.reduce((n, r) => n + r[k], 0);
console.log(`\nTotal: ${sum("passed")} passed, ${sum("failed")} failed, ${sum("skipped")} skipped across ${results.length} suites`);
const bad = results.filter((r) => !ok(r));
if (bad.length) {
  console.log(`Failed suites: ${bad.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
