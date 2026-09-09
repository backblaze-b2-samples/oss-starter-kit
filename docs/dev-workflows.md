<!-- last_verified: 2026-09-09 -->
# Dev Workflows

Engineering workflows for this repo: the command index, the per-task checklists,
and the release process. Two companion docs carry the reference material:

| Read that instead when | Doc |
|---|---|
| A gate failed, or you need what a command actually checks | [verification.md](verification.md) |
| You're building or restyling a screen, or wiring data fetching | [frontend-conventions.md](frontend-conventions.md) |

## Commands
- Agent docs health: `pnpm check:agent-docs`
- Cold-start setup: `pnpm run setup`
- Preflight environment check: `pnpm run doctor`
- Wait for the running stack: `pnpm wait-ready`
- API contract export: `pnpm contract:export`
- API contract drift check: `pnpm contract:check`
- Canonical pre-PR suite: `pnpm verify`
- Backend half only: `pnpm verify:api`
- Frontend half only: `pnpm verify:web`
- Full local suite: `pnpm verify:full`
- Quick (backend): `pnpm test:api`
- Frontend unit: `pnpm test:web` (vitest, excludes e2e)
- Structure: `pnpm check:structure`
- Frontend typecheck: `pnpm typecheck`
- Frontend lint: `pnpm lint`
- Backend lint: `pnpm lint:api`
- E2E: `pnpm test:e2e` (run `pnpm --filter @vibe-coding-starter-kit/web exec playwright install chromium` once first)

What each gate checks, its prerequisites, and how to recover when one fails:
[verification.md](verification.md).

## New Feature

- [ ] Read `AGENTS.md` and `ARCHITECTURE.md`
- [ ] Read the relevant feature doc in `docs/features/`
- [ ] For non-trivial changes, create a plan in `docs/exec-plans/active/`
- [ ] Implement the smallest coherent change
- [ ] Add or update tests
- [ ] Run: `pnpm verify`
- [ ] Update docs in the same PR (see AGENTS.md §9)
- [ ] Move plan to `docs/exec-plans/completed/` after validation

## Bugfix

- [ ] Add a failing test that reproduces the bug
- [ ] Confirm the test fails
- [ ] Implement the fix
- [ ] Rerun tests until green
- [ ] Update docs if behavior changed

## Refactor

- [ ] Read `ARCHITECTURE.md` — respect layering rules
- [ ] Ensure structural tests still pass: `pnpm check:structure`
- [ ] No behavior changes without updating feature docs

## Documentation Update

- [ ] Update only the canonical location (see AGENTS.md §9 doc update mapping)
- [ ] Never duplicate content — link instead
- [ ] Update `<!-- last_verified: YYYY-MM-DD -->` header

## Pull Request

- [ ] One coherent change per PR
- [ ] Run `pnpm verify` before submitting
- [ ] Docs updated in the same PR as code changes
- [ ] Only change files relevant to the task — no drive-by improvements

GitHub surfaces this contract automatically through two templates, so reviewers
see it without opening this file:

- `.github/PULL_REQUEST_TEMPLATE.md` — prefills every PR with scope, a
  verification table, skipped-check explanations, UI evidence, docs, and
  risk/rollback.
- `.github/ISSUE_TEMPLATE/coding-agent-handoff.md` — prefills a scoped
  implementation request with the context a coding agent needs.

The templates are prompts for evidence, not a second rulebook: the rules live in
`AGENTS.md` and in this file. Keep them thin and link back here rather than
restating a rule in template prose, where it would be copied verbatim into every
future issue and PR body and could never be corrected retroactively.

### Review ownership

This starter kit has no `CODEOWNERS` file, so GitHub assigns no reviewer
automatically — request one manually. This is the canonical statement of that
status: if `CODEOWNERS` is ever added, update this section, and the templates
that point here stay correct without edits.

## Releases and versioning

Tags follow SemVer (`vMAJOR.MINOR.PATCH`) and mark the states external
documentation points at. A release aggregates many PRs — nothing is versioned
per-PR, and `main` between releases carries no compatibility promise.

The versioned surface is what someone building on this repo actually depends on:
the HTTP API, environment variables, `pnpm` commands, the runtime baseline, the
required setup steps, and the starter contract in [AGENTS.md](../AGENTS.md) §2.

| Bump | The range since the last tag contains |
|------|---------------------------------------|
| **major** | a removed or renamed HTTP route, or a changed request/response shape; a renamed, removed, or newly required env var; a raised minimum runtime (Node, Python, pnpm); a new mandatory setup or deploy step; a renamed or removed `pnpm` command the docs name; a moved or deleted starter-contract piece |
| **minor** | anything purely additive — a new feature, route, optional env var, command, or check |
| **patch** | docs, CI, refactors, and fixes that leave every surface above unchanged |

Highest match wins: one breaking change anywhere in the range makes the whole
release a major.

Cut a release when external documentation is about to be written or refreshed,
and when a breaking change has landed. Classify by reading the range, not the
commit prefixes — a breaking change can land under a `feat:` or `fix:` message:

```bash
git log --oneline <last-tag>..main   # classify against the table above
git tag v1.1.0 && git push origin v1.1.0
gh release create v1.1.0 --generate-notes
```

Auto-generated notes list the PR titles in the range, which is why this repo
keeps no `CHANGELOG.md`. External documentation should name the tag it was
written against and link to it (`.../tree/v1.0.0`), so the code a reader follows
stays fixed even as `main` moves on.
