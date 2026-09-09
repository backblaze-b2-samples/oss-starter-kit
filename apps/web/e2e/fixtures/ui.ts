/**
 * App-agnostic Playwright helpers for browser-driven verification.
 *
 * These exist because verification scripts kept re-deriving brittle selectors
 * and hand-rolling the same waits. Everything here is deliberately app-neutral:
 * the route list, the control names, the completion predicate and the domain
 * assertions belong in the spec that uses these, not in here.
 *
 * Import from a spec as:
 *   import { test, expect, waitForTerminal, safeShot } from "../fixtures/verify";
 *
 * Relative, workspace-internal imports only — an absolute path into one
 * machine's home directory does not run on anyone else's machine or in CI.
 */
import type { Locator, Page } from "@playwright/test";

export const DEFAULT_TIMEOUT = 30_000;

/**
 * Selectors that identify a shadcn/ui <Select> trigger, in preference order.
 * `role="combobox"` is what the underlying Radix trigger button ALWAYS exposes,
 * so it is the primary. `data-slot="select-trigger"` is only a secondary: a
 * wrapping shadcn <FormControl> overrides data-slot to "form-control", so on any
 * Select inside a form the data-slot selector matches ZERO elements — and a
 * script that trusted it silently kept the default option while reporting the
 * option as honored. It stays as a fallback for a custom trigger that renders no
 * combobox role.
 */
const SELECT_TRIGGERS = ['[role="combobox"]', '[data-slot="select-trigger"]'];

/**
 * Open a shadcn/ui <Select> and pick an option by visible text; options render
 * in a portal as `[role="option"]`. The trigger is resolved from
 * SELECT_TRIGGERS — the first selector that matches anything wins. Pass
 * `triggerSelector` to disambiguate multiple Selects on one screen; it overrides
 * the resolution entirely (`':nth-match([role="combobox"], 2)'` for the Nth
 * Select on a form, `'[role="combobox"]:near(:text("Aspect"))'` to anchor on a
 * label). Throws when no trigger matches, rather than silently leaving the
 * default selected.
 */
export async function selectShadcnOption(
  page: Page,
  optionText: string,
  { triggerSelector, timeout = DEFAULT_TIMEOUT }: { triggerSelector?: string; timeout?: number } = {},
): Promise<void> {
  const candidates = triggerSelector ? [triggerSelector] : SELECT_TRIGGERS;
  let trigger: Locator | null = null;

  for (const selector of candidates) {
    const candidate = page.locator(selector).first();
    if (await candidate.count()) {
      trigger = candidate;
      break;
    }
  }

  if (!trigger) {
    throw new Error(
      `selectShadcnOption(${optionText}): no Select trigger matched ${candidates.join(" | ")} — ` +
        "pass triggerSelector for this app's trigger markup",
    );
  }

  await trigger.click({ timeout });
  await page.getByRole("option", { name: optionText, exact: false }).first().click({ timeout });
}

/** Set a file input directly — works even when it is hidden behind a styled dropzone. */
export async function uploadFile(
  page: Page,
  absFilePath: string,
  { inputSelector = 'input[type="file"]', timeout = DEFAULT_TIMEOUT } = {},
): Promise<void> {
  await page.locator(inputSelector).first().setInputFiles(absFilePath, { timeout });
}

/** Wait for an on-screen stage/status string (e.g. "Transcribing audio", "Done"). */
export async function waitForStage(
  page: Page,
  text: string,
  { timeout = DEFAULT_TIMEOUT } = {},
): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
}

export type WaitForTerminalOptions = {
  /** Resolves true once the run has reached a terminal state (done, failed, empty). */
  done: (page: Page) => Promise<boolean> | boolean;
  /** Hard ceiling for the whole wait. */
  deadlineMs?: number;
  /** How often `done` is polled. */
  pollMs?: number;
  /** Called on each poll that did not finish — the usual use is a mid-wait screenshot. */
  onMidWait?: (elapsedMs: number) => Promise<void> | void;
  /** How often `onMidWait` fires, independent of the poll interval. */
  midWaitEveryMs?: number;
  /** Names the wait in the timeout error, so a failure says which stage stalled. */
  label?: string;
};

/**
 * Poll until a run reaches a terminal state, capturing evidence along the way.
 *
 * Nearly every verification script hand-rolls this loop — a bounded wait, a
 * deadline, and a mid-wait screenshot so a run that never finishes still leaves
 * evidence of where it stalled. `done` is the only app-specific part.
 *
 * A thrown `done` is treated as "not yet": mid-run the DOM is routinely in a
 * state where the predicate's own selectors do not resolve, and failing the
 * whole wait on that turns a transient into a false negative. The last error is
 * reported if the deadline is reached, so a permanently broken predicate is
 * still diagnosable rather than silently timing out.
 */
export async function waitForTerminal(
  page: Page,
  {
    done,
    deadlineMs = 120_000,
    pollMs = 1_000,
    onMidWait,
    midWaitEveryMs = 15_000,
    label = "run",
  }: WaitForTerminalOptions,
): Promise<{ elapsedMs: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  let nextMidWait = startedAt + midWaitEveryMs;
  let lastError: unknown = null;

  for (;;) {
    let finished = false;
    try {
      finished = await done(page);
    } catch (error) {
      lastError = error;
      finished = false;
    }

    if (finished) return { elapsedMs: Date.now() - startedAt };

    const now = Date.now();
    if (now >= deadline) {
      const because =
        lastError instanceof Error ? ` — last predicate error: ${lastError.message}` : "";
      throw new Error(
        `waitForTerminal(${label}): no terminal state after ${Math.round((now - startedAt) / 1000)}s${because}`,
      );
    }

    if (onMidWait && now >= nextMidWait) {
      nextMidWait = now + midWaitEveryMs;
      // Evidence capture must never be the thing that fails the wait.
      try {
        await onMidWait(now - startedAt);
      } catch {
        /* best-effort */
      }
    }

    await page.waitForTimeout(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

export type ShotOptions = {
  /** Directory the PNG lands in — normally the app's gitignored `.local/verify/<lens>/`. */
  outDir: string;
  fullPage?: boolean;
  /** Cap a tall fullPage capture. A 1440x3600 screenshot costs real tokens to read back. */
  maxHeight?: number;
};

/**
 * Screenshot that never throws.
 *
 * A capture failing (the page navigated mid-shot, the element detached) must not
 * fail the verification it was only documenting. Returns the path written, or
 * null when the capture did not happen.
 */
export async function safeShot(
  page: Page,
  name: string,
  { outDir, fullPage = true, maxHeight }: ShotOptions,
): Promise<string | null> {
  if (!outDir) throw new Error("safeShot(): outDir is required");
  const path = `${outDir.replace(/\/$/, "")}/${name.replace(/\.png$/, "")}.png`;

  try {
    if (fullPage && maxHeight) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      const width = page.viewportSize()?.width ?? 1440;
      await page.screenshot({
        path,
        clip: { x: 0, y: 0, width, height: Math.min(height, maxHeight) },
      });
    } else {
      await page.screenshot({ path, fullPage });
    }
    return path;
  } catch {
    return null;
  }
}

export type Affordances = {
  url: string;
  title: string;
  headings: string[];
  navLinks: { text: string; href: string }[];
  buttons: string[];
  inputs: { type: string; name: string; placeholder: string; required: boolean }[];
  selects: string[];
  hasFileInput: boolean;
};

/**
 * Scrape what a screen actually offers the user, with no app-specific knowledge.
 *
 * A navigation/affordance pass needs this on every screen it visits, and reading
 * it out of the DOM is both cheaper and more precise than reading a screenshot
 * back into context and describing it.
 *
 * Text is trimmed and collapsed, and hidden elements are skipped — an invisible
 * control is not an affordance, and counting one is how a "the button is there"
 * claim ends up wrong.
 */
export async function affordances(page: Page): Promise<Affordances> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const all = <T extends Element>(selector: string) =>
      Array.from(document.querySelectorAll<T>(selector)).filter(visible);

    return {
      url: window.location.pathname + window.location.search,
      title: clean(document.title),
      headings: all<HTMLElement>("h1, h2, h3").map((h) => clean(h.textContent)).filter(Boolean),
      // Every in-app link, not just the ones inside a <nav>. The shadcn sidebar
      // is a <div>, so anchoring on nav/aside/role=navigation found exactly one
      // link on a screen that offers five. Same-origin hrefs only: an outbound
      // link is not an affordance of this app. Deduped by href, first text wins.
      navLinks: Object.values(
        all<HTMLAnchorElement>("a[href]")
          .filter((a) => {
            const href = a.getAttribute("href") ?? "";
            return href.startsWith("/") && !href.startsWith("//");
          })
          .reduce<Record<string, { text: string; href: string }>>((seen, a) => {
            const href = a.getAttribute("href") ?? "";
            if (!(href in seen)) seen[href] = { text: clean(a.textContent), href };
            return seen;
          }, {}),
      ),
      buttons: all<HTMLElement>("button, [role='button'], a[role='button']")
        .map((b) => clean(b.textContent) || clean(b.getAttribute("aria-label")))
        .filter(Boolean),
      inputs: all<HTMLInputElement | HTMLTextAreaElement>("input, textarea").map((i) => ({
        type: (i as HTMLInputElement).type ?? "textarea",
        name: i.getAttribute("name") ?? "",
        placeholder: i.getAttribute("placeholder") ?? "",
        required: i.hasAttribute("required"),
      })),
      selects: all<HTMLElement>("[role='combobox'], select")
        .map((s) => clean(s.textContent) || clean(s.getAttribute("aria-label")))
        .filter(Boolean),
      hasFileInput: document.querySelector('input[type="file"]') !== null,
    };
  });
}

type MediaPaintResult = {
  ok: boolean;
  kind: string;
  timedOut?: boolean;
  [key: string]: unknown;
};

/**
 * Assert a media element actually PAINTS, not just that it exists in the DOM —
 * the recurring failure is a <video>/<img> output that renders blank, especially
 * in list/library/gallery surfaces. Call once per surface that shows the output
 * (the collection view AND the detail view).
 *
 *   <img>   -> naturalWidth > 0
 *   <video> -> paintable within the timeout, satisfied by ANY of:
 *                - readyState >= 2 (HAVE_CURRENT_DATA — a decoded frame), or a
 *                  'loadeddata'/'canplay' event firing while we poll
 *                - videoWidth > 0 (first frame decoded; true even when the video
 *                  is paused with preload="none"|"metadata" and no poster)
 *                - a poster image that loads (own bounded timeout)
 *
 * Polling tolerates a legitimately paused / lazily-preloaded video that sits at
 * readyState 0-1 at the instant we first look, instead of reporting a false
 * "did not paint". Prefer this over reading a screenshot back: it answers the
 * same question from the DOM at zero image cost.
 */
export async function assertMediaPaints(
  page: Page,
  selector: string,
  { timeout = DEFAULT_TIMEOUT } = {},
): Promise<MediaPaintResult> {
  const element = page.locator(selector).first();
  await element.waitFor({ state: "visible", timeout });

  // Cap the in-browser poll just under the Playwright evaluate budget so OUR
  // descriptive error wins over Playwright's generic evaluate-timeout error.
  const innerTimeout = Math.max(1_000, timeout - 1_000);

  const result = (await element.evaluate(async (node: Element, budgetMs: number) => {
    if (node.tagName === "IMG") {
      const img = node as HTMLImageElement;
      return { ok: img.naturalWidth > 0, kind: "img", naturalWidth: img.naturalWidth };
    }

    if (node.tagName === "VIDEO") {
      const video = node as HTMLVideoElement;
      const POSTER_TIMEOUT = Math.min(5_000, budgetMs);
      // A decoded frame: readyState >= 2 OR a first frame whose pixels exist
      // (videoWidth > 0 holds for a paused video showing its first frame).
      const isPainted = () => video.readyState >= 2 || video.videoWidth > 0;

      const waitForFrame = new Promise<boolean>((resolve) => {
        if (isPainted()) return resolve(true);
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          video.removeEventListener("loadeddata", onEvent);
          video.removeEventListener("canplay", onEvent);
          clearInterval(poll);
          clearTimeout(deadline);
          resolve(value);
        };
        const onEvent = () => {
          if (isPainted()) finish(true);
        };
        video.addEventListener("loadeddata", onEvent);
        video.addEventListener("canplay", onEvent);
        const poll = setInterval(() => {
          if (isPainted()) finish(true);
        }, 100);
        const deadline = setTimeout(() => finish(false), budgetMs);
      });

      // Poster loads on its own bounded timeout (no hang on a slow URL).
      const waitForPoster = video.poster
        ? new Promise<boolean>((resolve) => {
            const probe = new Image();
            let settled = false;
            const settle = (value: boolean) => {
              if (!settled) {
                settled = true;
                resolve(value);
              }
            };
            probe.onload = () => settle(probe.naturalWidth > 0);
            probe.onerror = () => settle(false);
            setTimeout(() => settle(false), POSTER_TIMEOUT);
            probe.src = video.poster;
          })
        : Promise.resolve(false);

      const [hasFrame, posterOk] = await Promise.all([waitForFrame, waitForPoster]);
      return {
        ok: hasFrame || posterOk,
        kind: "video",
        hasFrame,
        posterOk,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        timedOut: !hasFrame && !posterOk,
      };
    }

    return { ok: false, kind: node.tagName };
  }, innerTimeout)) as MediaPaintResult;

  if (!result.ok) {
    const suffix = result.timedOut
      ? ` — timed out after ${timeout}ms waiting for a paintable frame`
      : "";
    throw new Error(
      `assertMediaPaints(${selector}): media did not paint${suffix} — ${JSON.stringify(result)}`,
    );
  }

  return result;
}
