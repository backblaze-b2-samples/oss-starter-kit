/**
 * The verification fixture: one import that gives a spec a page which is already
 * watching itself.
 *
 * Collecting console errors and failed requests is something almost every
 * browser-driven verification script ends up doing by hand, and doing it by hand
 * means each one starts listening at a slightly different moment — usually after
 * the first navigation, which is exactly when the interesting errors fire. As a
 * fixture the listeners are attached before the spec gets the page, so nothing
 * is missed.
 *
 * Usage:
 *   import { test, expect, diagnosticsSummary } from "../fixtures/verify";
 *
 *   test("upload produces a playable result", async ({ page, diagnostics }) => {
 *     await page.goto("/upload");
 *     // ... drive the app ...
 *     expect(diagnosticsSummary(diagnostics)).toBe("clean");
 *   });
 */
import { test as base, expect } from "@playwright/test";
import { appendFileSync } from "node:fs";

export type Diagnostics = {
  /** console.error() output and uncaught page exceptions, in order. */
  consoleErrors: string[];
  /** Requests the browser could not complete at all (DNS, refused, aborted). */
  failedRequests: string[];
  /** Responses that arrived with a 4xx/5xx status. */
  badResponses: string[];
};

export type VerifyFixtures = {
  diagnostics: Diagnostics;
};

export const test = base.extend<VerifyFixtures>({
  diagnostics: async ({ page }, use) => {
    const diagnostics: Diagnostics = {
      consoleErrors: [],
      failedRequests: [],
      badResponses: [],
    };

    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
    });
    // A React render crash surfaces here, not on the console channel.
    page.on("pageerror", (error) => {
      diagnostics.consoleErrors.push(`pageerror: ${error.message}`);
    });
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "failed";
      diagnostics.failedRequests.push(`${request.method()} ${request.url()} — ${reason}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        diagnostics.badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      }
    });

    await use(diagnostics);
  },
});

export { expect };

/**
 * One-line verdict over collected diagnostics, so an assertion failure names
 * what actually went wrong instead of printing "expected 0, got 3".
 */
export function diagnosticsSummary(diagnostics: Diagnostics): string {
  const problems = [
    ...diagnostics.consoleErrors.map((entry) => `console: ${entry}`),
    ...diagnostics.failedRequests.map((entry) => `request-failed: ${entry}`),
    ...diagnostics.badResponses.map((entry) => `http: ${entry}`),
  ];
  return problems.length === 0 ? "clean" : problems.join("\n");
}

/**
 * Append one JSONL line to the run's shared verify sidecar
 * (`<verifyDir>/frame-notes.jsonl`), so whatever assembles the run's report gets
 * authoritative per-frame captions and per-run outcomes instead of guessing from
 * filenames.
 *
 * `verifyDir` is the app's gitignored `.local/verify/` directory — the PARENT of
 * this spec's shot dir. Pass ONE shape:
 *   frame: { shot, status, caption, note }
 *          shot    "<lens>/<file>.png", the tail after .local/verify/
 *          status  ok | error | diagnostic | internal
 *          caption <=5-word sentence-case phrase naming the action or state
 *          note    ONLY for error/diagnostic — one sentence on why it is flagged
 *   run:   { run, scenario, result }
 *          result  pass | fail | mixed | blocked, and ONLY when actually known
 *
 * Fire-and-forget: it swallows its own errors, because a sidecar write must
 * never be the thing that fails a verification run.
 */
export function noteVerify(verifyDir: string, entry: Record<string, unknown>): void {
  if (!verifyDir || !entry) return;
  try {
    appendFileSync(`${verifyDir.replace(/\/$/, "")}/frame-notes.jsonl`, `${JSON.stringify(entry)}\n`);
  } catch {
    /* best-effort: the report falls back to filename and finding heuristics */
  }
}

export * from "./ui";
