<!-- last_verified: 2026-09-09 -->
# Verification

What each gate actually checks, and how to recover when one fails. Read this
when setting up a fresh clone, when `pnpm verify` fails or runs slow, or before
changing the API contract or the Python lock.

The command index lives in
[dev-workflows.md](dev-workflows.md#commands) — this file explains the
mechanics behind those commands.

## Local environments

Supported local development environments are macOS, Linux, and WSL2. Native
Windows is not supported yet because the package scripts use POSIX shell syntax
and `services/api/.venv/bin/*` paths; use WSL2 on Windows.

Run `pnpm run setup` on a fresh clone. It is idempotent: it copies
`.env.example` to `.env` only if `.env` does not already exist (first, because it
is the only step that needs no network), installs workspace dependencies from
`pnpm-lock.yaml`, creates `services/api/.venv` only when missing, validates an
existing venv uses Python 3.12+, and installs the committed Python 3.12
resolution in `services/api/requirements.lock`. It installs Node dependencies
with `--frozen-lockfile`, so run `pnpm install` yourself after editing
`package.json`.

`setup` and `doctor` must always be invoked as `pnpm run setup` / `pnpm run
doctor`. Both are built-in pnpm commands before pnpm 11 (the version CI pins and
the minimum `engines` allows), and the bare `pnpm setup` / `pnpm doctor` forms
run pnpm's own commands — `pnpm setup` silently edits your shell profile instead
of preparing the repo. `predev` and `verify:full` therefore use the `run` form
too, and `pnpm check:agent-docs` asserts it.

Cloud or sandboxed agents need network permission for dependency downloads
during `pnpm run setup`. Dev and E2E runs also need localhost server binding:
Next.js uses port 3000, and the API uses 8000-8009 via `scripts/pick-port.mjs`.
Playwright E2E additionally needs permission to launch its Chromium browser. If
binding is denied by the sandbox, `pnpm run doctor` and `scripts/pick-port.mjs`
report `EPERM`/`EACCES` with a local-server permission fix instead of treating
the port as free or exhausted. A missing IPv6 stack is reported as neither: the
`::`/`::1` probe answers `EAFNOSUPPORT`/`EADDRNOTAVAIL`, which both scripts
ignore so an IPv6-less container still starts. Doctor also probes the two
wildcards one after the other, because a dual-stack `::` bind on Linux collides
with a concurrently held `0.0.0.0` bind and would report a free port as busy.

## Test types
- **Unit**: pure logic (service layer)
- **Integration**: HTTP handlers, B2 connectivity (`tests/`)
- **Structural**: layering rules, import boundaries (`tests/test_structure.py`)
- **Contract**: checked-in OpenAPI artifact and frontend route drift
- **E2E**: Playwright browser-driven smoke tests
- **App verification**: throwaway, app-specific Playwright specs that drive a real browser through a real run

## Test placement
- Backend: `services/api/tests/`
- E2E: `apps/web/e2e/` with config in `apps/web/playwright.config.ts`
- App verification specs: `apps/web/e2e/verify/` (gitignored), sharing the fixtures in `apps/web/e2e/fixtures/`

## App verification specs

`playwright.config.ts` declares two projects over one `e2e/` tree. `chromium`
(`pnpm test:e2e`) is the kit's committed smoke suite. `verify`
(`pnpm test:verify`) runs the throwaway, app-specific specs that a verification
pass writes into `apps/web/e2e/verify/`.

That directory is **gitignored**. Verification specs are evidence for one run,
not part of the app, and a `git add -A` in an app built from this kit must not
be able to sweep one into a commit.

Running them inside the workspace is the point. A standalone script outside it
has to resolve Playwright and its browser by hand, which is where the
`executablePath` / `chrome-headless-shell` class of breakage comes from. As a
project, the browser, the viewport (1440x900), the server launch and the
readiness wait are all configuration — and `reuseExistingServer` means a dev
server you already had running is reused, never killed. The `verify` project
runs single-worker on purpose: these specs drive one dev server and, in a media
app, one set of native workers, and running them in parallel is what produced
truncated screenshots and OOM kills.

### Which server the specs drive

`baseURL` and `webServer.url` come from `WEB_PORT` (or `VERIFY_BASE_URL`
outright), defaulting to `http://127.0.0.1:3000`. That is not tidiness — it is
what keeps a contended machine honest.

A verification pass that finds ports 3000/8000 already held by a human's dev
server for a *different* app boots the app under test on alternate ports rather
than killing what is running. With a pinned base URL, `reuseExistingServer`
would then find the *other* server answering on 3000, skip launching, and every
relative `page.goto()` would drive somebody else's app while reporting findings
about this one. Pass `WEB_PORT` whenever you did not land on 3000.

`127.0.0.1` rather than `localhost`, for the same reason `pnpm wait-ready`
probes both literals: on macOS `localhost` can resolve to `::1` first and miss a
v4-only listener. A server this config launches inherits `PORT`, so it lands on
the port the base URL points at.

Shared fixtures live in `apps/web/e2e/fixtures/` and are imported relatively, so
a spec runs on any machine and in CI:

| Export | What it saves you writing |
|---|---|
| `test` / `diagnostics` | A page already collecting console errors, uncaught page exceptions, failed requests, and 4xx/5xx responses — attached *before* the first navigation, so nothing is missed |
| `waitForTerminal` | The bounded wait every run needs: a deadline, a poll, and a mid-wait screenshot hook so a stalled run still leaves evidence |
| `safeShot` | A screenshot that never fails the run, with an optional `maxHeight` so a tall page does not produce a giant capture |
| `affordances` | An app-agnostic scrape of what a screen offers — headings, in-app links, buttons, inputs, selects, file inputs — answering navigation questions from the DOM instead of from an image |
| `assertMediaPaints` | Proof that an `<img>`/`<video>` actually paints, not merely that it is in the DOM |
| `selectShadcnOption`, `uploadFile`, `waitForStage` | The shadcn/Radix interactions whose selectors are easy to get subtly wrong |
| `noteVerify` | One JSONL line into the run's sidecar, fire-and-forget |

Keep the app-specific half in the spec: the route list, this app's control names
and selectors, the completion predicate, the asset path, and the domain
assertions.

## Pre-commit

The tracked [`.pre-commit-config.yaml`](../.pre-commit-config.yaml) is an
optional local guard for staged changes; CI remains the required enforcement
path. Install the `pre-commit` command with your preferred isolated Python tool
(for example, `pipx install pre-commit`), then enable the hooks so they run
against staged changes on each commit:

```bash
pre-commit install
pre-commit run            # check currently staged files
```

Run `pre-commit validate-config` after editing the configuration. The hooks
include staged-change secret detection, Ruff checks for API files, and small
repository hygiene checks. They do not replace `pnpm verify`. A full-tree
`pre-commit run --all-files` scan is optional: `detect-secrets` ships without a
committed `.secrets.baseline`, so expect it to surface pre-existing high-entropy
strings (for example, the example-key patterns in docs) to triage rather than a
clean pass.

## API Contract

The checked-in FastAPI contract lives at `docs/api/openapi.json`. Refresh it
with `pnpm contract:export` after changing route declarations, response models,
or request models. The exporter imports `services/api/main.py`, calls
`app.openapi()`, and writes sorted, indented JSON so diffs stay deterministic.
Both contract commands run `services/api/.venv/bin/python`, so they need
`pnpm run setup` first.

The comparison is byte-exact. The complete Python 3.12 resolution is committed
in `services/api/requirements.lock`, so routine verification must not fail
merely because FastAPI or Pydantic published a release. If an intentional
dependency refresh changes schema generation, refresh and review the lock and
contract in the same PR as described below.

Run `pnpm contract:check` for a fast API/client drift check. It verifies that
`docs/api/openapi.json` matches the generated FastAPI contract, then runs the
frontend contract test that compares `API_CLIENT_ROUTES` in
`apps/web/src/lib/api-client.ts` against the artifact. `GET /metrics` is the
only current server-only operation; add future backend-only routes to that test
deliberately rather than letting them pass unnoticed.

`pnpm verify` catches the same drift without a separate command: `pnpm test:api`
includes the OpenAPI freshness test, and `pnpm test:web` includes the frontend
route-contract test. This is intentionally a lightweight hand-written workflow;
do not add full OpenAPI codegen until this first contract check proves
insufficient.

Scope: the check covers **routes** (path + verb), not payloads. Response and
request *shapes* — and the hand-written mirrors of the Pydantic models in
`packages/shared/src/types.ts` — are still synced by hand and unverified. See
the tech-debt tracker.

## Python dependency updates

`services/api/requirements.txt` is the human-edited input and
`services/api/requirements.lock` is the complete exact-version Python 3.12
resolution used by setup and CI. Do not edit the lock for routine feature work.

The lock is resolved for CPython 3.12 on Linux/macOS and its pins carry no
environment markers, so Windows is not a supported setup target (for example,
`uvloop` ships no Windows wheels). If Windows support is ever required,
regenerate the lock with a marker-preserving tool such as pip-tools'
`pip-compile` instead of `pip freeze`.

When deliberately adding or updating an API dependency:

1. Edit `services/api/requirements.txt` and use a clean Python 3.12 virtual
   environment outside the repository (for example, under `/tmp`).
2. Install `requirements.txt` in that environment, run `python -m pip freeze`,
   and replace `requirements.lock` with the exact application, test, and quality
   packages. Omit bootstrap tools such as `pip` and `setuptools`.
3. Recreate the repository venv with `pnpm run setup`, run
   `pnpm contract:export`, and review any contract diff. Commit the input, lock,
   and contract together only when the change is intended.
4. Run `pnpm contract:check` and `pnpm verify`. If a contract change is
   unexpected, restore the prior input/lock instead of accepting generated
   OpenAPI churn.

If a fresh clone fails dependency installation, first confirm that
`services/api/requirements.lock` is present and rerun `pnpm run setup`; do not
run an unconstrained install from `requirements.txt` as a recovery shortcut.

## Agent-docs check

`pnpm check:agent-docs` validates the canonical `AGENTS.md` surface, including
its instruction-trust boundary, thin cross-agent shims, command docs, CI claims,
internal Markdown links, and `.env` ignore coverage
(`scripts/check-agent-docs.mjs`, helpers in `scripts/agent-docs/`). It is
dependency-free by design — it runs without `pnpm install`, which is why its CI
job skips the install step. Register every new agent shim there so it can't be
emptied or unlinked from `AGENTS.md` unnoticed (see AGENTS.md §9). A file that
is missing *or* empty fails its own assertion rather than skipping the group it
belongs to.

Two rules about the secret-handling section are worth knowing before editing it:
the rule must read as a prohibition (a sentence naming `.env`, credentials, keys
or a leak surface only counts when the same sentence forbids something), and
[SECURITY.md](SECURITY.md#agent-security-rules) must point at that heading with
an anchored link whose target really exists. Renumbering the section therefore
fails the check — fix the link in the same change rather than leaving a
hyperlink that quietly lands the reader at the top of `AGENTS.md`.

Every *other* relative Markdown link is checked the same way: the target file
must exist, and an `#anchor` must match a real heading in it. This is what makes
moving or splitting a doc safe — GitHub serves a file whose anchor no longer
exists and lands the reader at the top, so a dead anchor otherwise reads as a
working link. External `http`/`mailto` links are never fetched, so the check
stays offline; anchors are slugged the way GitHub does it, including the `--` a
dropped `&` leaves behind.

The `.env` ignore group asks git which repo-tracked `.gitignore` rule matches
each path (global excludes and `.git/info/exclude` don't count). Each path is
asked independently: one that git cannot answer for (say a symlinked
`apps/web/`) is reported as its own `SKIPPED: .env ignore check for <path>
(...)` line while every other path is still checked and can still fail the run.
Only when *no* path is answerable — outside a git work tree, for instance — is
the whole group abandoned with a single `SKIPPED: .env ignore checks (...)`
notice. Skipped checks are never counted as passes and never fail the run.
Example/template env files must stay trackable anywhere in the tree;
`apps/web/.gitignore` overrides the root one for `apps/web/**`, so its negations
live there too.

## Non-live verification

`pnpm verify` is the canonical credential-free non-live gate for PRs. It is composed of
`pnpm check:agent-docs`, then `pnpm verify:api` (backend lint, backend tests,
structural boundary tests), then `pnpm verify:web` (frontend lint, frontend
unit tests, frontend typecheck + build) — so the agent-doc guard runs first and
CI can run all three checks as parallel jobs. `package.json` is the single
source of truth for the literal command chain; when it changes, update the
plain-language list here and in `AGENTS.md` §6 (see
[Documentation Update](dev-workflows.md#documentation-update)), not a duplicated
shell chain.

Normal API tests deny socket connections and mock the B2 boundary in `/health`,
so a populated developer `.env` cannot turn this gate into a live service test.
To intentionally validate real connectivity with approved non-production
credentials, run `RUN_LIVE_B2_TESTS=1 pnpm test:live:b2`. Without that explicit
flag the live test skips, and it is never part of `pnpm verify` or CI.

The commands are deliberately composable: use the smaller commands while
iterating, `pnpm verify` as the usual PR gate, and `pnpm verify:full` only when
the live local prerequisites are available.

```text
pnpm verify:full
├─ pnpm run doctor
├─ pnpm verify
│  ├─ pnpm check:agent-docs
│  ├─ pnpm verify:api
│  │  ├─ pnpm lint:api
│  │  ├─ pnpm test:api
│  │  └─ pnpm check:structure
│  └─ pnpm verify:web
│     ├─ pnpm lint
│     ├─ pnpm test:web
│     └─ pnpm build
└─ pnpm test:e2e
```

One checkout supports one active `pnpm verify`: concurrent Next.js builds
contend for `apps/web/.next/lock`. For parallel agents, give each run its own
Git worktree checked out at the commit it needs to verify, then run setup and
verification inside that worktree:

```bash
git worktree add <path> <target-commit>   # e.g. HEAD to verify your current branch
cd <path>
pnpm run setup
pnpm verify
git worktree remove <path>                 # remove the worktree when done
```

This is also the recovery path for shared-checkout contention. If a terminated
run leaves `.next/lock`, first confirm no `next build` or `pnpm verify` process
is active, remove only `apps/web/.next/lock`, then rerun `pnpm verify` (or move
the work to a separate worktree). Do not delete the whole `.next` directory as
routine recovery.

On a warm development machine, plan for about 30 seconds for `pnpm verify`.
The first run after setup or a dependency/cache change can take longer. If an
unchanged warm checkout takes more than two minutes, rerun `pnpm verify` once;
if it remains slow, run `pnpm verify:api` and `pnpm verify:web` separately
(not concurrently in the same checkout) to locate the slow half. Do not switch
to `pnpm verify:full` as a recovery step: it is a separate live workflow.

`pnpm verify:full` runs `pnpm run doctor` first (it fails fast on a missing venv,
missing `.env`, or placeholder credentials, before the long suite starts), then
`pnpm verify`, then `pnpm test:e2e`. Use it when live local prerequisites are
available:

- root `.env` contains real B2 credentials
- the backend virtualenv `services/api/.venv` exists
- local server binding is permitted
- port 3000 is free, or already serving this app
- Playwright Chromium has been installed

This live E2E behavior is intentionally separate from `pnpm verify`: the
non-live gate neither starts a server nor allocates a port. Playwright starts
`pnpm dev` from `apps/web/playwright.config.ts` and waits on
`http://localhost:3000`. Note that `next dev` falls back to the next free port
when 3000 is taken, so an unrelated process on 3000 makes `pnpm test:e2e` time
out waiting on a URL the app never claimed — `pnpm run doctor` warns about this
but does not fail. The API starts at `localhost:8000` or the next free port chosen
by `scripts/dev.sh`.

`e2e/**` and `playwright.config.ts` are excluded from `apps/web/tsconfig.json`,
so no gate in `pnpm verify` typechecks them; type errors there only surface
when `pnpm test:e2e` runs.

## When to run
- After behavior change: run relevant subset
- Before PR: run `pnpm verify`
- Before PRs that affect browser flows or live-service behavior: run
  `pnpm verify:full` when the prerequisites above are available

## Continuous Integration
- `.github/workflows/ci.yml` runs `pnpm check:agent-docs` plus the two halves
  of `pnpm verify` — `pnpm verify:api` and `pnpm verify:web` — as parallel jobs
  on every PR and push to `main`. Same gates as running `pnpm verify` locally,
  but they report independently, so a frontend failure never hides a backend
  failure.
- No secrets required — backend tests deny socket access and mock the B2 repo
  layer, including explicit healthy/degraded `/health` cases. `pnpm verify:full`
  and E2E are not in CI
  because they need a running app, browser install, and live B2 credentials.
- The workflow declares `permissions: contents: read` at the top level, so
  `GITHUB_TOKEN` is read-only for every job. Keep it that way; if a new job
  genuinely needs to write (publish annotations, comment on a PR), add a
  narrower job-level `permissions` block rather than widening the top-level
  one. See [SECURITY.md](SECURITY.md#ci-permissions).
