/**
 * Hot-attach orchestration, free of the `vscode` module.
 *
 * The whole point of this file is that the attach sequence can be driven from
 * `npm run test:attach` against a fake ControlPlane (real ZMQ peer, real
 * control_client.py), so a failure path is a verifiable claim instead of a
 * reading of the source.
 *
 * Sequence preserved from the previous in-line implementation, with cause
 * attribution added around it:
 *   1. `status` probe        -> refuse early when the module is not running
 *   2. ready wait            -> only when the module is restarting
 *   3. `start_debug`         -> ask the worker to call debugpy.listen()
 *   4. attach                -> caller-provided callback (VS Code session in
 *                               production, a TCP probe in the harness)
 *
 * The port strategy, the timeouts and the serial attach order are deliberately
 * unchanged: race-prone changes wait for the fault-injection harness from
 * issue #6 to exist first.
 */

import {
  classifyAttachError,
  classifyControlError,
  classifyControlReply,
  type AttachCause,
  type ClassifiedFailure,
} from "./attachDiagnostics";

export interface JsonMap {
  [key: string]: unknown;
}

export interface ControlRequestOptions {
  force?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  debugPort?: number;
  debugHost?: string;
}

/** The subset of the extension's ControlClient this kernel needs. */
export interface ControlLike {
  request(
    action: string,
    module?: string,
    options?: ControlRequestOptions,
  ): Promise<JsonMap>;
}

export type HotAttachOutcomeKind =
  | "attached"
  | /** main.py already runs under a debugger; nothing to attach. */
    "under-debugger"
  | /** a listener already existed and we attached to it. */
    "already-listening"
  | "failed";

export interface HotAttachStep {
  readonly name: "status" | "ready-wait" | "start_debug" | "attach";
  readonly ms: number;
  readonly ok: boolean;
  readonly note?: string;
}

export interface HotAttachOutcome {
  readonly kind: HotAttachOutcomeKind;
  readonly module: string;
  readonly host?: string;
  readonly port?: number;
  readonly workerPid?: number;
  readonly failure?: ClassifiedFailure;
  readonly steps: readonly HotAttachStep[];
  readonly ms: number;
}

export interface HotAttachRequest {
  readonly module: string;
  /** Orchestrators live in main.py and share one listener on the conventional port. */
  readonly isOrchestrator?: boolean;
  /** Fail fast if false instead of waiting through a restart cycle. */
  readonly allowRestartWait?: boolean;
  readonly readyTimeoutMs?: number;
}

export interface HotAttachHooks {
  /** Show progress / refresh UI. May be a no-op in tests. */
  onStep?(step: HotAttachStep): void;
  /** Start the IDE debug session. Resolves once the IDE accepted it. */
  attach(host: string, port: number, module: string): Promise<void>;
  /** Poll `status` until ready; defaults to `pollUntilReady`. */
  waitUntilReady?(module: string, timeoutMs: number): Promise<void>;
  now?(): number;
}

const DEFAULT_READY_TIMEOUT_MS = 70_000;
const START_DEBUG_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;
const READY_POLL_INTERVAL_MS = 300;

/**
 * Poll `status` until the module reports ready, mirroring the Supervisor's
 * asynchronous restart: readiness means `ready && !restarting`.
 */
export async function pollUntilReady(
  control: ControlLike,
  module: string,
  timeoutMs: number,
  now: () => number = Date.now,
  intervalMs: number = READY_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const status = await control.request("status", module, {
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      if (status.ready === true && status.restarting !== true) {
        return true;
      }
    } catch {
      // A control call that fails mid-restart is not readiness; keep polling
      // until the deadline so the outcome stays ready_wait_timeout.
    }
    if (now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function step(
  name: HotAttachStep["name"],
  startedAt: number,
  ok: boolean,
  now: () => number,
  note?: string,
): HotAttachStep {
  return { name, ms: Math.max(0, now() - startedAt), ok, note };
}

function failure(
  request: HotAttachRequest,
  steps: HotAttachStep[],
  now: () => number,
  totalStartedAt: number,
  classified: ClassifiedFailure,
): HotAttachOutcome {
  return {
    kind: "failed",
    module: request.module,
    failure: classified,
    steps,
    ms: Math.max(0, now() - totalStartedAt),
  };
}

/**
 * Ask the worker owning `module` to start listening with debugpy, then attach.
 *
 * Never throws: every branch is reported as a classified outcome so callers can
 * show advice instead of a stack trace.
 */
export async function hotAttach(
  control: ControlLike,
  request: HotAttachRequest,
  hooks: HotAttachHooks,
): Promise<HotAttachOutcome> {
  const now = hooks.now ?? Date.now;
  const startedAt = now();
  const steps: HotAttachStep[] = [];

  // 1. Is there a live process to inject into at all?
  const statusStart = now();
  let status: JsonMap;
  try {
    status = await control.request("status", request.module, {
      timeoutMs: STATUS_TIMEOUT_MS,
    });
  } catch (error) {
    const classified = classifyControlError(error);
    steps.push(
      step("status", statusStart, false, now, classified.cause),
    );
    return failure(request, steps, now, startedAt, classified);
  }
  if (status.status === "error") {
    const classified = classifyControlReply(status);
    steps.push(step("status", statusStart, false, now, classified.cause));
    return failure(request, steps, now, startedAt, classified);
  }
  const isRunning = status.alive === true || status.restarting === true;
  steps.push(step("status", statusStart, true, now));
  if (!isRunning) {
    const cause: AttachCause = request.isOrchestrator
      ? "orchestrator_not_running"
      : "module_not_running";
    return failure(request, steps, now, startedAt, {
      cause,
      detail: `${request.module} reported alive=${String(status.alive)} restarting=${String(status.restarting)}`,
    });
  }

  // 2. A process mid-restart cannot serve start_debug yet.
  if (status.restarting === true) {
    const readyStart = now();
    const timeoutMs = request.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    let ready = false;
    try {
      ready = hooks.waitUntilReady
        ? (await hooks.waitUntilReady(request.module, timeoutMs), true)
        : await pollUntilReady(control, request.module, timeoutMs, now);
    } catch {
      ready = false;
    }
    if (ready) {
      steps.push(step("ready-wait", readyStart, true, now));
    } else {
      const classified: ClassifiedFailure = {
        cause: "ready_wait_timeout",
        detail: `${request.module} did not report ready within ${timeoutMs}ms`,
      };
      steps.push(step("ready-wait", readyStart, false, now, classified.cause));
      return failure(request, steps, now, startedAt, classified);
    }
  }

  // 3. Ask the worker (or main.py) to open a debugpy listener.
  const debugStart = now();
  let reply: JsonMap;
  try {
    reply = await control.request("start_debug", request.module, {
      timeoutMs: START_DEBUG_TIMEOUT_MS,
    });
  } catch (error) {
    const classified = classifyControlError(error);
    steps.push(step("start_debug", debugStart, false, now, classified.cause));
    return failure(request, steps, now, startedAt, classified);
  }
  if (reply.status === "error") {
    const classified = classifyControlReply(reply);
    steps.push(
      step("start_debug", debugStart, false, now, classified.code ?? classified.cause),
    );
    return failure(request, steps, now, startedAt, classified);
  }

  const workerPid = asNumber(reply.pid);
  // Wait for a debugger that lives in main.py's F5 session: reusing that
  // session is correct behaviour, not a failure.
  if (reply.under_debugger === true) {
    steps.push(step("start_debug", debugStart, true, now, "under_debugger"));
    return {
      kind: "under-debugger",
      module: request.module,
      workerPid,
      steps,
      ms: Math.max(0, now() - startedAt),
    };
  }
  steps.push(
    step(
      "start_debug",
      debugStart,
      true,
      now,
      reply.already === true ? "already-listening" : undefined,
    ),
  );

  const rawPort = asNumber(reply.port);
  if (rawPort === undefined || !Number.isInteger(rawPort) || rawPort <= 0) {
    const classified: ClassifiedFailure = {
      cause: "invalid_reply",
      detail: `start_debug replied without a usable port: ${JSON.stringify(reply)}`,
    };
    return failure(request, steps, now, startedAt, classified);
  }
  const host = asString(reply.host) ?? "localhost";
  const already = reply.already === true;

  // 4. Hand the endpoint to the IDE.
  const attachStart = now();
  try {
    await hooks.attach(host, rawPort, request.module);
  } catch (error) {
    const classified = classifyAttachError(error);
    steps.push(step("attach", attachStart, false, now, classified.cause));
    return {
      ...failure(request, steps, now, startedAt, classified),
      host,
      port: rawPort,
      workerPid,
    };
  }
  steps.push(step("attach", attachStart, true, now));
  return {
    kind: already ? "already-listening" : "attached",
    module: request.module,
    host,
    port: rawPort,
    workerPid,
    steps,
    ms: Math.max(0, now() - startedAt),
  };
}
