import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import { LineCounter, parseDocument } from "yaml";
import { registerTensorView } from "./tensorView";
import { registerPlyView } from "./plyView";

type JsonMap = Record<string, unknown>;

interface ModuleConfig extends JsonMap {
  kind?: string;
  enabled?: boolean;
  python?: string;
  conda_env?: string;
  path_preset?: string;
  depends_on?: string[];
  env?: Record<string, string>;
  client_port?: number;
}

interface AutoSurgConfig {
  modules: Record<string, ModuleConfig>;
  orchestrators: Record<string, JsonMap>;
  pathPresets: Record<string, string[]>;
}

interface RuntimeItem {
  name: string;
  kind: string;
  type: string;
  enabled?: boolean;
  running?: boolean;
  restarting?: boolean;
  restartable?: boolean;
  ready?: boolean;
  replica_count?: number;
}

interface ControlOptions {
  force?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  debugPort?: number;
  debugHost?: string;
}

type NodeKind = "category" | "module" | "compute" | "orchestrator";

class AutoSurgNode extends vscode.TreeItem {
  constructor(
    readonly nodeKind: NodeKind,
    readonly name: string,
    readonly config?: ModuleConfig | JsonMap,
    readonly runtime?: RuntimeItem,
    readonly children: AutoSurgNode[] = [],
  ) {
    super(
      name,
      nodeKind === "category"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    if (nodeKind === "category") {
      this.contextValue = "autosurg.category";
      return;
    }

    const isRestartable = runtime?.restartable !== false;
    this.contextValue = `autosurg.${nodeKind}.${isRestartable ? "ok" : "locked"}`;
    const isRunning = runtime?.running === true;
    const isRestarting = runtime?.restarting === true;
    this.iconPath = new vscode.ThemeIcon(
      isRestarting ? "sync~spin" : isRunning ? "debug-start" : "circle-outline",
      isRunning ? new vscode.ThemeColor("testing.iconPassed") : undefined,
    );

    const details: string[] = [];
    if (isRestarting) {
      details.push("restarting");
    } else {
      details.push(isRunning ? "running" : "stopped");
    }
    if (nodeKind === "compute" && runtime?.replica_count !== undefined) {
      details.push(`${runtime.replica_count} replica`);
    }
    if (!isRestartable) {
      details.push("not restartable");
    }
    this.description = details.join(" · ");
    this.tooltip = buildTooltip(name, nodeKind, config, runtime);
  }
}

function buildTooltip(
  name: string,
  nodeKind: NodeKind,
  config?: ModuleConfig | JsonMap,
  runtime?: RuntimeItem,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${name}**\n\n`);
  tooltip.appendMarkdown(`Type: \`${nodeKind}\`\n\n`);
  if (config && "python" in config && config.python) {
    tooltip.appendMarkdown(`Python: \`${String(config.python)}\`\n\n`);
  }
  if (config && "conda_env" in config && config.conda_env) {
    tooltip.appendMarkdown(`Conda: \`${String(config.conda_env)}\`\n\n`);
  }
  if (config && "path_preset" in config && config.path_preset) {
    tooltip.appendMarkdown(`Path preset: \`${String(config.path_preset)}\`\n\n`);
  }
  if (runtime) {
    tooltip.appendMarkdown(`Runtime: \`${runtime.running ? "running" : "stopped"}\``);
  }
  return tooltip;
}

class AutoSurgTreeProvider implements vscode.TreeDataProvider<AutoSurgNode> {
  private readonly changed = new vscode.EventEmitter<AutoSurgNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private config: AutoSurgConfig = emptyConfig();
  private runtime = new Map<string, RuntimeItem>();

  constructor(
    private readonly configPath: string,
    private readonly control: ControlClient,
  ) {}

  async refresh(): Promise<void> {
    this.config = await loadConfig(this.configPath);
    try {
      const response = await this.control.request("list");
      const items = Array.isArray(response.items) ? response.items : [];
      this.runtime = new Map(
        items
          .filter(isRuntimeItem)
          .map((item) => [item.name, item]),
      );
    } catch {
      this.runtime.clear();
    }
    this.changed.fire(undefined);
  }

  getTreeItem(element: AutoSurgNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AutoSurgNode): AutoSurgNode[] {
    if (element?.nodeKind === "category") {
      return element.children;
    }
    if (element) {
      return [];
    }

    const computes: AutoSurgNode[] = [];
    const otherModules: AutoSurgNode[] = [];
    for (const [name, config] of Object.entries(this.config.modules)) {
      const kind = config.kind ?? "compute";
      const nodeKind: NodeKind = kind === "compute" ? "compute" : "module";
      const node = new AutoSurgNode(
        nodeKind,
        name,
        config,
        this.runtime.get(name),
      );
      (kind === "compute" ? computes : otherModules).push(node);
    }

    const orchestrators = Object.entries(this.config.orchestrators).map(
      ([name, config]) =>
        new AutoSurgNode(
          "orchestrator",
          name,
          config,
          this.runtime.get(name),
        ),
    );

    return [
      new AutoSurgNode("category", "Compute", undefined, undefined, computes),
      new AutoSurgNode(
        "category",
        "Orchestrators",
        undefined,
        undefined,
        orchestrators,
      ),
      new AutoSurgNode(
        "category",
        "Infrastructure",
        undefined,
        undefined,
        otherModules,
      ),
    ];
  }

  async pickDebuggable(
    kinds?: NodeKind[],
  ): Promise<AutoSurgNode | undefined> {
    const allowed = kinds ?? ["compute", "orchestrator"];
    const candidates = this.getChildren()
      .flatMap((category) => category.children)
      .filter((node) => allowed.includes(node.nodeKind));
    const selected = await vscode.window.showQuickPick(
      candidates.map((node) => ({
        label: node.name,
        description: node.nodeKind,
        node,
      })),
      { placeHolder: "Select an AutoSurg module to debug" },
    );
    return selected?.node;
  }

  runtimeFor(name: string): RuntimeItem | undefined {
    return this.runtime.get(name);
  }

  computeNodes(): AutoSurgNode[] {
    const computeCategory = this.getChildren().find(
      (node) => node.name === "Compute",
    );
    return (computeCategory?.children ?? []).filter(
      (node) =>
        (node.config as ModuleConfig | undefined)?.enabled !== false ||
        node.runtime?.running === true,
    );
  }
}

class ControlClient {
  readonly systemDir: string;
  private readonly scriptPath: string;

  constructor(
    private readonly configPath: string,
    private readonly port: number,
  ) {
    this.systemDir = path.dirname(path.dirname(configPath));
    this.scriptPath = path.join(
      this.systemDir,
      "dbg_tools",
      "control_client.py",
    );
  }

  request(
    action: string,
    module?: string,
    options?: ControlOptions,
  ): Promise<JsonMap> {
    return new Promise((resolve, reject) => {
      const process = this.spawn(action, module, options);
      let stdout = "";
      let stderr = "";
      process.stdout.on("data", (data) => {
        stdout += String(data);
      });
      process.stderr.on("data", (data) => {
        stderr += String(data);
      });
      process.on("error", reject);
      process.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `Exit code ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as JsonMap);
        } catch {
          reject(new Error(`Invalid ControlPlane response: ${stdout}`));
        }
      });
    });
  }

  spawn(
    action: string,
    module?: string,
    options?: ControlOptions,
  ): childProcess.ChildProcessWithoutNullStreams {
    const settings = vscode.workspace.getConfiguration("autosurg");
    const python = settings.get<string>("controlPython", "python3");
    const host = settings.get<string>("controlHost", "localhost");
    const args = [
      this.scriptPath,
      "--host",
      host,
      "--port",
      String(this.port),
      "--timeout-ms",
      String(options?.timeoutMs ?? 10000),
      action,
      "--json",
    ];
    if (module) {
      args.push("--module", module);
    }
    if (options?.force) {
      args.push("--force");
    }
    if (options?.debugPort !== undefined) {
      args.push("--debug-port", String(options.debugPort));
    }
    if (options?.debugHost) {
      args.push("--debug-host", options.debugHost);
    }
    for (const [key, value] of Object.entries(options?.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    return childProcess.spawn(python, args, {
      cwd: this.systemDir,
      env: { ...process.env, AUTOSURG_MODULES_CONFIG: this.configPath },
    });
  }
}

class ConfigurationDiagnostics {
  private readonly collection =
    vscode.languages.createDiagnosticCollection("autosurg");

  constructor(private readonly configPath: string) {}

  dispose(): void {
    this.collection.dispose();
  }

  async validate(showResult = false): Promise<void> {
    const uri = vscode.Uri.file(this.configPath);
    let text: string;
    try {
      text = await fs.promises.readFile(this.configPath, "utf8");
    } catch (error) {
      this.collection.set(uri, [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `Cannot read modules.yaml: ${String(error)}`,
          vscode.DiagnosticSeverity.Error,
        ),
      ]);
      return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const lineCounter = new LineCounter();
    const document = parseDocument(text, {
      lineCounter,
      uniqueKeys: true,
    });

    for (const error of document.errors) {
      const start = lineCounter.linePos(error.pos[0]);
      const end = lineCounter.linePos(error.pos[1] ?? error.pos[0] + 1);
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            start.line - 1,
            start.col - 1,
            end.line - 1,
            end.col - 1,
          ),
          error.message,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }

    if (document.errors.length === 0) {
      const raw = (document.toJS() ?? {}) as JsonMap;
      addSemanticDiagnostics(raw, diagnostics);
    }

    this.collection.set(uri, diagnostics);
    if (showResult) {
      if (diagnostics.length === 0) {
        void vscode.window.showInformationMessage(
          "AutoSurg configuration is valid.",
        );
      } else {
        void vscode.window.showWarningMessage(
          `AutoSurg found ${diagnostics.length} configuration issue(s).`,
        );
        await vscode.window.showTextDocument(uri);
      }
    }
  }
}

function addSemanticDiagnostics(
  raw: JsonMap,
  diagnostics: vscode.Diagnostic[],
): void {
  const modules = asRecord<ModuleConfig>(raw.modules);
  const presets = asRecord<string[]>(raw.path_presets);
  const range = new vscode.Range(0, 0, 0, 1);

  for (const [name, config] of Object.entries(modules)) {
    const kind = config.kind ?? "compute";
    if (!["ingress", "compute", "gateway"].includes(kind)) {
      diagnostics.push(
        new vscode.Diagnostic(
          range,
          `Module '${name}' has invalid kind '${kind}'.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
    for (const dependency of config.depends_on ?? []) {
      if (!(dependency in modules)) {
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `Module '${name}' depends on unknown module '${dependency}'.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }
    if (config.path_preset && !(config.path_preset in presets)) {
      diagnostics.push(
        new vscode.Diagnostic(
          range,
          `Module '${name}' uses unknown path preset '${config.path_preset}'.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
  }
}

type ComputeDebugMode = "hot" | "restart";

const activeDebugStarts = new Set<string>();
const reservedDebugPorts = new Set<number>();
const activeDebugSessionNames = new Set<string>();

const ORCHESTRATOR_ATTACH_PREFIX = "AutoSurg: orchestrator (";

function isMainProcessDebugSession(name: string): boolean {
  return (
    name === "AutoSurg: Full System" ||
    name.startsWith(ORCHESTRATOR_ATTACH_PREFIX)
  );
}

function isMainProcessAttached(): boolean {
  return [...activeDebugSessionNames].some(isMainProcessDebugSession);
}

async function debugNode(
  node: AutoSurgNode | undefined,
  provider: AutoSurgTreeProvider,
  control: ControlClient,
  configPath: string,
  mode: ComputeDebugMode | "orchestrator" = "orchestrator",
): Promise<void> {
  const kinds: NodeKind[] =
    mode === "orchestrator"
      ? ["orchestrator"]
      : mode === "hot"
        ? ["compute", "orchestrator"]
        : ["compute"];
  const target = node ?? (await provider.pickDebuggable(kinds));
  if (!target) {
    return;
  }

  if (activeDebugStarts.has(target.name)) {
    void vscode.window.showInformationMessage(
      `${target.name} is already waiting for a debugger.`,
    );
    return;
  }

  activeDebugStarts.add(target.name);
  try {
    await debugTarget(target, provider, control, configPath, mode);
  } finally {
    activeDebugStarts.delete(target.name);
  }
}

async function debugTarget(
  target: AutoSurgNode,
  provider: AutoSurgTreeProvider,
  control: ControlClient,
  configPath: string,
  mode: ComputeDebugMode | "orchestrator",
): Promise<void> {
  if (target.nodeKind === "orchestrator") {
    if (mode === "restart") {
      throw new Error("Restart-Attach applies to Compute modules only.");
    }
    if (mode === "hot") {
      await hotAttachTarget(target, provider, control);
      return;
    }
    if (provider.runtimeFor(target.name)?.running) {
      void vscode.window.showWarningMessage(
        `${target.name} is already running. Use Hot-Attach to debug the live main.py process without restarting.`,
      );
      return;
    }
    await vscode.debug.startDebugging(undefined, {
      name: `AutoSurg: ${target.name}`,
      type: "debugpy",
      request: "launch",
      program: path.join(control.systemDir, "main.py"),
      cwd: control.systemDir,
      env: {
        AUTOSURG_MODULES_CONFIG: configPath,
      },
      console: "integratedTerminal",
      justMyCode: false,
    });
    return;
  }

  if (target.nodeKind !== "compute") {
    return;
  }

  const alreadyAttached = [...activeDebugSessionNames].some((name) =>
    name.startsWith(`AutoSurg: ${target.name} (`),
  );
  if (alreadyAttached) {
    void vscode.window.showInformationMessage(
      `${target.name} is already attached to a debugger.`,
    );
    return;
  }

  if (mode === "hot") {
    await hotAttachTarget(target, provider, control);
    return;
  }
  await restartAttachCompute(target, provider, control);
}

async function hotAttachTarget(
  target: AutoSurgNode,
  provider: AutoSurgTreeProvider,
  control: ControlClient,
): Promise<void> {
  const isOrchestrator = target.nodeKind === "orchestrator";
  if (isOrchestrator && isMainProcessAttached()) {
    void vscode.window.showInformationMessage(
      "The orchestrator process is already attached. All orchestrators share main.py, so breakpoints in any of them will hit this session.",
    );
    return;
  }

  const liveStatus = await control.request("status", target.name);
  const isRunning =
    liveStatus.alive === true || liveStatus.restarting === true;
  if (!isRunning) {
    throw new Error(
      isOrchestrator
        ? `${target.name} is not running. Start the system first, or use Debug Orchestrator to launch main.py.`
        : `${target.name} is not running. Start it first, or use Restart-Attach.`,
    );
  }
  if (liveStatus.restarting === true) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Waiting for ${target.name} to finish restarting`,
        cancellable: false,
      },
      () => waitForModuleReady(control, target.name, 70_000),
    );
  }
  const hot = await tryHotPlugDebug(control, target.name);
  if (!hot) {
    throw new Error(
      isOrchestrator
        ? `${target.name} hot-attach failed. ControlPlane may not support orchestrator start_debug yet, or port 5684 is in use.`
        : `${target.name} hot-attach failed. The worker may not support start_debug yet, or the debug port is in use. Use Restart-Attach if you can drop process state.`,
    );
  }
  if (hot.underDebugger) {
    void vscode.window.showInformationMessage(
      "main.py is already running under a debugger. Breakpoints in orchestrators will hit that session.",
    );
    return;
  }
  const sessionName = isOrchestrator ? "orchestrator" : target.name;
  await attachComputeDebugger(sessionName, hot.host, hot.port);
  const kept = isOrchestrator
    ? "all orchestrators share this process"
    : "process state kept";
  void vscode.window.showInformationMessage(
    hot.already
      ? `AutoSurg attached to ${target.name} on ${hot.host}:${hot.port} (already listening).`
      : `AutoSurg hot-attached to ${target.name} on ${hot.host}:${hot.port} (${kept}).`,
  );
  setTimeout(() => void provider.refresh(), 1000);
}

async function restartAttachCompute(
  target: AutoSurgNode,
  provider: AutoSurgTreeProvider,
  control: ControlClient,
): Promise<void> {
  const liveStatus = await control.request("status", target.name);
  const isRunning =
    liveStatus.alive === true || liveStatus.restarting === true;
  const port = await findAvailablePort(
    vscode.workspace
      .getConfiguration("autosurg")
      .get<number>("debugPortBase", 5678),
  );
  reservedDebugPorts.add(port);

  try {
    const action = isRunning ? "restart" : "start";
    const result = await control.request(action, target.name, {
      force: true,
      timeoutMs: 70000,
      env: {
        AUTOSURG_DEBUG_PORT: String(port),
      },
    });
    if (result.status === "error") {
      throw new Error(String(result.message ?? `Failed to ${action} module`));
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Waiting for ${target.name} to become ready`,
        cancellable: false,
      },
      () => waitForModuleReady(control, target.name, 70_000),
    );

    await attachComputeDebugger(target.name, "localhost", port);
    void vscode.window.showInformationMessage(
      `AutoSurg restart-attached ${target.name} on localhost:${port} (process was restarted).`,
    );
    setTimeout(() => void provider.refresh(), 1000);
  } finally {
    reservedDebugPorts.delete(port);
  }
}

interface HotPlugDebug {
  host: string;
  port: number;
  already: boolean;
  underDebugger?: boolean;
}

async function tryHotPlugDebug(
  control: ControlClient,
  module: string,
): Promise<HotPlugDebug | undefined> {
  try {
    const result = await control.request("start_debug", module, {
      timeoutMs: 15_000,
    });
    if (result.status === "error") {
      return undefined;
    }
    if (result.under_debugger === true) {
      return {
        host: "localhost",
        port: 0,
        already: true,
        underDebugger: true,
      };
    }
    const port = Number(result.port);
    if (!Number.isInteger(port) || port <= 0) {
      return undefined;
    }
    const host =
      typeof result.host === "string" && result.host.trim()
        ? result.host
        : "localhost";
    return {
      host,
      port,
      already: result.already === true,
    };
  } catch {
    // Old ControlPlane, argparse without start_debug, or listen failure.
    return undefined;
  }
}

async function attachComputeDebugger(
  name: string,
  host: string,
  port: number,
): Promise<void> {
  const attached = await vscode.debug.startDebugging(undefined, {
    name: `AutoSurg: ${name} (${port})`,
    type: "debugpy",
    request: "attach",
    connect: { host, port },
    justMyCode: false,
  });
  if (!attached) {
    throw new Error(`Unable to attach to ${name} on ${host}:${port}`);
  }
}

async function debugAllComputes(
  provider: AutoSurgTreeProvider,
  control: ControlClient,
  configPath: string,
): Promise<void> {
  if (!(await isControlPlaneOnline(control))) {
    throw new Error("ControlPlane is not running. Start main.py first.");
  }

  await provider.refresh();
  const computes = provider.computeNodes();
  if (computes.length === 0) {
    void vscode.window.showInformationMessage(
      "No enabled Compute modules were found.",
    );
    return;
  }

  const failures: string[] = [];
  let attached = 0;
  for (const compute of computes) {
    const alreadyAttached = [...activeDebugSessionNames].some((name) =>
      name.startsWith(`AutoSurg: ${compute.name} (`),
    );
    if (alreadyAttached) {
      continue;
    }
    try {
      const mode: ComputeDebugMode =
        compute.runtime?.running === true ? "hot" : "restart";
      await debugNode(compute, provider, control, configPath, mode);
      attached += 1;
    } catch (error) {
      failures.push(`${compute.name}: ${String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Attached ${attached} Compute module(s); failed: ${failures.join("; ")}`,
    );
  }
  void vscode.window.showInformationMessage(
    `AutoSurg attached ${attached} Compute module(s).`,
  );
}

async function debugFullSystem(
  provider: AutoSurgTreeProvider,
  control: ControlClient,
  configPath: string,
): Promise<void> {
  const mainSession = activeDebugSessionNames.has("AutoSurg: Full System");
  const controlOnline = await isControlPlaneOnline(control);

  if (controlOnline && !mainSession) {
    throw new Error(
      "main.py is already running outside the debugger. Stop it before starting Full System debugging.",
    );
  }

  if (!controlOnline) {
    const started = await vscode.debug.startDebugging(undefined, {
      name: "AutoSurg: Full System",
      type: "debugpy",
      request: "launch",
      program: path.join(control.systemDir, "main.py"),
      cwd: control.systemDir,
      env: {
        AUTOSURG_MODULES_CONFIG: configPath,
        AUTOSURG_DEBUG_WAIT: "0",
      },
      console: "integratedTerminal",
      justMyCode: false,
    });
    if (!started) {
      throw new Error("Unable to launch main.py under the debugger.");
    }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Waiting for the AutoSurg ControlPlane",
      cancellable: false,
    },
    () => waitForControlPlane(control, 120_000),
  );
  await debugAllComputes(provider, control, configPath);
}

async function isControlPlaneOnline(control: ControlClient): Promise<boolean> {
  try {
    const response = await control.request("ping", undefined, {
      timeoutMs: 1000,
    });
    return response.status === "ok";
  } catch {
    return false;
  }
}

async function waitForControlPlane(
  control: ControlClient,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isControlPlaneOnline(control)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the AutoSurg ControlPlane");
}

async function runLifecycle(
  action: "start" | "stop" | "restart",
  node: AutoSurgNode | undefined,
  provider: AutoSurgTreeProvider,
  control: ControlClient,
): Promise<void> {
  if (!node || node.nodeKind === "category") {
    void vscode.window.showInformationMessage(
      "Select a module in the AutoSurg view first.",
    );
    return;
  }
  if (node.runtime?.restartable === false) {
    void vscode.window.showWarningMessage(
      `${node.name}: lifecycle actions are disabled (${node.runtime.kind === "ingress" ? "ingress modules cannot be restarted individually — restart the whole system" : "not restartable via ControlPlane"}).`,
    );
    return;
  }
  try {
    const result = await control.request(action, node.name, {
      force: action === "start",
    });
    if (result.status === "error") {
      throw new Error(String(result.message ?? "ControlPlane request failed"));
    }
    void vscode.window.showInformationMessage(
      `${node.name}: ${String(result.status ?? action)}`,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(String(error));
  } finally {
    setTimeout(() => void provider.refresh(), 500);
  }
}

async function waitForModuleReady(
  control: ControlClient,
  module: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await control.request("status", module);
    if (status.ready === true && status.restarting !== true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${module} to become ready`);
}

function findAvailablePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      if (port > 65535) {
        reject(new Error("No debug port is available."));
        return;
      }
      const server = net.createServer();
      server.unref();
      server.once("error", () => tryPort(port + 1));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => {
          if (reservedDebugPorts.has(port)) {
            tryPort(port + 1);
          } else {
            resolve(port);
          }
        });
      });
    };
    tryPort(start);
  });
}

async function loadConfig(configPath: string): Promise<AutoSurgConfig> {
  const text = await fs.promises.readFile(configPath, "utf8");
  const document = parseDocument(text, { uniqueKeys: false });
  const raw = (document.toJS() ?? {}) as JsonMap;
  return {
    modules: asRecord<ModuleConfig>(raw.modules),
    orchestrators: asRecord<JsonMap>(raw.orchestrators),
    pathPresets: asRecord<string[]>(raw.path_presets),
  };
}

function emptyConfig(): AutoSurgConfig {
  return { modules: {}, orchestrators: {}, pathPresets: {} };
}

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function isRuntimeItem(value: unknown): value is RuntimeItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<RuntimeItem>;
  return typeof item.name === "string" && typeof item.kind === "string";
}

async function resolveConfigPath(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }

  const configured = vscode.workspace
    .getConfiguration("autosurg")
    .get<string>("configPath", "")
    .trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.join(folders[0].uri.fsPath, configured);
  }

  const candidates = [
    path.join(folders[0].uri.fsPath, "config", "modules.yaml"),
    path.join(folders[0].uri.fsPath, "system", "config", "modules.yaml"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const discovered = await vscode.workspace.findFiles(
    "**/system/config/modules.yaml",
    "**/node_modules/**",
    1,
  );
  return discovered[0]?.fsPath;
}

function readControlPort(configPath: string): number {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    const raw = (parseDocument(text, { uniqueKeys: false }).toJS() ??
      {}) as JsonMap;
    const modules = asRecord<ModuleConfig>(raw.modules);
    const port = Number(modules.control_plane?.client_port);
    return Number.isInteger(port) && port > 0 ? port : 5560;
  } catch {
    return 5560;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerTensorView(context);
  registerPlyView(context);

  const configPath = await resolveConfigPath();
  if (!configPath) {
    void vscode.window.showWarningMessage(
      "AutoSurg could not find system/config/modules.yaml.",
    );
    return;
  }

  const control = new ControlClient(configPath, readControlPort(configPath));
  const provider = new AutoSurgTreeProvider(configPath, control);
  const diagnostics = new ConfigurationDiagnostics(configPath);
  if (vscode.debug.activeDebugSession) {
    activeDebugSessionNames.add(vscode.debug.activeDebugSession.name);
  }

  context.subscriptions.push(
    diagnostics,
    vscode.debug.onDidStartDebugSession((session) => {
      activeDebugSessionNames.add(session.name);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      activeDebugSessionNames.delete(session.name);
    }),
    vscode.window.registerTreeDataProvider("autosurg.modules", provider),
    vscode.commands.registerCommand("autosurg.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("autosurg.validate", () =>
      diagnostics.validate(true),
    ),
    vscode.commands.registerCommand("autosurg.debug", (node?: AutoSurgNode) =>
      debugNode(node, provider, control, configPath, "orchestrator").catch(
        (error) =>
          vscode.window.showErrorMessage(
            `AutoSurg debug failed: ${String(error)}`,
          ),
      ),
    ),
    vscode.commands.registerCommand("autosurg.debugHot", (node?: AutoSurgNode) =>
      debugNode(node, provider, control, configPath, "hot").catch((error) =>
        vscode.window.showErrorMessage(
          `AutoSurg hot-attach failed: ${String(error)}`,
        ),
      ),
    ),
    vscode.commands.registerCommand(
      "autosurg.debugRestart",
      (node?: AutoSurgNode) =>
        debugNode(node, provider, control, configPath, "restart").catch(
          (error) =>
            vscode.window.showErrorMessage(
              `AutoSurg restart-attach failed: ${String(error)}`,
            ),
        ),
    ),
    vscode.commands.registerCommand("autosurg.debugAllComputes", () =>
      debugAllComputes(provider, control, configPath).catch((error) =>
        vscode.window.showErrorMessage(
          `AutoSurg Debug All Compute failed: ${String(error)}`,
        ),
      ),
    ),
    vscode.commands.registerCommand("autosurg.debugFullSystem", () =>
      debugFullSystem(provider, control, configPath).catch((error) =>
        vscode.window.showErrorMessage(
          `AutoSurg Full System debug failed: ${String(error)}`,
        ),
      ),
    ),
    vscode.commands.registerCommand("autosurg.start", (node?: AutoSurgNode) =>
      runLifecycle("start", node, provider, control),
    ),
    vscode.commands.registerCommand("autosurg.stop", (node?: AutoSurgNode) =>
      runLifecycle("stop", node, provider, control),
    ),
    vscode.commands.registerCommand("autosurg.restart", (node?: AutoSurgNode) =>
      runLifecycle("restart", node, provider, control),
    ),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(configPath);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => {
      void diagnostics.validate();
      void provider.refresh();
    }),
  );

  await diagnostics.validate();
  await provider.refresh();
}

export function deactivate(): void {}
