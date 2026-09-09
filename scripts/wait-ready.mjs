#!/usr/bin/env node
/**
 * Block until the local stack answers, then print one line and exit.
 *
 * Replaces the `sleep`/`lsof`/`curl` polling loops that verification drivers
 * and agents hand-roll. A fixed sleep is both slower than it needs to be and
 * wrong when a cold Next.js compile runs long; waiting on a real response is
 * strictly more reliable.
 *
 * Zero dependencies on purpose (node: builtins only), same rule as
 * scripts/check-agent-docs.mjs: it must run in any copy of this kit, before
 * `pnpm install` has necessarily been re-run.
 *
 * Usage:
 *   node scripts/wait-ready.mjs [--timeout <seconds>] [--web-port <n>]
 *                               [--api-port <n>] [--web-only] [--api-only]
 *                               [--quiet]
 *
 * Env equivalents: WEB_PORT, API_PORT, WAIT_READY_TIMEOUT (seconds).
 * `scripts/dev.sh` already exports API_PORT, so a caller that sources the dev
 * environment gets the right port for free.
 *
 * Exit codes: 0 ready, 1 not ready before the deadline, 2 the sandbox forbids
 * local connections (see docs/verification.md — the same EPERM/EACCES split
 * scripts/pick-port.mjs makes for binds).
 */
import { request } from "node:http";

/** Next.js falls back past a busy 3000 on its own; API_PORT comes from
 *  scripts/pick-port.mjs, which scans 10 ports up from 8000. Probing the same
 *  ranges means an explicit port is an optimisation, never a requirement. */
const WEB_PORT_RANGE = 10;
const API_PORT_RANGE = 10;
const DEFAULT_WEB_PORT = 3000;
const DEFAULT_API_PORT = 8000;
const DEFAULT_TIMEOUT_SECONDS = 120;

/** uvicorn binds 127.0.0.1, Next binds either; on macOS `localhost` can
 *  resolve to ::1 first and miss a v4-only listener entirely. Probe both
 *  literals rather than trusting name resolution. */
const HOSTS = ["127.0.0.1", "::1"];

/** A single attempt this long means the server is up but still compiling, not
 *  that it is absent — so it is retried rather than treated as fatal. */
const ATTEMPT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 250;

/** EACCES/EPERM on connect is a sandbox policy, not a slow boot. Waiting the
 *  full deadline for it to change is pure delay, so it exits immediately. */
const CONNECT_DENIED_CODES = new Set(["EACCES", "EPERM"]);
const DENIED_FIX =
  "Allow local network connections in your sandbox, or run verification in an environment that permits them";

function parseArgs(argv) {
  const options = {
    timeoutSeconds: numberOrNull(process.env.WAIT_READY_TIMEOUT) ?? DEFAULT_TIMEOUT_SECONDS,
    webPort: numberOrNull(process.env.WEB_PORT),
    apiPort: numberOrNull(process.env.API_PORT),
    web: true,
    api: true,
    quiet: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];

    switch (arg) {
      case "--timeout":
        options.timeoutSeconds = numberOrNull(next()) ?? options.timeoutSeconds;
        break;
      case "--web-port":
        options.webPort = numberOrNull(next());
        break;
      case "--api-port":
        options.apiPort = numberOrNull(next());
        break;
      case "--web-only":
        options.api = false;
        break;
      case "--api-only":
        options.web = false;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: node scripts/wait-ready.mjs [--timeout <seconds>] [--web-port <n>] [--api-port <n>] [--web-only] [--api-only] [--quiet]\n",
        );
        process.exit(0);
        break;
      default:
        process.stderr.write(`wait-ready: unknown argument ${JSON.stringify(arg)}\n`);
        process.exit(1);
    }
  }

  return options;
}

function numberOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidatePorts(explicit, start, range) {
  // An explicit port is authoritative: probing neighbours after it would
  // happily "succeed" against a different app someone left running.
  if (explicit !== null) return [explicit];
  return Array.from({ length: range }, (_, offset) => start + offset);
}

/**
 * One HTTP GET. Resolves a discriminated result rather than throwing, so the
 * caller can tell "nothing listening yet" (retry) from "the sandbox says no"
 * (stop) — the same four-outcome discipline as scripts/local-bind.mjs.
 *
 * @returns {Promise<{status:"answered",code:number,body:string}
 *                 | {status:"closed"}
 *                 | {status:"denied",code:string}
 *                 | {status:"timeout"}>}
 */
function probeHttp(host, port, path, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const clientRequest = request(
      { host, port, path, method: "GET", timeout: timeoutMs, family: host.includes(":") ? 6 : 4 },
      (response) => {
        let body = "";
        // Cap the body: a ready check must not pull a whole HTML page into
        // memory, and /health is a few dozen bytes.
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 2_000) body += chunk;
        });
        response.on("end", () => finish({ status: "answered", code: response.statusCode ?? 0, body }));
        response.on("error", () => finish({ status: "closed" }));
      },
    );

    clientRequest.on("timeout", () => {
      clientRequest.destroy();
      finish({ status: "timeout" });
    });

    clientRequest.on("error", (error) => {
      const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
      if (CONNECT_DENIED_CODES.has(code)) {
        finish({ status: "denied", code });
        return;
      }
      finish({ status: "closed" });
    });

    clientRequest.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe one service across its candidate ports until it answers or the
 * deadline passes.
 *
 * @returns {Promise<{ready:true,url:string,body:string}
 *                 | {ready:false,reason:"timeout"|"denied",detail:string}>}
 */
async function waitForService({ label, path, accept, ports, deadline }) {
  let deniedCode = null;

  while (Date.now() < deadline) {
    for (const port of ports) {
      for (const host of HOSTS) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;

        const result = await probeHttp(host, port, path, Math.min(ATTEMPT_TIMEOUT_MS, remaining));

        if (result.status === "denied") {
          deniedCode = result.code;
          continue;
        }
        if (result.status === "answered" && accept(result)) {
          const authority = host.includes(":") ? `[${host}]` : host;
          return { ready: true, url: `http://${authority}:${port}${path}`, body: result.body };
        }
      }
    }

    // Every candidate was refused. If *every* refusal was a permission error
    // there is nothing to wait for — the sandbox will keep saying no.
    if (deniedCode) {
      return {
        ready: false,
        reason: "denied",
        detail: `${label} connect denied (${deniedCode}); fix: ${DENIED_FIX}`,
      };
    }

    await sleep(RETRY_DELAY_MS);
  }

  return {
    ready: false,
    reason: "timeout",
    detail: `${label} never answered on ${describePorts(ports)}`,
  };
}

function describePorts(ports) {
  if (ports.length === 1) return `port ${ports[0]}`;
  return `ports ${ports[0]}-${ports[ports.length - 1]}`;
}

/** The API is ready when /health answers 200. `degraded` still counts: it means
 *  the app is serving and B2 connectivity is the thing that is unhappy, which
 *  is a finding for the caller to report, not a reason to keep waiting. */
const apiReady = (result) => result.code === 200;

/** Any HTTP status means Next is serving. A 404 or a 500 from the app itself is
 *  a real page the caller should go look at, not an un-started server. */
const webReady = (result) => result.code > 0;

function healthSummary(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.status === "string") return parsed.status;
  } catch {
    // /health is JSON by contract; a non-JSON 200 is still "answering".
  }
  return "unknown";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutSeconds * 1_000;

  const targets = [];
  if (options.api) {
    targets.push(
      waitForService({
        label: "api",
        path: "/health",
        accept: apiReady,
        ports: candidatePorts(options.apiPort, DEFAULT_API_PORT, API_PORT_RANGE),
        deadline,
      }).then((result) => ({ name: "api", ...result })),
    );
  }
  if (options.web) {
    targets.push(
      waitForService({
        label: "web",
        path: "/",
        accept: webReady,
        ports: candidatePorts(options.webPort, DEFAULT_WEB_PORT, WEB_PORT_RANGE),
        deadline,
      }).then((result) => ({ name: "web", ...result })),
    );
  }

  if (targets.length === 0) {
    process.stdout.write("wait-ready: NOT-READY nothing to probe (--web-only and --api-only cancel out)\n");
    process.exit(1);
  }

  const results = await Promise.all(targets);
  const elapsed = ((Date.now() - startedAt) / 1_000).toFixed(1);
  const failures = results.filter((result) => !result.ready);

  if (failures.length === 0) {
    const parts = results.map((result) => {
      const origin = result.url.replace(/\/health$|\/$/, "");
      return result.name === "api"
        ? `api=${origin} health=${healthSummary(result.body)}`
        : `${result.name}=${origin}`;
    });
    if (!options.quiet) {
      process.stdout.write(`wait-ready: READY ${parts.join(" ")} in ${elapsed}s\n`);
    }
    process.exit(0);
  }

  const denied = failures.some((failure) => failure.reason === "denied");
  process.stdout.write(
    `wait-ready: NOT-READY after ${elapsed}s — ${failures.map((failure) => failure.detail).join("; ")}\n`,
  );
  process.exit(denied ? 2 : 1);
}

await main();
