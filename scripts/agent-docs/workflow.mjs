/**
 * Verify-gate claims for `scripts/check-agent-docs.mjs`.
 *
 * Three surfaces declare the gates: `package.json` composes them,
 * `.github/workflows/ci.yml` runs them, and the command docs name them. This
 * module reads all three and returns ready-to-report pass/failure lines, like
 * `./env-ignore.mjs` does.
 *
 * The ci.yml reader is deliberately not a YAML parser (the checker must stay
 * dependency-free). It extracts only what the CI-claims check needs: the
 * commands CI actually runs and the job keys it declares. Comment lines are
 * stripped first, so ci.yml's own header comment can no longer satisfy a
 * "CI runs X" assertion.
 */

/** `run: <cmd>` inline form, or a `run: |` / `run: >` block scalar. */
const RUN_KEY = /^(\s*(?:-\s+)?)run:\s*(.*)$/;

/**
 * `|` or `>`, plus optional chomping (`-`/`+`) and indentation indicators, and
 * an optional trailing comment. The style is captured because it decides the
 * join: YAML folds `>` newlines into spaces and keeps `|` newlines, so joining
 * both with "\n" false-failed a perfectly valid folded `run: >-` step.
 */
const BLOCK_SCALAR = /^([|>])[\d+-]*(?:\s+#.*)?$/;

/** `jobs:`, tolerating trailing whitespace and a trailing comment. */
const JOBS_KEY = /^jobs:[ \t]*(?:#.*)?$/;

/** Gates each package.json script must still compose. Adding one is fine.
 *  `pnpm run doctor`, not `pnpm doctor`: `doctor` and `setup` are built-in pnpm
 *  commands before pnpm 11, and the bare forms run those instead of our
 *  scripts. */
const PACKAGE_GATES = {
  verify: ["pnpm check:agent-docs", "pnpm verify:api", "pnpm verify:web"],
  "verify:api": ["pnpm lint:api", "pnpm test:api", "pnpm check:structure"],
  "verify:web": ["pnpm lint", "pnpm test:web", "pnpm build"],
  "verify:full": ["pnpm run doctor", "pnpm verify", "pnpm test:e2e"],
};

const CI_COMMANDS = [
  "pnpm check:agent-docs",
  "pnpm verify:api",
  "pnpm verify:web",
];

const CI_JOBS = ["verify-agent-docs", "verify-api", "verify-web"];

/** Commands every command-doc surface must name. Presence only: the literal
 *  chain lives in package.json and must not be pasted into docs. */
const DOCUMENTED_COMMANDS = [
  "pnpm run setup",
  "pnpm check:agent-docs",
  "pnpm wait-ready",
  "pnpm contract:export",
  "pnpm contract:check",
  "pnpm verify",
  "pnpm verify:api",
  "pnpm verify:web",
  "pnpm verify:full",
];

/** Scripts that must keep pointing at the file the docs send readers to. */
const SCRIPT_ENTRY_POINTS = {
  "check:agent-docs": "scripts/check-agent-docs.mjs",
  setup: "scripts/setup.mjs",
  doctor: "scripts/doctor.mjs",
  "wait-ready": "scripts/wait-ready.mjs",
};

/** Whole-token match, so `pnpm verify` never matches `pnpm verify:api`. */
function hasCommand(text, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9:_-])${escaped}(?=$|[^A-Za-z0-9:_-])`).test(
    text ?? "",
  );
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function readBlockScalar(lines, startIndex, keyIndent, folded) {
  const block = [];

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim() === "") {
      continue;
    }

    if (indentOf(line) <= keyIndent) {
      break;
    }

    block.push(line.trim());
  }

  // `>` folds newlines to spaces; `|` keeps them. Getting this wrong split a
  // one-line command across two lines and failed the "CI runs X" assertion.
  return block.join(folded ? " " : "\n");
}

function readJobKeys(lines, startIndex) {
  const jobs = [];
  let jobIndent = null;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim() === "") {
      continue;
    }

    const indent = indentOf(line);

    if (indent === 0) {
      break;
    }

    jobIndent ??= indent;

    const key = /^\s+([A-Za-z0-9_.-]+):/.exec(line);

    if (indent === jobIndent && key) {
      jobs.push(key[1]);
    }
  }

  return jobs;
}

/**
 * @returns {{runSteps: string[], jobs: string[]}} `runSteps` holds the text of
 * every real `run:` step; `jobs` holds the top-level keys under `jobs:`.
 */
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
  const runSteps = [];
  let jobs = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const runKey = RUN_KEY.exec(line);

    if (runKey) {
      const value = runKey[2].trim();
      const blockScalar = BLOCK_SCALAR.exec(value);

      if (blockScalar) {
        runSteps.push(
          readBlockScalar(
            lines,
            index + 1,
            runKey[1].length,
            blockScalar[1] === ">",
          ),
        );
      } else if (value) {
        runSteps.push(value.replace(/^["']|["']$/g, ""));
      }

      continue;
    }

    if (JOBS_KEY.test(line)) {
      jobs = readJobKeys(lines, index + 1);
    }
  }

  return { runSteps, jobs };
}

/**
 * Asserts the gates package.json composes, the gates ci.yml runs, and that
 * every command-doc surface names them.
 *
 * The *set of gates* is what is asserted, not a literal chain: package.json is
 * the single source of truth for the chain, so adding a gate must not fail the
 * check while dropping one must.
 *
 * @param {string|null} packageJsonText raw package.json, or null if unreadable
 * @param {string|null} ciText raw ci.yml, or null if unreadable
 * @param {Record<string, string|null>} docSurfaces doc path -> contents
 * @returns {{passes: string[], failures: string[]}}
 */
export function checkGateClaims(packageJsonText, ciText, docSurfaces) {
  const passes = [];
  const failures = [];
  let packageJson = null;

  const record = (ok, message, detail) => {
    if (ok) {
      passes.push(message);
      return;
    }

    failures.push(`${message} — ${detail}`);
  };

  if (packageJsonText) {
    try {
      packageJson = JSON.parse(packageJsonText);
      passes.push("package.json is valid JSON");
    } catch (error) {
      failures.push(
        `package.json is valid JSON — parse failed: ${error.message}`,
      );
    }
  }

  if (packageJson) {
    const scripts = packageJson.scripts ?? {};

    for (const [scriptName, entryPoint] of Object.entries(SCRIPT_ENTRY_POINTS)) {
      record(
        (scripts[scriptName] ?? "").includes(entryPoint),
        `package.json script ${scriptName} runs ${entryPoint}`,
        `expected a reference to ${entryPoint}, actual: ${JSON.stringify(scripts[scriptName] ?? null)}`,
      );
    }

    for (const [scriptName, gates] of Object.entries(PACKAGE_GATES)) {
      const command = scripts[scriptName] ?? "";

      for (const gate of gates) {
        record(
          hasCommand(command, gate),
          `package.json script ${scriptName} composes ${gate}`,
          `expected ${scriptName} to run ${gate}, actual: ${JSON.stringify(command || null)}`,
        );
      }
    }
  }

  if (ciText) {
    const { runSteps, jobs } = parseWorkflow(ciText);

    for (const command of CI_COMMANDS) {
      record(
        runSteps.some((step) => hasCommand(step, command)),
        `.github/workflows/ci.yml runs ${command} in a run step`,
        `expected a \`run:\` step invoking ${command}, actual run steps: ${JSON.stringify(runSteps)}`,
      );
    }

    for (const job of CI_JOBS) {
      record(
        jobs.includes(job),
        `.github/workflows/ci.yml declares job ${job}`,
        `expected job key ${job} under jobs:, actual job keys: ${JSON.stringify(jobs)}`,
      );
    }
  }

  for (const [surfacePath, surfaceText] of Object.entries(docSurfaces)) {
    for (const command of DOCUMENTED_COMMANDS) {
      record(
        hasCommand(surfaceText, command),
        `${surfacePath} documents ${command}`,
        `expected ${surfacePath} to mention \`${command}\`, actual: not found`,
      );
    }
  }

  return { passes, failures };
}
