/**
 * Standalone ("dummy") compute debugging: the IDE-side half of
 * ``workers/run_compute_worker.py --dummy-shm``.
 *
 * The ControlPlane flows in ``extension.ts`` (Hot-Attach / Restart-Attach) all
 * need ``main.py`` running, because they talk to a worker the supervisor
 * already owns with real SHM attached. This module covers the other half of the
 * documented workflow (§13 / 方式 B of architecture.html): bring up *one* compute
 * worker by itself, seed its frame SHM from a disk image / video / noise, and
 * debug it under debugpy - no Gateway, no Orchestrator, no ingress, no GPU box.
 *
 * Two things make that awkward by hand, and they are what this module exists to
 * remove:
 *
 * 1. The invocation is a pile of flags that must agree with ``modules.yaml`` -
 *    the module's own interpreter (venv vs conda env), its ``env:`` block
 *    (``LL_MODEL_PATH`` / ``CUDA_VISIBLE_DEVICES`` ...), and the SHM keys it
 *    reads. Standalone startup injects none of that automatically.
 * 2. Compute loops are *request driven*. Seeding frames does not execute any
 *    business code, so a freshly attached debugger just sits there: something
 *    has to send a request to the endpoint the worker binds. Hence the sender.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseDocument } from "yaml";

type JsonMap = Record<string, unknown>;

/** A module entry as it appears under ``modules:`` in modules.yaml. */
interface YamlModule extends JsonMap {
  kind?: string;
  enabled?: boolean;
  python?: string;
  conda_env?: string;
  path_preset?: string;
  depends_on?: string[];
  env?: Record<string, string>;
  shm?: string | string[];
  compute_ipc_endpoint?: string;
}

interface DummyCatalog {
  /** repo ``system/`` dir - two levels up from ``config/modules.yaml``. */
  systemDir: string;
  configPath: string;
  modules: Record<string, YamlModule>;
  sharedMemory: Record<string, { kind?: string }>;
}

interface DummySession {
  module: string;
  /** ipc:// (or tcp://) address the standalone worker binds. */
  endpoint: string;
  interpreter: string;
  shmKeys: string[];
  frameSource: string;
  sessionName: string;
  /** repo ``system/`` dir - where ``compute/compute_<module>.py`` lives. */
  systemDir: string;
}

interface RequestResult {
  ok: boolean;
  reply?: unknown;
  binary?: { name: string; bytes: number }[];
  error?: string;
  timeout?: boolean;
}

interface PreflightProblem {
  code?: string;
  detail?: string;
  /** A smaller ``random:WxH`` spec that does fit, when one exists. */
  fits?: string;
  key?: string;
  source?: string;
}

interface PreflightReport {
  ok: boolean;
  code?: string | null;
  problems?: PreflightProblem[];
  segments?: Array<{
    key: string;
    kind?: string;
    slots?: number;
    maxDataSize?: number;
    bytesPerFrame?: number | null;
    segmentBytes?: number;
  }>;
  notes?: string[];
  estimate?: { segmentBytes?: number; shmAvailBytes?: number; sharePct?: number };
  error?: string;
}

const DEFAULT_ENDPOINT_DIR = "ipc:///tmp/autosurg/dummy";
/** Hard ceiling on one printed reply; see the trimming in dummy_request.py. */
const MAX_REQUEST_OUTPUT_BYTES = 8 * 1024 * 1024;
const CUSTOM_ACTION = "$(symbol-string) Custom JSON…";
/** Handled by the compute loop itself, so never offered as "business" actions. */
const FAST_ACTIONS = [
  "ping",
  "probe",
  "shutdown",
  "set_log_level",
  "get_latest",
  "start_debug",
  "debug_status",
];

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("autosurg");
}

export class DummyDebugSessions implements vscode.Disposable {
  private readonly sessions = new Map<string, DummySession>();
  private readonly output = vscode.window.createOutputChannel("AutoSurg Dummy", {
    log: true,
  });
  private readonly disposables: vscode.Disposable[] = [];
  /** Last module the user pointed at - target of the palette-only commands. */
  private lastModule: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configPath: string,
  ) {
    this.disposables.push(this.output);
    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession((session) => {
        for (const [name, record] of this.sessions) {
          if (record.sessionName === session.name) {
            this.sessions.delete(name);
            this.output.info(
              `dummy worker for ${name} exited (${record.endpoint}); its dummy SHM segments were unlinked on shutdown`,
            );
            if (this.sessions.size === 0) {
              void vscode.commands.executeCommand("setContext", "autosurg.dummyRunning", false);
            }
            // The user pressed Stop on the toolbar, so no command wrapper runs:
            // ask the tree to redraw or the endpoint badge would lie.
            void vscode.commands.executeCommand("autosurg.refresh");
          }
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Badge text for tree rows; undefined when the module has no dummy worker. */
  badgeFor(module: string): string | undefined {
    const record = this.sessions.get(module);
    return record ? `dummy @ ${shortEndpoint(record.endpoint)}` : undefined;
  }

  active(): DummySession[] {
    return [...this.sessions.values()];
  }

  // ---------------------------------------------------------------- startup

  async start(requested?: string): Promise<void> {
    const catalog = await this.loadCatalog();
    const name = requested ?? (await this.pickComputeModule(catalog));
    if (!name) {
      return;
    }
    const config = catalog.modules[name];
    if (!config) {
      throw new Error(`Module '${name}' is not present in ${catalog.configPath}.`);
    }
    if ((config.kind ?? "compute") !== "compute") {
      throw new Error(
        `Module '${name}' is kind '${String(config.kind)}'. Standalone dummy debugging only launches compute workers (run_compute_worker.py).`,
      );
    }

    const existing = this.sessions.get(name);
    if (existing) {
      const picked = await vscode.window.showWarningMessage(
        `${name} already has a dummy worker on ${existing.endpoint}.`,
        "Send Request",
        "Stop And Relaunch",
      );
      if (picked === "Send Request") {
        await this.send(name);
      } else if (picked === "Stop And Relaunch") {
        await this.stop(name);
        return this.start(name);
      }
      return;
    }

    const workerScript = path.join(catalog.systemDir, "workers", "run_compute_worker.py");
    if (!fs.existsSync(workerScript)) {
      throw new Error(
        `run_compute_worker.py not found at ${workerScript}. Check autosurg.configPath - the system dir is derived from it.`,
      );
    }

    const keys = await this.pickShmKeys(catalog, name, config);
    if (!keys) {
      return; // cancelled
    }
    const frameSource = await this.pickFrameSource(name, keys);
    if (frameSource === undefined) {
      return; // cancelled
    }
    const interpreter = await this.resolveInterpreter(catalog, config);
    if (!interpreter) {
      return;
    }

    const endpoint = this.endpointFor(config, name);
    await ensureEndpointDir(endpoint);

    // Cost asymmetry is the whole reason for this step: a bad frame spec costs a
    // full model load (minutes) and then a bare traceback, while probing the
    // specs costs a fraction of a second. See resources/dummy_preflight.py.
    const nFrames = settings().get<number>("dummyNFrames", 8);
    let specs = frameSpecsFor(keys, frameSource);
    if (specs.length > 0) {
      const verdict = await this.confirmPreflight(catalog, interpreter, specs, nFrames);
      if (!verdict.proceed) {
        return;
      }
      specs = verdict.specs;
    }

    const args = ["--module-name", name, "--endpoint", endpoint];
    for (const spec of specs) {
      args.push("--dummy-shm", spec);
    }
    if (nFrames > 0) {
      args.push("--dummy-n-frames", String(nFrames));
    }
    for (const extra of shellSplit(settings().get<string>("dummyExtraArgs", ""))) {
      args.push(extra);
    }

    // The module's yaml env block is what ManagedWorker would have injected;
    // standalone startup does not do it, so model paths / CUDA ids must be
    // replayed here or on_setup fails in a confusing way.
    const env: JsonMap = {};
    for (const [key, value] of Object.entries(config.env ?? {})) {
      // Those two are for supervisor-started workers that need an *attach*
      // listener. Here debugpy already traces the process from the launch
      // request, and relaying them makes infra/debugpy_runtime call listen()
      // a second time inside the same interpreter.
      if (key === "AUTOSURG_DEBUG_PORT" || key === "AUTOSURG_DEBUG_WAIT") {
        this.output.info(
          `dropped ${key} from the launch env - this session debugs via launch, not via an attach listener`,
        );
        continue;
      }
      env[key] = String(value);
    }
    env.AUTOSURG_MODULE_NAME = name;
    env.AUTOSURG_MODULES_CONFIG = catalog.configPath;
    // ``load_balance``/LB mode would make the worker connect to a broker
    // instead of binding --endpoint; standalone is always legacy ROUTER bind.
    env.AUTOSURG_LB_MODE = "";
    env.AUTOSURG_LB_BACKEND = "";
    env.PYTHONUNBUFFERED = "1";

    const frozen = keys.filter(
      (key) => catalog.sharedMemory[key]?.kind === "frozen_pool",
    );
    if (frozen.length > 0) {
      this.output.warn(
        `${frozen.join(", ")} is a frozen_pool in ${path.basename(catalog.configPath)}; --dummy-shm can only create ring buffers, so those keys stay unfaked`,
      );
    }
    const sessionName = `AutoSurg: dummy ${name}`;
    this.output.info(
      `launching ${interpreter} ${workerScript} ${args.join(" ")}\n  cwd=${catalog.systemDir}\n  env=${Object.keys(env).join(", ")}`,
    );

    const launched = await vscode.debug.startDebugging(undefined, {
      name: sessionName,
      type: "debugpy",
      request: "launch",
      program: workerScript,
      python: interpreter,
      args,
      env,
      cwd: catalog.systemDir,
      console: settings().get<string>("dummyConsole", "integratedTerminal"),
      justMyCode: false,
    } as vscode.DebugConfiguration);
    if (!launched) {
      throw new Error(
        "Could not start the debug session. Is the Python Debugger extension installed, and does the interpreter exist?",
      );
    }

    this.sessions.set(name, {
      module: name,
      endpoint,
      interpreter,
      shmKeys: keys,
      frameSource: specs.join(", ") || "none (degraded: no frame access)",
      sessionName,
      systemDir: catalog.systemDir,
    });
    this.lastModule = name;
    void vscode.commands.executeCommand("setContext", "autosurg.dummyRunning", true);

    const ready = await this.waitUntilReady(endpoint, interpreter);
    if (!ready) {
      void vscode.window
        .showWarningMessage(
          `${name} was launched but has not answered a ping yet. Model loading can take minutes - the terminal shows progress. If it died, the module's python / env block / SHM keys are the usual causes.`,
          "Send Request Anyway",
          "Show Dummy Output",
        )
        .then((picked) => {
          if (picked === "Send Request Anyway") {
            void this.send(name).catch((error) => fail(String(error)));
          } else if (picked === "Show Dummy Output") {
            this.output.show(true);
          }
        });
      return;
    }

    const picked = await vscode.window.showInformationMessage(
      `AutoSurg dummy worker ready: ${name} on ${endpoint} (${keys.length} dummy SHM key(s)). Breakpoints in compute/compute_${name}.py now need a request to hit - frames alone execute no business code.`,
      "Send Request",
      "Copy Command",
    );
    if (picked === "Send Request") {
      await this.send(name);
    } else if (picked === "Copy Command") {
      await vscode.env.clipboard.writeText(
        renderShellCommand(interpreter, workerScript, catalog.systemDir, env, args),
      );
      void vscode.window.showInformationMessage(
        "Equivalent standalone shell command copied - the same run reproducible outside the IDE.",
      );
    }
  }

  // --------------------------------------------------------------- requests

  async send(requested?: string, timeoutOverrideMs?: number): Promise<void> {
    const target = await this.pickTarget(requested);
    if (!target) {
      return;
    }
    const payload = await this.pickRequest(
      target.module,
      target.systemDir,
    );
    if (!payload) {
      return;
    }

    const timeoutMs =
      timeoutOverrideMs ??
      Math.max(1000, settings().get<number>("dummyRequestTimeoutMs", 30000));
    const result = await this.request(target.endpoint, payload, timeoutMs, target.interpreter);
    this.output.info(`-> ${target.module} ${JSON.stringify(payload)}`);
    if (result.ok) {
      this.output.info(`<-- ${JSON.stringify(result.reply ?? null, null, 2)}`);
      for (const bin of result.binary ?? []) {
        this.output.info(`<-- binary frame '${bin.name}' (${bin.bytes} bytes, not printed)`);
      }
      void vscode.window.showInformationMessage(
        `${target.module} replied to '${String(payload.action ?? "?")}'.`,
      );
      return;
    }

    this.output.error(`<-- ${result.error ?? "request failed"}`);
    if (result.timeout) {
      void vscode.window
        .showWarningMessage(
          `No reply from ${target.module} in ${timeoutMs} ms. If a breakpoint is suspended, the reply is blocked until you continue - then re-send.`,
          `Retry With ${timeoutMs * 4} ms`,
          "Show Dummy Output",
        )
        .then((picked) => {
          if (picked?.startsWith("Retry With")) {
            void this.send(target.module, timeoutMs * 4).catch((error) =>
              fail(String(error)),
            );
          } else if (picked === "Show Dummy Output") {
            this.output.show(true);
          }
        });
      return;
    }
    void vscode.window
      .showErrorMessage(
        `${target.module} request failed: ${result.error ?? "unknown error"}`,
        "Show Dummy Output",
      )
      .then((picked) => {
        if (picked === "Show Dummy Output") {
          this.output.show(true);
        }
      });
  }

  async stop(requested?: string): Promise<void> {
    const target = await this.pickTarget(requested, "Select the dummy worker to stop");
    if (!target) {
      return;
    }
    const session = findSession(target.sessionName);
    if (session) {
      await vscode.debug.stopDebugging(session);
    }
    this.sessions.delete(target.module);
    if (this.sessions.size === 0) {
      void vscode.commands.executeCommand("setContext", "autosurg.dummyRunning", false);
    }
    void vscode.window.showInformationMessage(
      `Stopped the dummy worker for ${target.module}. Ctrl+C on the terminal does the same; a SIGKILL instead leaves /dev/shm/autosurg_dummy_* to CPython's resource_tracker.`,
    );
  }

  private async pickTarget(
    requested: string | undefined,
    placeHolder = "Select the running dummy worker",
  ): Promise<DummySession | undefined> {
    const candidates = this.active();
    if (requested) {
      const hit = candidates.find((item) => item.module === requested);
      if (hit) {
        return hit;
      }
      if (candidates.length === 0) {
        throw new Error(
          "No dummy worker is running. Start one with 'AutoSurg: Dummy-Attach Compute' first.",
        );
      }
      void vscode.window.showInformationMessage(
        `${requested} has no dummy worker; picking among ${candidates.map((item) => item.module).join(", ")}.`,
      );
    }
    if (candidates.length === 0) {
      throw new Error(
        "No dummy worker is running. Start one with 'AutoSurg: Dummy-Attach Compute' first.",
      );
    }
    if (candidates.length === 1) {
      return candidates[0];
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((item) => ({
        label: item.module,
        description: shortEndpoint(item.endpoint),
        detail: `${item.shmKeys.length} dummy SHM key(s) · frames from ${item.frameSource}`,
        item,
      })),
      { placeHolder },
    );
    return picked?.item;
  }

  private async pickRequest(
    module: string,
    systemDir: string,
  ): Promise<JsonMap | undefined> {
    const history = this.remembered<string[]>(`dummy.actions.${module}`, []);
    const known = await discoverActions(systemDir, module);
    const names = [...new Set(["ping", "probe", ...known, ...history])].filter(
      (name) => !name.startsWith("{"),
    );
    const recent = history.filter((item) => item.startsWith("{"));
    const picked = await vscode.window.showQuickPick(
      [
        ...names.map((name) => ({
          label: name,
          description:
            name === "ping"
              ? "fast action, never blocks the worker"
              : known.includes(name)
                ? "declared in this module"
                : undefined,
        })),
        ...recent.map((raw) => ({ label: shorten(raw, 70), description: "recent custom request" })),
        { label: CUSTOM_ACTION },
      ],
      { placeHolder: `Request to send to the ${module} dummy worker` },
    );
    if (!picked) {
      return undefined;
    }
    let raw = picked.label;
    if (raw === CUSTOM_ACTION) {
      raw =
        (await vscode.window.showInputBox({
          prompt: `JSON request for ${module}. Remember: an unrecognised action usually answers an error rather than running business code.`,
          value: recent[0] ?? `{"action": "${module}_ping"}`,
          validateInput: (text) => {
            try {
              const parsed = JSON.parse(text) as unknown;
              return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? undefined
                : "expected a JSON object";
            } catch {
              return "invalid JSON";
            }
          },
        }) ?? "")
          .trim();
      if (!raw) {
        return undefined;
      }
    }
    let payload: JsonMap;
    try {
      payload = JSON.parse(raw) as JsonMap;
    } catch {
      payload = { action: raw };
    }

    const next = [...new Set([raw, ...history])].slice(0, 6);
    await this.context.workspaceState.update(`dummy.actions.${module}`, next);
    return payload;
  }

  // ------------------------------------------------------------- resolution

  private async loadCatalog(): Promise<DummyCatalog> {
    const text = await fs.promises.readFile(this.configPath, "utf8");
    const raw = (parseDocument(text, { uniqueKeys: false }).toJS() ?? {}) as JsonMap;
    return {
      systemDir: path.dirname(path.dirname(this.configPath)),
      configPath: this.configPath,
      modules: record<YamlModule>(raw.modules),
      sharedMemory: record<{ kind?: string }>(raw.shared_memory),
    };
  }

  private async pickComputeModule(catalog: DummyCatalog): Promise<string | undefined> {
    const entries = Object.entries(catalog.modules).filter(
      ([, config]) => (config.kind ?? "compute") === "compute",
    );
    if (entries.length === 0) {
      throw new Error(`No compute modules in ${catalog.configPath}.`);
    }
    const picked = await vscode.window.showQuickPick(
      entries.map(([name, config]) => ({
        label: name,
        description: config.enabled === false ? "disabled in yaml" : "enabled",
        detail: interpreterHint(config),
      })),
      { placeHolder: "Debug which compute module standalone (with dummy frames)?" },
    );
    return picked?.label;
  }

  /**
   * SHM keys to seed. ``--dummy-shm KEY`` and ``--shm KEY`` are mutually
   * exclusive per key, so this list is exactly the frame sources the module
   * reads; keys are derived from the ingress modules it ``depends_on``.
   */
  private async pickShmKeys(
    catalog: DummyCatalog,
    module: string,
    config: YamlModule,
  ): Promise<string[] | undefined> {
    const declared = settings().get<string>("dummyShmKeys", "").trim();
    if (declared) {
      return declared.split(/[,\s]+/).filter(Boolean).map((key) => key.trim());
    }

    const derived = new Set<string>();
    for (const dependency of config.depends_on ?? []) {
      const shm = catalog.modules[dependency]?.shm;
      for (const name of Array.isArray(shm) ? shm : shm ? [shm] : []) {
        derived.add(String(name));
      }
    }
    const known = Object.keys(catalog.sharedMemory);
    const options = [...new Set([...derived, ...known])].map((key) => {
      const configured = known.includes(key);
      const notes: string[] = [];
      if (catalog.sharedMemory[key]?.kind === "frozen_pool") {
        notes.push(
          "frozen_pool: --dummy-shm only creates rings, so this key stays unfaked (attach the real segment via autosurg.dummyExtraArgs instead)",
        );
      }
      if (!configured) {
        notes.push(
          "not in shared_memory: the buffer is still created, but no module reads that name - check for a typo",
        );
      }
      if (key === "shm_action_buffer") {
        notes.push(
          "holds action JSON (joints: [0]*6); an image/video source is ignored for this key",
        );
      }
      return {
        label: key,
        picked: derived.has(key),
        description: !configured
          ? "not configured in yaml"
          : derived.has(key)
            ? "read by this module (depends_on)"
            : "configured in yaml",
        detail: notes.join(" · ") || undefined,
      };
    });

    const remembered = this.remembered<string[]>(`dummy.keys.${module}`, []);
    if (remembered.length > 0) {
      for (const option of options) {
        option.picked = remembered.includes(option.label);
      }
    }

    const picked = await vscode.window.showQuickPick(options, {
      canPickMany: true,
      placeHolder:
        "Which dummy SHM keys to seed? (pre-selected from depends_on; pick nothing for no frame access)",
      matchOnDescription: true,
      matchOnDetail: true,
      title: `${module} · dummy frame buffers`,
    });
    if (!picked) {
      return undefined;
    }
    const keys = picked.map((item) => item.label);
    await this.context.workspaceState.update(`dummy.keys.${module}`, keys);
    return keys;
  }

  /** ``KEY[=SOURCE]`` specs handed to the repeatable ``--dummy-shm`` flag. */
  private async pickFrameSource(
    module: string,
    keys: string[],
  ): Promise<string | undefined> {
    if (keys.length === 0) {
      // A frameless module (calib) is legitimate: no keys means the worker runs
      // without frame access, which the worker itself warns about.
      return "";
    }
    const remembered = this.remembered<string>(`dummy.source.${module}`, "");
    const configured = settings().get<string>("dummyFrameSource", "").trim();
    const preferred = configured || remembered;
    const items: vscode.QuickPickItem[] = [
      ...(preferred
        ? [
            {
              label: `$(gear) ${preferred}`,
              description: configured
                ? "from autosurg.dummyFrameSource"
                : "last used for this module",
            },
          ]
        : []),
      {
        label: "$(zap) random",
        description: remembered === "random" ? "last used" : "production frame size",
        detail:
          "1920×1080 side-by-side noise JPEG, ~2.9 MB per frame - the size production actually carries. Slot geometry is taken verbatim from modules.yaml, so this is closest to what a real ingress delivers",
      },
      {
        label: "$(zap) random:960x540",
        description: remembered === "random:960x540" ? "last used" : "for a small /dev/shm",
        detail:
          "~0.7 MB per frame. Segment size is capacity × max_data_size straight from modules.yaml (≈0.5 GB per frame key with the shipped config), so shrink the frame when the container only has a few MB of shared memory",
      },
      { label: "$(device-camera) image…", detail: "still JPEG/PNG from disk, repeated per slot" },
      { label: "$(file-media) video…", detail: "first N frames of an mp4/mov/avi" },
      { label: "$(symbol-string) custom spec…", detail: "random:WxH[:mono] or an absolute path" },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Dummy frame source for the compute worker",
      title: `${module} · frame source for ${keys.join(", ")}`,
    });
    if (!picked) {
      return undefined;
    }

    let source = "random";
    if (picked.label.startsWith("$(gear)")) {
      source = preferred;
    } else if (picked.label.includes("image…") || picked.label.includes("video…")) {
      const wantVideo = picked.label.includes("video…");
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: wantVideo
          ? "Dummy frames: pick a video (first N frames are used)"
          : "Dummy frames: pick a still image (SBS for stereo/tracker)",
        filters: wantVideo
          ? { Video: ["mp4", "avi", "mov", "mkv", "webm", "m4v"] }
          : { Image: ["jpg", "jpeg", "png", "bmp", "tif", "tiff", "webp"] },
      });
      const file = uris?.[0]?.fsPath;
      if (!file) {
        return undefined;
      }
      source = file;
    } else if (picked.label.includes("random:960x540")) {
      source = "random:960x540";
    } else if (picked.label.includes("random")) {
      source = "random";
    } else if (picked.label.includes("custom spec…")) {
      const typed = await vscode.window.showInputBox({
        prompt: "random | random:WxH[:mono] | /abs/path/image.jpg | /abs/path/clip.mp4",
        value: remembered || "random",
      });
      if (!typed) {
        return undefined;
      }
      source = typed.trim();
    }

    await this.context.workspaceState.update(`dummy.source.${module}`, source);
    return source;
  }

  /** Mirror of module_registry.resolve_python / resolve_conda_python. */
  private async resolveInterpreter(
    catalog: DummyCatalog,
    config: YamlModule,
  ): Promise<string | undefined> {
    const declared = String(config.python ?? "").trim();
    if (declared && declared !== "${MAIN_PYTHON}") {
      const candidate = path.isAbsolute(declared)
        ? declared
        : path.resolve(catalog.systemDir, declared);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      void vscode.window.showWarningMessage(
        `modules.yaml says '${declared}' for this module but it does not exist (${candidate}).`,
      );
    }

    const envName = String(config.conda_env ?? "").trim();
    if (envName) {
      const resolved = resolveCondaPython(envName);
      if (resolved) {
        return resolved;
      }
      const picked = await vscode.window.showWarningMessage(
        `Could not resolve conda env '${envName}'. Pick the interpreter to launch this worker with.`,
        "Browse…",
      );
      if (picked !== "Browse…") {
        return undefined;
      }
    } else {
      return settings().get<string>("controlPython", "python3");
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: "Python interpreter for the standalone compute worker",
    });
    return uris?.[0]?.fsPath;
  }

  private endpointFor(config: YamlModule, module: string): string {
    const base = (
      settings().get<string>("dummyEndpointDir", DEFAULT_ENDPOINT_DIR) ||
      DEFAULT_ENDPOINT_DIR
    ).replace(/\/+$/, "");
    const declared = String(config.compute_ipc_endpoint ?? "").trim();
    const scheme = base.split("://")[0];
    if (declared && declared.startsWith(`${scheme}://`)) {
      // Keep the module's own socket name so a hand-written client from the
      // docs still works; only the directory moves under the dummy prefix.
      return `${base}/${declared.split("/").pop()}`;
    }
    return `${base}/${module}.rep.sock`;
  }

  private async waitUntilReady(endpoint: string, interpreter: string): Promise<boolean> {
    const seconds = Math.max(5, settings().get<number>("dummyReadyTimeoutS", 180));
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "AutoSurg: waiting for the dummy compute worker",
        cancellable: true,
      },
      async (_progress, token) => {
        const deadline = Date.now() + seconds * 1000;
        while (Date.now() < deadline && !token.isCancellationRequested) {
          const probe = await this.request(endpoint, { action: "ping" }, 1200, interpreter);
          if (probe.ok) {
            this.output.info(`dummy worker answered ping on ${endpoint}`);
            return true;
          }
          await sleep(1500);
        }
        return false;
      },
    );
  }

  private request(
    endpoint: string,
    payload: JsonMap,
    timeoutMs: number,
    interpreter: string,
  ): Promise<RequestResult> {
    const script = path.join(this.context.extensionPath, "resources", "dummy_request.py");
    return new Promise((resolve) => {
      const child = childProcess.spawn(
        interpreter,
        [script, endpoint, JSON.stringify(payload), String(timeoutMs)],
        { cwd: path.dirname(path.dirname(this.configPath)) },
      );
      let stdout = "";
      let stderr = "";
      let overflow = false;
      // A business reply can carry a base64 frame (megabytes). dummy_request.py
      // already trims long strings; this is the hard belt so a pathological
      // handler cannot grow the extension host's heap.
      child.stdout.on("data", (data) => {
        if (stdout.length > MAX_REQUEST_OUTPUT_BYTES) {
          overflow = true;
          child.kill();
          return;
        }
        stdout += String(data);
      });
      child.stderr.on("data", (data) => (stderr += String(data).slice(0, 8192)));
      child.on("error", (error) =>
        resolve({ ok: false, error: `could not run ${interpreter}: ${String(error)}` }),
      );
      child.on("close", (code) => {
        if (overflow) {
          resolve({
            ok: false,
            error: `reply exceeded ${MAX_REQUEST_OUTPUT_BYTES} bytes and was killed - the handler returned something enormous`,
          });
          return;
        }
        // The client prints one JSON envelope; skip any log line printed before it
        // instead of reporting that line as "unparsable client output".
        const line = stdout
          .split("\n")
          .map((raw) => raw.trim())
          .filter((raw) => raw.startsWith("{"))
          .pop();
        if (!line) {
          resolve({
            ok: false,
            error: stderr.trim() || `request client exited with code ${String(code)}`,
          });
          return;
        }
        try {
          resolve(JSON.parse(line) as RequestResult);
        } catch {
          resolve({ ok: false, error: `unparsable client output: ${shorten(line, 300)}` });
        }
      });
      // Never outlive the request window by much: a hung DEALER would leak a
      // python process per ping attempt in the readiness loop.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }, timeoutMs + 5000);
    });
  }

  private remembered<T>(key: string, fallback: T): T {
    return this.context.workspaceState.get<T>(key, fallback);
  }

  /**
   * Probe the dummy frame specs before spending a model load on them. Exit codes
   * and problem codes are defined in ``resources/dummy_preflight.py``.
   */
  private preflight(
    catalog: DummyCatalog,
    interpreter: string,
    specs: string[],
    nFrames: number,
  ): Promise<PreflightReport> {
    const script = path.join(this.context.extensionPath, "resources", "dummy_preflight.py");
    return new Promise((resolve) => {
      const child = childProcess.spawn(
        interpreter,
        // --config matters: the worker is launched with this exact yaml and slot
        // geometry now comes straight from it, so measuring the repo default here
        // would validate specs against a different size policy than the launch uses.
        [script, catalog.systemDir, String(nFrames), `--config=${catalog.configPath}`, ...specs],
        { cwd: catalog.systemDir },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => (stdout += String(data)));
      child.stderr.on("data", (data) => (stderr += String(data)));
      child.on("error", (error) =>
        resolve({
          ok: false,
          code: "DUMMY_ENVIRONMENT",
          error: `could not run the frame pre-flight: ${String(error)}`,
        }),
      );
      child.on("close", () => {
        // Last JSON line, not merely the last line: importing the worker's modules
        // can log to stdout, which would otherwise be called "unparsable output".
        const line = stdout
          .split("\n")
          .map((raw) => raw.trim())
          .filter((raw) => raw.startsWith("{"))
          .pop();
        if (!line) {
          resolve({
            ok: false,
            code: "DUMMY_ENVIRONMENT",
            error: stderr.trim() || "the frame pre-flight produced no output",
          });
          return;
        }
        try {
          resolve(JSON.parse(line) as PreflightReport);
        } catch {
          resolve({
            ok: false,
            code: "DUMMY_ENVIRONMENT",
            error: `unparsable pre-flight output: ${shorten(line, 240)}`,
          });
        }
      });
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }, 90_000);
    });
  }

  /**
   * Run the pre-flight and, when the source is merely oversized, offer the
   * smaller spec ``runtime/dummy_shm`` itself accepts. An unusable pre-flight
   * (e.g. no cv2 in this interpreter) must not become a reason the whole entry
   * cannot be used, so it warns and lets the launch continue.
   */
  private async confirmPreflight(
    catalog: DummyCatalog,
    interpreter: string,
    specs: string[],
    nFrames: number,
    attempt = 1,
  ): Promise<{ proceed: boolean; specs: string[] }> {
    if (!settings().get<boolean>("dummyPreflight", true)) {
      return { proceed: true, specs };
    }
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "AutoSurg: checking the dummy frame specs",
      },
      () => this.preflight(catalog, interpreter, specs, nFrames),
    );
    this.output.info(`pre-flight ${specs.join(", ")} -> ${JSON.stringify(report)}`);
    if (report.ok) {
      for (const note of report.notes ?? []) {
        this.output.info(`pre-flight: ${note}`);
      }
      const bytes = report.estimate?.segmentBytes ?? 0;
      if (bytes > 128 * 1024 * 1024) {
        this.output.info(
          `pre-flight: dummy segments will take ${(bytes / 1048576).toFixed(0)} MB of /dev/shm ` +
            `(capacity × max_data_size straight from ${path.basename(catalog.configPath)})`,
        );
      }
      return { proceed: true, specs };
    }

    const detail =
      [
        ...(report.problems ?? []).map((problem) => problem.detail ?? problem.code ?? ""),
        report.error ?? "",
      ]
        .filter(Boolean)
        .join(" | ") || "the frame pre-flight failed for an unknown reason";
    const problem = (report.problems ?? [])[0];
    const fixed =
      problem?.fits && problem.key ? `${problem.key}=${problem.fits}` : undefined;
    const buttons = [
      ...(fixed && attempt <= 3 ? [`Retry With ${fixed}`] : []),
      "Show Details",
      "Launch Anyway",
    ];
    const picked = await vscode.window.showErrorMessage(
      `Dummy frames rejected before launch: ${detail}`,
      ...buttons,
    );
    if (fixed && picked === `Retry With ${fixed}`) {
      const next = specs.map((spec) =>
        spec.split("=")[0] === problem?.key ? fixed : spec,
      );
      return this.confirmPreflight(catalog, interpreter, next, nFrames, attempt + 1);
    }
    if (picked === "Show Details") {
      this.output.show(true);
      return { proceed: false, specs };
    }
    if (picked === "Launch Anyway") {
      this.output.warn("launching despite a failed frame pre-flight, at the user's request");
      return { proceed: true, specs };
    }
    return { proceed: false, specs };
  }
}

// ------------------------------------------------------------------ helpers

function record<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function fail(message: string): void {
  void vscode.window.showErrorMessage(`AutoSurg dummy: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allDebugSessions(): readonly vscode.DebugSession[] {
  const api = vscode.debug as typeof vscode.debug & {
    activeDebugSessions?: readonly vscode.DebugSession[];
  };
  return (
    api.activeDebugSessions ?? (api.activeDebugSession ? [api.activeDebugSession] : [])
  );
}

function findSession(name: string): vscode.DebugSession | undefined {
  return allDebugSessions().find((session) => session.name === name);
}

function resolveCondaPython(envName: string): string | undefined {
  const prefix = process.env.CONDA_PREFIX;
  if (prefix && path.basename(prefix) === envName) {
    const hit = path.join(prefix, "bin", "python");
    if (fs.existsSync(hit)) {
      return hit;
    }
  }
  const roots: string[] = [];
  if (process.env.CONDA_EXE) {
    roots.push(path.dirname(path.dirname(process.env.CONDA_EXE)));
  }
  roots.push(
    path.join(os.homedir(), "miniconda3"),
    path.join(os.homedir(), "anaconda3"),
    "/opt/conda",
  );
  for (const root of roots) {
    const hit = path.join(root, "envs", envName, "bin", "python");
    if (fs.existsSync(hit)) {
      return hit;
    }
  }
  return undefined;
}

function interpreterHint(config: YamlModule): string {
  if (config.conda_env) {
    return `conda env ${config.conda_env}`;
  }
  if (config.python) {
    return String(config.python);
  }
  return "system python";
}

function ipcPath(endpoint: string): string | undefined {
  return endpoint.startsWith("ipc://") ? endpoint.slice("ipc://".length) : undefined;
}

/** ``KEY[=SOURCE]`` for every key; a plain ``random`` source keeps the bare KEY form. */
function frameSpecsFor(keys: string[], source: string): string[] {
  return keys.map((key) => (source === "random" || source === "" ? key : `${key}=${source}`));
}

async function ensureEndpointDir(endpoint: string): Promise<void> {
  const file = ipcPath(endpoint);
  if (!file) {
    return;
  }
  // zmq creates the socket node but not its parent directory.
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
}

function shortEndpoint(endpoint: string): string {
  return endpoint.replace(/^ipc:\/\/\/tmp\/autosurg\//, "ipc:/…/");
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Quote-free splitting honouring single/double quotes; for the extra-args setting. */
function shellSplit(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) {
    out.push(current);
  }
  return out;
}

function renderShellCommand(
  interpreter: string,
  script: string,
  cwd: string,
  env: JsonMap,
  args: string[],
): string {
  const envText = Object.entries(env)
    .filter(([key]) => !key.startsWith("AUTOSURG_LB") && key !== "PYTHONUNBUFFERED")
    .map(([key, value]) => `${key}=${quoteShell(String(value))}`)
    .join(" ");
  return [
    `cd ${quoteShell(cwd)} &&`,
    envText ? `${envText} \\` : "",
    `${quoteShell(interpreter)} ${quoteShell(script)} \\`,
    args.map((arg) => `  ${quoteShell(arg)}`).join(" \\\n"),
  ]
    .filter(Boolean)
    .join(" ");
}

function quoteShell(value: string): string {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

/**
 * Business action names declared in ``compute/compute_<module>.py``, so the
 * sender offers more than ping/probe. Best-effort: the worker answers unknown
 * actions with an error, and an example request for only ``ping`` proves
 * attach-only debug sessions are actually idle - seeing real action names is
 * what makes the request picker useful.
 */
const actionCache = new Map<string, string[]>();

async function discoverActions(
  systemDir: string,
  module: string,
): Promise<string[]> {
  const cached = actionCache.get(module);
  if (cached) {
    return cached;
  }
  const candidate = path.join(systemDir, "compute", `compute_${module}.py`);
  let text: string;
  try {
    text = await fs.promises.readFile(candidate, "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  const patterns = [
    /action\s*(?:==|!=|in)\s*\(?\s*["']([A-Za-z0-9_]+)["']/g,
    /action\s*=\s*["']([A-Za-z0-9_]+)["']/g,
    /["']([A-Za-z0-9_]+)["']\s*(?:in|not in)\s*action/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (!FAST_ACTIONS.includes(name)) {
        names.add(name);
      }
    }
  }
  const found = [...names].slice(0, 12);
  actionCache.set(module, found);
  return found;
}
