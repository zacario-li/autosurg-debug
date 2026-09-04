/**
 * Attach failure attribution and diagnostics bundle.
 *
 * Deliberately free of the `vscode` module so the classification table and the
 * diagnostics bundle can be exercised by `npm run test:attach` against the fake
 * ControlPlane without a VS Code host.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tryHotPlugDebug()` used to collapse every failure into `undefined`, so the
 * user only ever saw "hot-attach failed. The worker may not support
 * start_debug yet, or the debug port is in use" regardless of the real cause,
 * and the only way to diagnose it was to ask the extension author.
 *
 * CAUSE TABLE PROVENANCE
 * ----------------------
 * Every cause below maps to a signal we can actually observe. Verified against
 * the sibling system checkout (`srt-h/system`) that this extension drives:
 *
 *   - `runtime/control_plane.py`     -> {"status":"error","message":"unknown action: X"}
 *   - `runtime/system_supervisor.py` -> {"status":"error","code":"RPC_TIMEOUT"} and the
 *                                       literal messages "unknown module: X",
 *                                       "X is not a compute module",
 *                                       "X is not running",
 *                                       "unknown orchestrator: X",
 *                                       "orchestrator 'X' is not running"
 *   - `infra/debugpy_runtime.py`     -> codes DEBUGPY_IMPORT / DEBUGPY_LISTEN
 *   - `runtime/compute_lb.py`,
 *     `runtime/compute_loop.py`      -> codes WORKER_UNAVAILABLE / COMPUTE_HANDLER_ERROR
 *
 * Causes marked UNVERIFIED are inferred from strings the *extension* itself
 * produces; they are honest about being weak and always keep the raw text.
 * Messages from the system side are matched as a convenience layer only: the
 * machine-readable `code` field always wins, and anything unknown falls into
 * `unknown` with the raw payload preserved so the bundle stays useful.
 */

/** Machine-readable `code` values the system side is known to emit. */
export const KNOWN_SYSTEM_CODES = [
  "RPC_TIMEOUT",
  "DEBUGPY_IMPORT",
  "DEBUGPY_LISTEN",
  "WORKER_UNAVAILABLE",
  "COMPUTE_HANDLER_ERROR",
] as const;

export type AttachCause =
  // Decided from a machine-readable `code` in the system reply.
  | "worker_rpc_timeout" // worker did not answer start_debug in time
  | "debugpy_import_failed" // debugpy not importable in the target env
  | "debugpy_listen_failed" // debugpy.listen() refused (port busy, bind host)
  | "worker_unavailable" // LB has no live worker to forward to
  | "worker_handler_error" // worker raised while handling start_debug
  // Decided from a known ControlPlane message.
  | "action_not_supported" // ControlPlane predates start_debug
  | "client_too_old" // shipped control_client.py rejects start_debug
  | "module_not_running"
  | "orchestrator_not_running"
  | "unknown_module"
  | "module_wrong_kind"
  | "invalid_debug_port"
  | "no_compute_address"
  // Decided from the transport layer.
  | "control_plane_offline" // client could not connect / REQ timed out
  | "control_python_missing" // configured autosurg.controlPython is unusable
  | "client_script_missing" // dbg_tools/control_client.py is absent
  // Decided on our side, after the worker said ok.
  | "attach_refused" // start_debug said ok but no connection was accepted
  | "ready_wait_timeout" // module never became ready
  | "invalid_reply" // reply was not JSON or missed required fields
  | "port_discovery_failed" // no free local debug port found
  | "unknown"; // anything else - raw detail is preserved

export interface CauseAdvice {
  /** One-line human readable diagnosis. */
  readonly summary: string;
  /** Concrete next step, phrased as advice, not as blame. */
  readonly advice: string;
}

/**
 * Order matters: the first matching row wins.
 * `code` rows are matched before `message` rows by the classifier.
 */
export const CAUSE_ADVICE: Record<AttachCause, CauseAdvice> = {
  worker_rpc_timeout: {
    summary: "The worker did not answer start_debug in time.",
    advice:
      "The worker is probably busy or already stopped at a breakpoint in another debugger session. Check its log, then retry; if it repeats, use Restart-Attach.",
  },
  debugpy_import_failed: {
    summary: "debugpy is not importable inside the target module.",
    advice:
      "Install debugpy into the interpreter this module runs on (its modules.yaml python / conda_env), then retry.",
  },
  debugpy_listen_failed: {
    summary: "debugpy could not bind a listening socket in the target process.",
    advice:
      "The conventional debug port is taken, or the bind host is wrong. Free the port, or close the debugger session that already holds it, then retry.",
  },
  worker_unavailable: {
    summary: "No live worker answered the forwarded start_debug.",
    advice:
      "The module looks alive but no replica replied. Check the replica list in the AutoSurg view, restart the module, then retry.",
  },
  worker_handler_error: {
    summary: "The worker raised while handling start_debug.",
    advice:
      "Open the system log stream and look for the traceback around this timestamp; the raw message below names the failing handler.",
  },
  action_not_supported: {
    summary: "ControlPlane does not support start_debug at all.",
    advice:
      "The running main.py predates hot-attach support. Restart the system with a ControlPlane that implements start_debug, or fall back to Restart-Attach.",
  },
  client_too_old: {
    summary: "The system's dbg_tools/control_client.py cannot speak start_debug.",
    advice:
      "Update the system's debug tools to match the running main.py, or fall back to Restart-Attach.",
  },
  module_not_running: {
    summary: "The module is not running, so there is nothing to inject into.",
    advice: "Start it first, or use Restart-Attach, which launches it with a debug port.",
  },
  orchestrator_not_running: {
    summary: "The orchestrator is not running inside main.py.",
    advice:
      "Start the system, or use Debug Orchestrator to launch main.py under the debugger.",
  },
  unknown_module: {
    summary: "ControlPlane does not know this module name.",
    advice:
      "Refresh the AutoSurg view; if it repeats, the workspace modules.yaml and the running system disagree (check autosurg.configPath).",
  },
  module_wrong_kind: {
    summary: "This module is not a Compute module.",
    advice: "Use Hot-Attach on the orchestrator row for code inside main.py.",
  },
  invalid_debug_port: {
    summary: "The requested debug port was rejected.",
    advice:
      "Check autosurg.debugPortBase; ports must be in 1024-65535 and unused.",
  },
  no_compute_address: {
    summary: "The module has no compute address registered.",
    advice:
      "The worker never registered with the load balancer; check its startup log, then restart the module before Hot-Attach.",
  },
  control_plane_offline: {
    summary: "Could not reach the ControlPlane.",
    advice:
      "Start main.py, then check autosurg.controlHost and the port from modules.yaml (a container or remote main.py needs controlHost).",
  },
  control_python_missing: {
    summary: "The configured autosurg.controlPython is unusable.",
    advice:
      "Point autosurg.controlPython at a Python that has pyzmq importable, then retry.",
  },
  client_script_missing: {
    summary: "The system's control_client.py was not found next to modules.yaml.",
    advice:
      "Set autosurg.configPath to the modules.yaml of the running system so the extension can find <system>/dbg_tools/control_client.py.",
  },
  attach_refused: {
    summary: "Nothing accepted the debugger connection, although start_debug said ok.",
    advice:
      "Either another window already owns that listener or the worker restarted since it answered. Stop the older AutoSurg session (or Reload Window); if it repeats, use Restart-Attach.",
  },
  ready_wait_timeout: {
    summary: "The module never reported ready.",
    advice:
      "Check system/log/latest_log.log for this module: usually a wrong Python environment or a missing CUDA library.",
  },
  invalid_reply: {
    summary: "The control reply was not readable.",
    advice:
      "Update the extension and the system's dbg_tools/control_client.py to matching versions.",
  },
  port_discovery_failed: {
    summary: "No free local debug port was available.",
    advice: "Close stale debugger sessions or raise autosurg.debugPortBase.",
  },
  unknown: {
    summary: "AutoSurg could not classify this failure.",
    advice:
      "Copy the diagnostics and send them to the AutoSurg extension author - the raw reply is included, so this case can be added to the table.",
  },
};

export interface ClassifiedFailure {
  readonly cause: AttachCause;
  /** Verbatim evidence: system message, stderr tail, or exception text. */
  readonly detail: string;
  /** System `code` when the reply carried one. */
  readonly code?: string;
}

type JsonMap = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCode(value: unknown): string | undefined {
  const raw = text(value).toUpperCase();
  return raw || undefined;
}

const CODE_TO_CAUSE: Record<string, AttachCause> = {
  RPC_TIMEOUT: "worker_rpc_timeout",
  DEBUGPY_IMPORT: "debugpy_import_failed",
  DEBUGPY_LISTEN: "debugpy_listen_failed",
  WORKER_UNAVAILABLE: "worker_unavailable",
  COMPUTE_HANDLER_ERROR: "worker_handler_error",
};

/** Message shapes emitted by Supervisor/ControlPlane (verified spellings). */
const MESSAGE_PATTERNS: ReadonlyArray<readonly [RegExp, AttachCause]> = [
  [/^unknown action:/i, "action_not_supported"],
  [/invalid choice:.*start_debug/i, "client_too_old"],
  [/is not a compute module/i, "module_wrong_kind"],
  [/^unknown module:/i, "unknown_module"],
  [/^unknown orchestrator:/i, "unknown_module"],
  [/orchestrator .* is not running/i, "orchestrator_not_running"],
  [/is not running/i, "module_not_running"],
  [/has no compute address/i, "no_compute_address"],
  [/invalid debug port/i, "invalid_debug_port"],
  [/already restarting/i, "worker_unavailable"],
];

/** Errors thrown by the control client itself (spawn / REQ timeout / JSON). */
const TRANSPORT_PATTERNS: ReadonlyArray<readonly [RegExp, AttachCause]> = [
  // Raised inside the extension, not on the wire. These must be matched first:
  // a readiness-wait timeout also contains "timed out" and would otherwise be
  // misread as "the ControlPlane is unreachable".
  [/^Timed out waiting for .* to become ready$/, "ready_wait_timeout"],
  [/^No debug port is available\.$/, "port_discovery_failed"],
  [/Request timed out/i, "control_plane_offline"],
  [/timed out/i, "control_plane_offline"],
  [/ECONNREFUSED/i, "control_plane_offline"],
  [/invalid choice:.*start_debug/i, "client_too_old"],
  [/No such file or directory.*control_client\.py/i, "client_script_missing"],
  [/control_client\.py.*No such file/i, "client_script_missing"],
  [/ENOENT/i, "control_python_missing"],
  [/ImportError.*zmq|ModuleNotFoundError.*zmq/i, "control_python_missing"],
  [/Invalid ControlPlane response/i, "invalid_reply"],
];

/**
 * Classify a `status: error` control reply. The `code` field always wins over
 * message matching, and unknown replies keep their raw text.
 */
export function classifyControlReply(reply: JsonMap): ClassifiedFailure {
  const code = normalizeCode(reply.code);
  const message = text(reply.message);
  if (code) {
    const byCode = CODE_TO_CAUSE[code];
    if (byCode) {
      return { cause: byCode, detail: message || code, code };
    }
  }
  for (const [pattern, cause] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return { cause, detail: message || "no message", code };
    }
  }
  if (code) {
    return { cause: "unknown", detail: `${code}: ${message || "no message"}`, code };
  }
  return { cause: "unknown", detail: message || JSON.stringify(reply) };
}

/** Classify a transport-level failure (client spawn, REQ timeout, bad JSON). */
export function classifyControlError(error: unknown): ClassifiedFailure {
  const detail = error instanceof Error ? error.message : String(error);
  for (const [pattern, cause] of TRANSPORT_PATTERNS) {
    if (pattern.test(detail)) {
      return { cause, detail };
    }
  }
  return { cause: "unknown", detail };
}

/**
 * The failure happened after the worker reported a listener, so it is IDE-side
 * or endpoint-side. Only the message we control is classified; anything else the
 * IDE reports for its own reasons stays `unknown` with its raw text.
 */
export function classifyAttachError(error: unknown): ClassifiedFailure {
  const detail = error instanceof Error ? error.message : String(error);
  if (/Unable to attach/i.test(detail)) {
    return { cause: "attach_refused", detail };
  }
  return { cause: "unknown", detail };
}

/** Resolve user-facing advice for a cause. */
export function adviceFor(cause: AttachCause): CauseAdvice {
  return CAUSE_ADVICE[cause] ?? CAUSE_ADVICE.unknown;
}

/** One JSONL line per attach attempt, written to the extension log folder. */
export interface AttachAttemptRecord {
  /** Local ISO timestamp. */
  readonly at: string;
  readonly action: "hot" | "restart" | "all" | "full-system";
  readonly module: string;
  readonly outcome: "ok" | "failed";
  readonly cause?: AttachCause;
  readonly detail?: string;
  /** Worker-reported listening endpoint, when known. */
  readonly endpoint?: string;
  readonly workerPid?: number;
  /** Reused an existing listener instead of calling debugpy.listen(). */
  readonly already?: boolean;
  readonly ms?: number;
}

export interface DiagnosticsHeader {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly platform: string;
  readonly configPath: string;
  readonly controlHost: string;
  readonly controlPort: number;
  readonly controlPython: string;
  readonly debugPortBase: number;
  readonly activeSessions: readonly string[];
  readonly reservedPorts: readonly number[];
}

/**
 * Plain-text bundle meant to be pasted into a chat message. It is a paste
 * target, not a parser contract, so the raw detail always survives.
 */
export function formatDiagnosticsBundle(
  header: DiagnosticsHeader,
  attempts: readonly AttachAttemptRecord[],
): string {
  const tally = new Map<AttachCause, number>();
  for (const attempt of attempts) {
    if (attempt.outcome === "failed" && attempt.cause) {
      tally.set(attempt.cause, (tally.get(attempt.cause) ?? 0) + 1);
    }
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);

  const lines: string[] = [
    "AutoSurg Debug - attach diagnostics",
    `extension ${header.extensionVersion} | VS Code ${header.vscodeVersion} | ${header.platform}`,
    `config  ${header.configPath}`,
    `control ${header.controlHost}:${header.controlPort} (python: ${header.controlPython}, debugPortBase ${header.debugPortBase})`,
    `debugger sessions: ${header.activeSessions.length ? header.activeSessions.join(", ") : "none"}`,
    `reserved attach ports: ${header.reservedPorts.length ? header.reservedPorts.join(", ") : "none"}`,
    "",
  ];
  if (ranked.length > 0) {
    lines.push(
      `Failure causes: ${ranked
        .map(([cause, count]) => `${cause} x${count}`)
        .join(", ")}`,
    );
    if (ranked.length === 1) {
      // Repeating the same cause is actionable, so say it once, plainly.
      lines.push(
        `Hint: every failure here is "${ranked[0][0]}". ${adviceFor(ranked[0][0]).advice}`,
      );
    }
    lines.push("");
  }
  lines.push(`Last ${attempts.length} attach attempt(s), newest first:`);
  if (attempts.length === 0) {
    lines.push("  (no attach attempt recorded in this window session yet)");
  }
  for (const attempt of attempts) {
    const bits: string[] = [
      attempt.at,
      `${attempt.action}:${attempt.module}`,
      attempt.outcome,
    ];
    if (attempt.cause) {
      bits.push(attempt.cause);
    }
    if (attempt.endpoint) {
      bits.push(attempt.endpoint);
    }
    if (attempt.workerPid !== undefined) {
      bits.push(`pid ${attempt.workerPid}`);
    }
    if (attempt.already) {
      bits.push("already-listening");
    }
    if (attempt.ms !== undefined) {
      bits.push(`${attempt.ms}ms`);
    }
    lines.push(`  - ${bits.join(" | ")}`);
    if (attempt.detail) {
      lines.push(`      raw: ${collapse(attempt.detail)}`);
    }
    if (attempt.cause && attempt.outcome === "failed") {
      lines.push(`      advice: ${adviceFor(attempt.cause).advice}`);
    }
  }
  return lines.join("\n");
}

/**
 * Toast text: what happened, then what to do, then the cause chip.
 *
 * The advice is on purpose inside the toast - a failure the user cannot act on
 * without asking the extension author is the failure mode this whole path is
 * meant to remove. VS Code collapses notification text past roughly a thousand
 * characters, so the harness keeps hard headroom under that and the raw reply
 * stays in the bundle instead.
 */
export function formatFailureLine(module: string, failure: ClassifiedFailure): string {
  const advice = adviceFor(failure.cause);
  return `${module}: ${advice.summary}\n${advice.advice} [${failure.cause}]`;
}

/** Full text for the journal and the copied bundle. */
export function formatFailureDetail(failure: ClassifiedFailure): string {
  const advice = adviceFor(failure.cause);
  const detail = failure.detail.replace(/\s+/g, " ").slice(0, 300);
  return `${advice.summary} ${advice.advice} | raw: ${detail}`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 600);
}
