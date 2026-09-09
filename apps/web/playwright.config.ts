import { defineConfig, devices } from "@playwright/test";

/**
 * Two projects over one `e2e/` tree.
 *
 * `chromium` is the kit's own committed smoke suite. `verify` is for the
 * throwaway, app-specific specs a verification pass writes into
 * `e2e/verify/` — a gitignored directory, so those specs can never be swept
 * into a commit by a `git add -A`.
 *
 * Verification specs run inside the pnpm workspace on purpose. Driving the app
 * from a standalone script outside the workspace means resolving Playwright and
 * its browser by hand, which is where the `executablePath` /
 * `chrome-headless-shell` class of breakage comes from. Here the browser, the
 * viewport, the server launch and the readiness wait are all configuration.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // `list` so a run is readable in a terminal or an agent transcript; the HTML
  // report is still written but never auto-served — `open: "never"` is what stops
  // a headless run blocking on a report server nobody is there to close.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "verify/**",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Verification specs are sequential: they drive one dev server and, in a
      // media app, one set of native workers. Running them in parallel is what
      // produced truncated screenshots and OOM kills.
      name: "verify",
      testMatch: "verify/**/*.spec.ts",
      fullyParallel: false,
      workers: 1,
      retries: 0,
      timeout: 300_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    // Never kill a dev server a human already had running; start one only when
    // there is none. `pnpm wait-ready` is the equivalent outside this runner.
    reuseExistingServer: !process.env.CI,
    cwd: "../../",
    // A cold Next.js compile plus the API venv boot regularly exceeds
    // Playwright's 60s default, and that timeout reads as "the app is broken".
    timeout: 180_000,
  },
});
