/**
 * Attach failure-attribution harness.
 *
 *   npm run test:attach
 *
 * Drives the real `hotAttach()` kernel from `src/attachCore.ts` against a real
 * ZMQ peer (`test/fixtures/fake_control_plane.py`) reached through the real
 * system `control_client.py`, with one injected fault per case. It proves two
 * things a source reading cannot:
 *
 *   1. every failure path is attributed to one distinct cause (no more
 *      "may not support start_debug, or port is in use" for six different bugs);
 *   2. the success path really connects to the endpoint the ControlPlane
 *      advertised, on a socket we actually open.
 *
 * Scope note: this covers the hot-attach decision logic and the wire contract.
 * `vscode.debug.startDebugging` is injected as the attach hook, so the IDE-side
 * session plumbing still needs the manual checklist below.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import {
  hotAttach,
  type ControlLike,
  type JsonMap,
} from "../src/attachCore";
import { CAUSE_ADVICE, formatFailureLine } from "../src/attachDiagnostics";
import type {
  AttachAttemptRecord,
  AttachCause,
  DiagnosticsHeader,
} from "../src/attachDiagnostics";

const REPO_ROOT = path.resolve(__dirname, "..");
const SYSTEM_DIR = path.join(REPO_ROOT, "test", "fixtures");
const FAKE_PLANE = path.join(SYSTEM_DIR, "fake_control_plane.py");
const CLIENT = path.join(SYSTEM_DIR, "control_client.py");
const OLD_CLIENT = path.join(SYSTEM_DIR, "old_control_client.py");
const PYTHON = process.env.AUTOSURG_TEST_PYTHON ?? "python3";

interface Case {
  readonly name: string;
  readonly fault: string;
  readonly planeArgs?: readonly string[];
  readonly clientScript?: string;
  readonly isOrchestrator?: boolean;
  readonly expect: "attached" | "already-listening" | "under-debugger" | "failed";
  readonly expectCause?: string;
  readonly expectPortAdvertised?: boolean;
  /** Simulate the IDE refusing to open the session. */
  readonly failAttach?: boolean;
  readonly readyTimeoutMs?: number;
}

const CASES: readonly Case[] = [
  {
    name: "healthy worker: attaches to the advertised endpoint",
    fault: "none",
    planeArgs: ["--listen"],
    expect: "attached",
    expectPortAdvertised: true,
  },
  {
    name: "worker already listening: attach reuses it",
    fault: "already-listening",
    planeArgs: ["--listen"],
    expect: "already-listening",
  },
  {
    name: "main.py already under an F5 session: reuse, not failure",
    fault: "under-debugger",
    isOrchestrator: true,
    expect: "under-debugger",
  },
  {
    name: "ControlPlane predates start_debug",
    fault: "no-start-debug",
    expect: "failed",
    expectCause: "action_not_supported",
  },
  {
    name: "system control_client.py too old for start_debug",
    fault: "none",
    clientScript: OLD_CLIENT,
    expect: "failed",
    expectCause: "client_too_old",
  },
  {
    name: "debugpy not importable in the worker",
    fault: "debugpy-import",
    expect: "failed",
    expectCause: "debugpy_import_failed",
  },
  {
    name: "debugpy.listen() cannot bind the port",
    fault: "debugpy-listen",
    expect: "failed",
    expectCause: "debugpy_listen_failed",
  },
  {
    name: "worker did not reply inside the supervisor",
    fault: "worker-rpc-timeout",
    expect: "failed",
    expectCause: "worker_rpc_timeout",
  },
  {
    name: "no live replica behind the module",
    fault: "worker-unavailable",
    expect: "failed",
    expectCause: "worker_unavailable",
  },
  {
    name: "worker handler raised",
    fault: "handler-error",
    expect: "failed",
    expectCause: "worker_handler_error",
  },
  {
    name: "module unknown to the running system",
    fault: "unknown-module",
    expect: "failed",
    expectCause: "unknown_module",
  },
  {
    name: "module is not a compute module",
    fault: "not-compute",
    expect: "failed",
    expectCause: "module_wrong_kind",
  },
  {
    name: "module has no compute address",
    fault: "no-address",
    expect: "failed",
    expectCause: "no_compute_address",
  },
  {
    name: "module is not running",
    fault: "not-running",
    expect: "failed",
    expectCause: "module_not_running",
  },
  {
    name: "start_debug replied without a usable port",
    fault: "no-port",
    expect: "failed",
    expectCause: "invalid_reply",
  },
  {
    name: "worker never leaves the restarting state",
    fault: "restarting",
    expect: "failed",
    expectCause: "ready_wait_timeout",
    readyTimeoutMs: 1200,
  },
  {
    name: "worker replies but VS Code refuses the session",
    fault: "already-listening",
    planeArgs: ["--listen"],
    failAttach: true,
    expect: "failed",
    expectCause: "attach_refused",
  },
  {
    name: "stale listener: endpoint answers once, then refuses",
    fault: "stale-listener",
    expect: "failed",
    expectCause: "attach_refused",
    expectPortAdvertised: true,
  },
  {
    name: "worker finishes restarting mid-wait, then attaches",
    fault: "restarting",
    planeArgs: ["--listen", "--ready-after", "2"],
    expect: "attached",
  },
];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

class Plane {
  private readonly child: ChildProcess;

  private constructor(
    readonly port: number,
    child: ChildProcess,
  ) {
    this.child = child;
  }

  static async start(
    port: number,
    fault: string,
    extra: readonly string[] = [],
  ): Promise<Plane> {
    const child = spawn(
      PYTHON,
      [
        FAKE_PLANE,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--fault",
        fault,
        ...extra,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`fake ControlPlane did not start: ${stderr}`)),
        8000,
      );
      child.stdout?.on("data", (data) => {
        if (String(data).includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`fake ControlPlane exited early (${code}): ${stderr}`));
      });
    });
    return new Plane(port, child);
  }

  stop(): void {
    this.child.kill("SIGKILL");
  }
}

/** Same CLI contract and failure conventions as the extension's ControlClient. */
function makeClient(script: string, port: number): ControlLike {
  return {
    request(action, module, options): Promise<JsonMap> {
      return new Promise((resolve, reject) => {
        const args = [
          script,
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--timeout-ms",
          String(options?.timeoutMs ?? 3000),
          action,
          "--json",
        ];
        if (module) {
          args.push("--module", module);
        }
        const child = spawn(PYTHON, args, { cwd: SYSTEM_DIR });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
          stdout += String(data);
        });
        child.stderr.on("data", (data) => {
          stderr += String(data);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(
              new Error(stderr.trim() || stdout.trim() || `Exit code ${code}`),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout) as JsonMap);
          } catch {
            reject(new Error(`Invalid ControlPlane response: ${stdout}`));
          }
        });
      });
    },
  };
}

/** Real TCP connect to the advertised endpoint, mimicking a debugger connector. */
function probeEndpoint(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect ${host}:${port} timed out`));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(`Unable to attach to ${host}:${port} (${String(error)})`),
      );
    });
  });
}

/**
 * Two properties the whole exercise depends on: an unreachable ControlPlane
 * must not be mislabelled as "module not running", and no advice string may
 * be so long that the toast truncates it.
 */
async function testIdleAttachGuard(): Promise<string[]> {
  const problems: string[] = [];
  const client = makeClient(CLIENT, await freePort());
  const outcome = await hotAttach(
    client,
    { module: "stereo" },
    { attach: async () => undefined },
  );
  if (outcome.kind !== "failed") {
    problems.push("offline ControlPlane was not reported as a failure");
  } else if (outcome.failure?.cause === "module_not_running") {
    problems.push(
      `offline ControlPlane mislabelled as module_not_running (${outcome.failure.detail})`,
    );
  }

  // A stale listener that refuses connections must be reported as attach_refused
  // with the endpoint preserved, not as "worker not running".
  const ghostPort = await freePort();
  const ghost = await hotAttach(
    {
      request: async (action: string) =>
        action === "status"
          ? { status: "ok", alive: true, ready: true }
          : okReply(ghostPort),
    },
    { module: "stereo" },
    { attach: (host, port) => probeEndpoint(host, port) },
  );
  if (ghost.failure?.cause !== "attach_refused") {
    problems.push(
      `stale listener expected attach_refused, got ${String(ghost.failure?.cause)}`,
    );
  }
  if (ghost.port !== ghostPort || ghost.kind === "failed" && !ghost.host) {
    problems.push("attach failure lost the endpoint needed for triage");
  }

  // Headroom under VS Code's notification clamp (~1000 chars); we never depend
  // on the exact number, we only require that no cause gets anywhere near it.
  const TOAST_BUDGET = 600;
  const longest = formatFailureLine("supervisor", {
    cause: "worker_handler_error",
    detail: "start_debug handler raised: RuntimeError('worker is shutting down')",
  });
  if (longest.length > TOAST_BUDGET) {
    problems.push(
      `toast text is ${longest.length} chars (> ${TOAST_BUDGET}): ${longest}`,
    );
  }
  if (!longest.includes("\n")) {
    problems.push("toast lost its two-line shape: cause and advice merged");
  }
  // Every cause has to fit the same budget with a realistic module name, so a
  // long advice string cannot silently replace itself with "...".
  for (const cause of Object.keys(CAUSE_ADVICE) as AttachCause[]) {
    const text = formatFailureLine(
      "supervisor",
      { cause, detail: "representative raw reply" },
    );
    if (text.length > TOAST_BUDGET) {
      problems.push(
        `cause ${cause} overflows the toast (${text.length} chars): ${text}`,
      );
    }
  }
  return problems;
}

function okReply(port: number): JsonMap {
  return {
    status: "ok",
    host: "127.0.0.1",
    port,
    already: true,
    listening: true,
    pid: 1,
  };
}

async function runCase(testCase: Case): Promise<string[]> {
  const problems: string[] = [];
  const plane = await Plane.start(
    await freePort(),
    testCase.fault,
    testCase.planeArgs ?? [],
  );
  try {
    const client = makeClient(testCase.clientScript ?? CLIENT, plane.port);
    const outcome = await hotAttach(
      client,
      {
        module: "stereo",
        isOrchestrator: testCase.isOrchestrator,
        readyTimeoutMs: testCase.readyTimeoutMs,
      },
      {
        attach: async (host, port) => {
          if (testCase.failAttach) {
            throw new Error(`Unable to attach to stereo on ${host}:${port}`);
          }
          await probeEndpoint(host, port);
        },
      },
    );

    if (outcome.kind !== testCase.expect) {
      problems.push(
        `expected outcome ${testCase.expect}, got ${outcome.kind}${
          outcome.failure ? ` (${outcome.failure.cause}: ${outcome.failure.detail})` : ""
        }`,
      );
    }
    const cause = outcome.failure?.cause;
    if (testCase.expectCause && cause !== testCase.expectCause) {
      problems.push(
        `expected cause ${testCase.expectCause}, got ${String(cause)}${
          outcome.failure ? ` (detail: ${outcome.failure.detail})` : ""
        }`,
      );
    }
    if (testCase.expectPortAdvertised && !outcome.port) {
      problems.push("success path lost the advertised debug port");
    }
    if (
      (testCase.expect === "attached" ||
        testCase.expect === "already-listening") &&
      outcome.kind === testCase.expect &&
      !outcome.steps.some((entry) => entry.name === "attach" && entry.ok)
    ) {
      problems.push("no successful attach step recorded");
    }
    if (outcome.kind === "failed" && !outcome.failure?.detail) {
      problems.push("failure carries no raw detail, so it cannot be triaged");
    }
    return problems;
  } finally {
    plane.stop();
  }
}

/**
 * The bundle is what a colleague pastes, so its summary has to be honest about
 * a repeating cause instead of listing twelve identical lines.
 */
async function testDiagnosticsBundle(): Promise<string[]> {
  const problems: string[] = [];
  const { formatDiagnosticsBundle } = await import("../src/attachDiagnostics");
  const header: DiagnosticsHeader = {
    extensionVersion: "0.0.0-test",
    vscodeVersion: "test",
    platform: "linux",
    configPath: "/system/config/modules.yaml",
    controlHost: "localhost",
    controlPort: 5560,
    controlPython: "python3",
    debugPortBase: 5678,
    activeSessions: ["AutoSurg: stereo (5678)"],
    reservedPorts: [5679],
  };
  const attempts: AttachAttemptRecord[] = [
    {
      at: "2026-09-04T10:00:00.000Z",
      action: "hot",
      module: "stereo",
      outcome: "failed",
      cause: "debugpy_import_failed",
      detail: "failed to import debugpy: No module named 'debugpy'",
      ms: 120,
    },
    {
      at: "2026-09-04T10:00:05.000Z",
      action: "hot",
      module: "stereo",
      outcome: "failed",
      cause: "debugpy_import_failed",
      detail: "failed to import debugpy: No module named 'debugpy'",
      ms: 118,
    },
    {
      at: "2026-09-04T10:01:00.000Z",
      action: "restart",
      module: "tracker",
      outcome: "ok",
      endpoint: "localhost:5679",
      ms: 4100,
    },
  ];
  const bundle = formatDiagnosticsBundle(header, attempts);
  for (const needle of [
    "debugpy_import_failed x2",
    "No module named",
    "localhost:5679",
    "AutoSurg: stereo (5678)",
    "0.0.0-test",
  ]) {
    if (!bundle.includes(needle)) {
      problems.push(`bundle lost "${needle}"`);
    }
  }
  if (!/every failure here is/.test(bundle)) {
    problems.push("bundle did not call out a single repeating cause");
  }
  const empty = formatDiagnosticsBundle(header, []);
  if (!empty.includes("no attach attempt recorded")) {
    problems.push("empty bundle gives a reader nothing to say");
  }
  return problems;
}

async function main(): Promise<void> {
  const failures: string[] = [
    ...(await testIdleAttachGuard()),
    ...(await testDiagnosticsBundle()),
  ];
  let localPassed = 0;
  // The extension raises these two locally; if their wording drifts, the
  // anchored patterns below stop matching and the failure silently degrades to
  // "could not reach the ControlPlane". Pinned on purpose.
  {
    const local = await import("../src/attachDiagnostics");
    const cases: Array<[string, string]> = [
      ["Timed out waiting for stereo to become ready", "ready_wait_timeout"],
      ["No debug port is available.", "port_discovery_failed"],
      ["Request timed out", "control_plane_offline"],
    ];
    let ok = true;
    for (const [message, expect] of cases) {
      const got = local.classifyControlError(new Error(message)).cause;
      if (got !== expect) {
        ok = false;
        failures.push(`local error "${message}" classified as ${got}, want ${expect}`);
      }
    }
    if (ok) {
      localPassed += 1;
      console.log("ok   locally raised failures keep their own causes");
    } else {
      console.log("FAIL locally raised failures keep their own causes");
    }
  }

  let passed = 0;
  for (const testCase of CASES) {
    try {
      const problems = await runCase(testCase);
      if (problems.length === 0) {
        passed += 1;
        console.log(`ok   ${testCase.name}`);
      } else {
        for (const problem of problems) {
          failures.push(`${testCase.name}: ${problem}`);
        }
        console.log(`FAIL ${testCase.name}`);
      }
    } catch (error) {
      failures.push(`${testCase.name}: harness error ${String(error)}`);
      console.log(`FAIL ${testCase.name} (error)`);
    }
  }

  const total = CASES.length + 1;
  console.log(`\n${passed + localPassed}/${total} attach scenarios attributed correctly`);

  // Every injected fault must land on a named cause: "unknown" would mean the
  // user sees "could not classify" for a failure we can actually produce.
  // Two scenarios may legitimately share a cause (stale listener and a refused
  // session are both attach_refused), so uniqueness is not asserted.
  for (const testCase of CASES.filter((entry) => entry.expectCause)) {
    if (testCase.expectCause === "unknown") {
      failures.push(`${testCase.name}: expected the catch-all cause`);
    }
  }
  const codeCauses = new Set(
    CASES.filter((entry) => entry.fault.includes("debugpy") || entry.fault.includes("worker"))
      .map((entry) => entry.expectCause),
  );
  if (codeCauses.size < 4) {
    failures.push(
      `machine-readable codes collapse onto ${codeCauses.size} cause(s); they must stay distinct`,
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} problem(s):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "no injected fault fell through to the catch-all cause; toast text fits the budget",
  );
}

void main();
