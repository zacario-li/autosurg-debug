import { deflateSync, inflateSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

interface SliceOpts {
  batch: number;
  channel: number;
  maxSide: number;
  rgbMode: boolean;
  mode: "single" | "grid" | "kind" | "preview" | "chunk" | "release";
  maxChannels: number;
  cellSide: number;
  token?: string;
  offset?: number;
  length?: number;
  cloudMode?: number; // 0 auto, 1 force cloud, 2 force image
}

interface ExtractOk {
  ok: true;
  kind: "image" | "heatmap" | "line" | "scalar" | "pointcloud";
  format: "rgb" | "gray" | "line" | "scalar" | "grid" | "cloud";
  typeName: string;
  shape: number[];
  dtype: string;
  device: string;
  layout: string;
  batchCount: number;
  channelCount: number;
  batchIndex: number;
  channelIndex: number;
  rgbMode: boolean;
  bgrGuess: boolean;
  isTorch: boolean;
  tensorH: number;
  tensorW: number;
  displayH: number;
  displayW: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  nanCount: number;
  infCount: number;
  png?: string;
  pixels?: string;
  pixelChannels?: number;
  pixelEncoding?: "raw" | "zlib";
  token?: string;
  byteLength?: number;
  samples?: number[];
  scalar?: number;
  expression?: string;
  source?: "python" | "cpp";
  gridCols?: number;
  gridRows?: number;
  cellW?: number;
  cellH?: number;
  shownChannels?: number;
  deadChannels?: number[];
  cloudCount?: number;
  cloudSampled?: number;
  cloudK?: number;
  cloudRgb?: boolean;
  cloudIntensity?: boolean;
  cloudMin?: number[];
  cloudMax?: number[];
  cloudMean?: number[];
  cloud?: {
    count: number;
    sampled: number;
    cols: number;
    rgb: boolean;
    intensity: boolean;
    min: number[];
    max: number[];
    mean: number[];
  };
}

interface ExtractErr {
  ok: false;
  error: string;
  code?: string;
}

type ExtractResult = ExtractOk | ExtractErr;

interface DebugVariableArg {
  sessionId?: string;
  frameId?: number;
  threadId?: number;
  expression?: string;
  variable?: {
    name?: string;
    value?: string;
    type?: string;
    evaluateName?: string;
  };
  container?: { evaluateName?: string };
}

export const PYTHON_TYPES = new Set(["python", "debugpy", "Python"]);
const CPP_TYPES = new Set(["cppdbg", "lldb", "cppvsdbg", "gdb"]);
const MAX_SIDES = [384, 256, 160, 96];
const HOVER_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "def",
  "class",
  "return",
  "import",
  "from",
  "else",
  "elif",
  "with",
  "as",
  "pass",
  "None",
  "True",
  "False",
  "and",
  "or",
  "not",
  "in",
  "is",
  "lambda",
  "yield",
  "try",
  "except",
  "finally",
  "self",
  "print",
  "len",
  "range",
]);

const views = new Set<TensorViewPanel>();
let extractorSource = "";
const hoverCache = new Map<string, { at: number; hover: vscode.Hover }>();

export function registerTensorView(context: vscode.ExtensionContext): void {
  extractorSource = fs.readFileSync(
    path.join(context.extensionPath, "media", "extract_tensor.py"),
    "utf8",
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "autosurg.visualizeTensor",
      (arg?: unknown) => {
        void openTensorView(context, arg).catch((error) =>
          vscode.window.showErrorMessage(
            `AutoSurg visualize failed: ${String(error)}`,
          ),
        );
      },
    ),
    vscode.commands.registerCommand(
      "autosurg.viewCloud",
      (arg?: unknown) => {
        void openTensorView(context, arg, true).catch((error) =>
          vscode.window.showErrorMessage(
            `AutoSurg point cloud failed: ${String(error)}`,
          ),
        );
      },
    ),
    vscode.debug.onDidChangeActiveStackItem(() => {
      for (const view of views) {
        view.onStackChanged();
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      for (const view of views) {
        view.onSessionEnded(session.id);
      }
      hoverCache.clear();
    }),
    vscode.languages.registerHoverProvider("python", {
      provideHover(document, position, token) {
        return provideTensorHover(document, position, token);
      },
    }),
  );
}

async function openTensorView(
  context: vscode.ExtensionContext,
  arg: unknown,
  forceCloud = false,
): Promise<void> {
  const session = resolveSession(arg);
  if (!session) {
    void vscode.window.showWarningMessage(
      "Pause a debug session before viewing a tensor or image.",
    );
    return;
  }
  const expression = await resolveExpression(arg);
  if (!expression) {
    return;
  }
  const frameId = await resolveFrameId(session, arg);
  const key = `${session.id}::${expression}`;
  for (const view of views) {
    if (view.key === key) {
      view.reveal();
      if (forceCloud) {
        view.forceCloudMode();
      } else {
        await view.refresh();
      }
      return;
    }
  }
  const view = new TensorViewPanel(context, session, expression, frameId, {
    batch: 0,
    channel: 0,
    maxSide: MAX_SIDES[0],
    rgbMode: true,
    mode: "single",
    maxChannels: 64,
    cellSide: 48,
    cloudMode: forceCloud ? 1 : 0,
  });
  views.add(view);
  await view.refresh();
}

function resolveSession(arg: unknown): vscode.DebugSession | undefined {
  const parsed = asVariableArg(arg);
  if (parsed?.sessionId) {
    const match = vscode.debug.activeDebugSession?.id === parsed.sessionId
      ? vscode.debug.activeDebugSession
      : undefined;
    if (match) {
      return match;
    }
  }
  const item = vscode.debug.activeStackItem;
  if (item?.session) {
    return item.session;
  }
  return vscode.debug.activeDebugSession;
}

async function resolveExpression(arg: unknown): Promise<string | undefined> {
  const parsed = asVariableArg(arg);
  const fromArg =
    (parsed && "expression" in parsed
      ? String((parsed as { expression?: string }).expression || "").trim()
      : "") ||
    parsed?.variable?.evaluateName?.trim() ||
    parsed?.variable?.name?.trim() ||
    "";
  if (fromArg) {
    return fromArg;
  }
  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection).trim();
  if (selected) {
    return selected;
  }
  return vscode.window.showInputBox({
    title: "View as Image / Tensor",
    prompt: "Expression to visualize in the current debug frame",
    placeHolder: "image, pred[0], self.disp",
  });
}

async function resolveFrameId(
  session: vscode.DebugSession,
  arg: unknown,
): Promise<number | undefined> {
  const parsed = asVariableArg(arg);
  if (typeof parsed?.frameId === "number") {
    return parsed.frameId;
  }
  const item = vscode.debug.activeStackItem;
  if (item && "frameId" in item && item.session.id === session.id) {
    return item.frameId;
  }
  try {
    const threads = (await session.customRequest("threads")) as {
      threads?: Array<{ id: number }>;
    };
    const threadId =
      parsed?.threadId ??
      (item && "threadId" in item ? item.threadId : undefined) ??
      threads.threads?.[0]?.id;
    if (threadId === undefined) {
      return undefined;
    }
    const stack = (await session.customRequest("stackTrace", {
      threadId,
      startFrame: 0,
      levels: 1,
    })) as { stackFrames?: Array<{ id: number }> };
    return stack.stackFrames?.[0]?.id;
  } catch {
    return undefined;
  }
}

function asVariableArg(arg: unknown): DebugVariableArg | undefined {
  const value = Array.isArray(arg) ? arg[0] : arg;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as DebugVariableArg;
}

async function provideTensorHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
): Promise<vscode.Hover | undefined> {
  if (
    !vscode.workspace.getConfiguration("autosurg").get<boolean>("tensorHover", true)
  ) {
    return undefined;
  }
  const session = vscode.debug.activeDebugSession;
  if (!session || !PYTHON_TYPES.has(session.type)) {
    return undefined;
  }
  const item = vscode.debug.activeStackItem;
  if (!item || !("frameId" in item) || item.session.id !== session.id) {
    return undefined;
  }
  const found = expressionAt(document, position);
  if (!found) {
    return undefined;
  }
  const cacheKey = `${session.id}:${item.frameId}:${found.expression}`;
  const cached = hoverCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 2500) {
    return cached.hover;
  }
  try {
    const kindRaw = await evaluate(
      session,
      item.frameId,
      callExtractor(extractorSource, found.expression, {
        batch: 0,
        channel: 0,
        maxSide: 64,
        rgbMode: true,
        mode: "kind",
        maxChannels: 1,
        cellSide: 32,
      }),
    );
    if (token.isCancellationRequested) {
      return undefined;
    }
    const kind = parseDapJson(kindRaw) as {
      visual?: boolean;
      typeName?: string;
      shape?: number[];
      dtype?: string;
      device?: string;
    };
    if (!kind?.visual) {
      return undefined;
    }
    const peek = await extractPython(session, item.frameId, found.expression, {
      batch: 0,
      channel: 0,
      maxSide: 96,
      rgbMode: true,
      mode: "preview",
      maxChannels: 4,
      cellSide: 48,
    });
    if (token.isCancellationRequested || !peek.ok) {
      return buildHover(found.range, found.expression, kind, undefined);
    }
    const hover = buildHover(found.range, found.expression, kind, peek);
    hoverCache.set(cacheKey, { at: Date.now(), hover });
    if (hoverCache.size > 40) {
      const first = hoverCache.keys().next().value;
      if (first) {
        hoverCache.delete(first);
      }
    }
    return hover;
  } catch {
    return undefined;
  }
}

function expressionAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): { expression: string; range: vscode.Range } | undefined {
  const line = document.lineAt(position.line).text;
  const regex = /[A-Za-z_][\w.]*(?:\[[^\]]+\])*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      const expression = match[0];
      if (HOVER_KEYWORDS.has(expression) || expression.length < 2) {
        return undefined;
      }
      return {
        expression,
        range: new vscode.Range(
          position.line,
          start,
          position.line,
          end,
        ),
      };
    }
  }
  return undefined;
}

function buildHover(
  range: vscode.Range,
  expression: string,
  kind: { typeName?: string; shape?: number[]; dtype?: string; device?: string },
  peek: ExtractOk | undefined,
): vscode.Hover {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = true;
  const shape = (kind.shape || peek?.shape || []).join("×") || "?";
  const bits = [
    kind.typeName || peek?.typeName || "tensor",
    peek?.dtype || kind.dtype,
    peek?.device || kind.device,
    shape,
  ].filter(Boolean);
  md.appendMarkdown(`**${bits.join(" · ")}**\n\n`);
  const thumb = peekPng(peek);
  if (thumb) {
    md.appendMarkdown(`<img src="data:image/png;base64,${thumb}" width="160" />\n\n`);
  }
  if (peek && peek.format === "cloud") {
    const count = peek.cloudCount;
    const min = peek.cloudMin;
    const max = peek.cloudMax;
    const bits: string[] = [];
    if (count !== undefined) {
      bits.push(`${count} points`);
    }
    if (min && max) {
      bits.push(
        `bbox (${formatHoverNumber(min[0])},${formatHoverNumber(min[1])},${formatHoverNumber(
          min[2],
        )}) → (${formatHoverNumber(max[0])},${formatHoverNumber(max[1])},${formatHoverNumber(max[2])})`,
      );
    }
    if (bits.length) {
      md.appendMarkdown(bits.join(" · ") + "\n\n");
    }
  } else if (peek && (peek.min !== undefined || peek.max !== undefined)) {
    md.appendMarkdown(
      `min ${formatHoverNumber(peek.min)} · max ${formatHoverNumber(peek.max)} · mean ${formatHoverNumber(peek.mean)}\n\n`,
    );
  }
  const arg = encodeURIComponent(JSON.stringify({ expression }));
  md.appendMarkdown(`[Open Tensor View](command:autosurg.visualizeTensor?${arg})`);
  return new vscode.Hover(md, range);
}

function peekPng(peek: ExtractOk | undefined): string | undefined {
  if (!peek) {
    return undefined;
  }
  if (peek.png) {
    return peek.png;
  }
  if (!peek.pixels || !peek.displayW || !peek.displayH) {
    return undefined;
  }
  try {
    const raw = inflateSync(Buffer.from(peek.pixels, "base64"));
    const channels = peek.pixelChannels === 3 ? 3 : 1;
    return encodePng(raw, peek.displayW, peek.displayH, channels);
  } catch {
    return undefined;
  }
}

function formatHoverNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

class TensorViewPanel {
  readonly key: string;
  readonly panel: vscode.WebviewPanel;
  private session: vscode.DebugSession;
  private frameId: number | undefined;
  private slice: SliceOpts;
  private autoWatch = true;
  private lastMeta: ExtractOk | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private probing = false;
  private postSeq = 0;

  constructor(
    context: vscode.ExtensionContext,
    session: vscode.DebugSession,
    private readonly expression: string,
    frameId: number | undefined,
    slice: SliceOpts,
  ) {
    this.session = session;
    this.frameId = frameId;
    this.slice = slice;
    this.key = `${session.id}::${expression}`;
    this.panel = vscode.window.createWebviewPanel(
      "autosurg.tensorView",
      titleFor(expression),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      "media",
      "autosurg.svg",
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "tensorView.js"),
    );
    this.panel.webview.html = renderHtml(this.panel.webview, scriptUri);
    this.panel.onDidDispose(() => {
      this.disposed = true;
      views.delete(this);
    });
    this.panel.webview.onDidReceiveMessage((message) => {
      void this.onMessage(message);
    });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  forceCloudMode(): void {
    this.slice.cloudMode = 1;
    this.slice.mode = "single";
    void this.refresh({ quiet: true });
  }

  onStackChanged(): void {
    if (!this.autoWatch || this.disposed) {
      return;
    }
    const item = vscode.debug.activeStackItem;
    if (!item || item.session.id !== this.session.id) {
      return;
    }
    if (!("frameId" in item)) {
      return;
    }
    this.frameId = item.frameId;
    this.session = item.session;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      void this.refresh({ quiet: true });
    }, 180);
  }

  onSessionEnded(sessionId: string): void {
    if (sessionId !== this.session.id) {
      return;
    }
    this.lastMeta = undefined;
    this.post({
      type: "status",
      state: "session-ended",
      message: "Debug session ended.",
    });
  }

  async refresh(options?: { quiet?: boolean }): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (options?.quiet) {
      // Hidden tab + per-step auto refresh: DAP evaluate round trips are
      // invisible to the user, so wait until the tab is actually shown and
      // then fetch the freshest value once.
      await this.waitVisible();
      if (this.disposed) {
        return;
      }
    }
    const item = vscode.debug.activeStackItem;
    if (item?.session.id === this.session.id && "frameId" in item) {
      this.frameId = item.frameId;
      this.session = item.session;
    }
    if (!options?.quiet) {
      this.post({ type: "status", state: "loading", message: "Extracting…" });
    }
    try {
      const result = await extractValue(
        this.session,
        this.frameId,
        this.expression,
        this.slice,
      );
      if (!result.ok) {
        this.lastMeta = undefined;
        this.post({
          type: "status",
          state: result.code === "none" ? "error" : "error",
          message: result.error,
        });
        return;
      }
      this.lastMeta = result;
      this.slice.batch = result.batchIndex;
      this.slice.channel = result.channelIndex;
      this.slice.rgbMode = result.rgbMode;
      this.post({
        type: "payload",
        data: preparePayload(result, this.expression),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notStopped =
        message.trim() === "notStopped" || /\bnotStopped\b/.test(message);
      if (notStopped) {
        // DAP's one structured error token: the target is running. Quiet
        // refreshes just skip; explicit ones explain instead of guessing.
        if (options?.quiet) {
          return;
        }
        this.post({
          type: "status",
          state: "out-of-scope",
          message:
            "The debugger is running. Pause execution to refresh this value.",
        });
        return;
      }
      const outOfScope = /not defined|not available|cannot evaluate|out of scope|NameError|syntax error/i.test(
        message,
      );
      if (options?.quiet && this.lastMeta) {
        return;
      }
      this.post({
        type: "status",
        state: outOfScope ? "out-of-scope" : "error",
        message: outOfScope
          ? "Variable is out of scope or the debugger is not paused."
          : message,
      });
    }
  }

  private async onMessage(message: {
    type?: string;
    batch?: number;
    channel?: number;
    rgbMode?: boolean;
    enabled?: boolean;
    x?: number;
    y?: number;
    view?: string;
  }): Promise<void> {
    if (message.type === "ready" || message.type === "refresh") {
      await this.refresh();
      return;
    }
    if (message.type === "viewAs") {
      const mode = String(message.view || "auto");
      this.slice.cloudMode = mode === "cloud" ? 1 : mode === "image" ? 2 : 0;
      this.slice.mode = "single";
      await this.refresh({ quiet: true });
      return;
    }
    if (message.type === "autoWatch") {
      this.autoWatch = message.enabled !== false;
      return;
    }
    if (message.type === "slice") {
      this.slice.batch = Number(message.batch) || 0;
      this.slice.channel = Number(message.channel) || 0;
      this.slice.rgbMode = message.rgbMode !== false;
      this.slice.mode = "single";
      await this.refresh({ quiet: true });
      return;
    }
    if (message.type === "grid") {
      this.slice.batch = Number(message.batch) || 0;
      this.slice.mode = "grid";
      this.slice.rgbMode = false;
      await this.refresh({ quiet: true });
      return;
    }
    if (message.type === "compare") {
      await this.compareExpression();
      return;
    }
    if (message.type === "probe" && this.lastMeta) {
      await this.probe(Number(message.x), Number(message.y));
    }
  }

  private async compareExpression(): Promise<void> {
    const expression = await vscode.window.showInputBox({
      title: "Compare with expression",
      prompt: "Evaluate another tensor in the current frame",
      placeHolder: "gt, pred[0], snapshot_ref",
    });
    if (!expression) {
      return;
    }
    try {
      const result = await extractValue(this.session, this.frameId, expression, {
        ...this.slice,
        mode: "single",
        rgbMode: this.slice.rgbMode,
      });
      if (!result.ok) {
        this.post({ type: "status", state: "error", message: result.error });
        return;
      }
      this.post({
        type: "comparePayload",
        data: preparePayload(result, expression),
      });
    } catch (error) {
      this.post({
        type: "status",
        state: "error",
        message: String(error),
      });
    }
  }

  private async probe(x: number, y: number): Promise<void> {
    if (this.probing || !this.lastMeta || this.disposed) {
      return;
    }
    this.probing = true;
    try {
      const values = await probeValue(
        this.session,
        this.frameId,
        this.expression,
        this.lastMeta,
        y,
        x,
      );
      this.post({ type: "probe", x, y, value: values });
    } catch (error) {
      this.post({
        type: "probe",
        x,
        y,
        error: "original value unavailable",
      });
    } finally {
      this.probing = false;
    }
  }

  private post(message: Record<string, unknown>): void {
    if (this.disposed) {
      return;
    }
    let json: string;
    try {
      json = JSON.stringify(message);
    } catch {
      return;
    }
    if (json.length <= MAX_POST_CHUNK) {
      void this.panel.webview.postMessage(message);
      return;
    }
    // Oversized payloads (big images, 150k-point clouds) are streamed as
    // ordered string chunks; the webview reassembles before parsing.
    const id = `p${++this.postSeq}`;
    void (async () => {
      await this.panel.webview.postMessage({
        type: "stream-start",
        id,
        total: json.length,
      });
      for (let offset = 0; offset < json.length; offset += MAX_POST_CHUNK) {
        await this.waitVisible();
        if (this.disposed) {
          return;
        }
        await this.panel.webview.postMessage({
          type: "stream-data",
          id,
          data: json.slice(offset, offset + MAX_POST_CHUNK),
        });
      }
      if (!this.disposed) {
        void this.panel.webview.postMessage({ type: "stream-end", id });
      }
    })();
  }

  /** Resolves once the panel is visible (or disposed). */
  private waitVisible(): Promise<void> {
    if (this.disposed || this.panel.visible) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const stateSub = this.panel.onDidChangeViewState(() => {
        if (this.disposed || this.panel.visible) {
          stateSub.dispose();
          resolve();
        }
      });
      void this.panel.onDidDispose(() => {
        stateSub.dispose();
        resolve();
      });
    });
  }
}

const MAX_POST_CHUNK = 256 * 1024;

function preparePayload(result: ExtractOk, expression: string): ExtractOk {
  const data: ExtractOk = { ...result, expression };
  if (data.format === "cloud" && data.cloudCount !== undefined) {
    data.cloud = {
      count: data.cloudCount || 0,
      sampled: data.cloudSampled || data.cloudCount || 0,
      cols: data.cloudK || 3,
      rgb: !!data.cloudRgb,
      intensity: !!data.cloudIntensity,
      min: data.cloudMin || [0, 0, 0],
      max: data.cloudMax || [0, 0, 0],
      mean: data.cloudMean || [0, 0, 0],
    };
  }
  if (!data.pixels) {
    return data;
  }
  if (data.pixelEncoding === "raw") {
    return data;
  }
  try {
    const raw = inflateSync(Buffer.from(data.pixels, "base64"));
    data.pixels = Buffer.from(raw).toString("base64");
    data.pixelEncoding = "raw";
  } catch {
    data.pixelEncoding = "zlib";
  }
  return data;
}

async function extractValue(
  session: vscode.DebugSession,
  frameId: number | undefined,
  expression: string,
  slice: SliceOpts,
): Promise<ExtractResult> {
  const type = session.type;
  if (PYTHON_TYPES.has(type)) {
    return extractPython(session, frameId, expression, slice);
  }
  if (CPP_TYPES.has(type)) {
    return extractCppMat(session, frameId, expression, slice);
  }
  return {
    ok: false,
    error: `Unsupported debugger type "${type}". Python debugpy and C++ cppdbg/lldb are supported.`,
  };
}

async function extractPython(
  session: vscode.DebugSession,
  frameId: number | undefined,
  expression: string,
  slice: SliceOpts,
): Promise<ExtractResult> {
  const sides = slice.mode === "grid" || slice.mode === "kind" ? [slice.maxSide] : MAX_SIDES;
  let lastError = "extract failed";
  for (const maxSide of sides) {
    const code = callExtractor(extractorSource, expression, {
      ...slice,
      maxSide,
    });
    try {
      const raw = await evaluate(session, frameId, code);
      const parsed = parseDapJson(raw) as ExtractResult;
      if (parsed && typeof parsed === "object" && "ok" in parsed) {
        if (parsed.ok) {
          parsed.source = "python";
          return hydrateFullImage(session, frameId, parsed, slice);
        }
        return parsed;
      }
      lastError = "unexpected extract payload";
    } catch (error) {
      lastError = String(error);
      if (!/JSON|truncated|invalid/i.test(lastError)) {
        throw error;
      }
    }
  }
  return { ok: false, error: lastError };
}

function callExtractor(
  source: string,
  userExpr: string,
  opts: SliceOpts,
): string {
  const objectExpr =
    opts.mode === "chunk" || opts.mode === "release" ? "None" : `(${userExpr})`;
  return (
    `(lambda __g, __obj: (__import__('builtins').exec(${JSON.stringify(source)}, __g) or ` +
    `__g['_autosurg_viz'](__obj, ${opts.batch}, ${opts.channel}, ${opts.maxSide}, ${
      opts.rgbMode ? 1 : 0
    }, ${JSON.stringify(opts.mode)}, ${opts.maxChannels}, ${opts.cellSide}, ${JSON.stringify(
      opts.token || "",
    )}, ${opts.offset || 0}, ${opts.length || 12000}, ${opts.cloudMode || 0})))` +
    `({'__builtins__': __import__('builtins')}, ${objectExpr})`
  );
}

async function hydrateFullImage(
  session: vscode.DebugSession,
  frameId: number | undefined,
  parsed: ExtractOk,
  slice: SliceOpts,
): Promise<ExtractOk> {
  if (!parsed.token || !parsed.byteLength) {
    return parsed;
  }
  const chunkSize = 12000;
  const parts: Buffer[] = [];
  try {
    for (let offset = 0; offset < parsed.byteLength; offset += chunkSize) {
      const raw = await evaluate(
        session,
        frameId,
        callExtractor(extractorSource, "None", {
          ...slice,
          mode: "chunk",
          token: parsed.token,
          offset,
          length: chunkSize,
        }),
      );
      const piece = parseDapJson(raw) as { ok?: boolean; data?: string };
      if (!piece?.ok || !piece.data) {
        throw new Error("image chunk missing");
      }
      parts.push(Buffer.from(piece.data, "base64"));
    }
  } finally {
    try {
      await evaluate(
        session,
        frameId,
        callExtractor(extractorSource, "None", {
          ...slice,
          mode: "release",
          token: parsed.token,
        }),
      );
    } catch {
      /* ignore cache cleanup errors */
    }
  }
  const assembled = Buffer.concat(parts);
  parsed.pixels = assembled.toString("base64");
  parsed.pixelEncoding = "zlib";
  delete parsed.token;
  delete parsed.byteLength;
  return parsed;
}

async function probeValue(
  session: vscode.DebugSession,
  frameId: number | undefined,
  expression: string,
  meta: ExtractOk,
  y: number,
  x: number,
): Promise<number[]> {
  if (meta.source === "cpp") {
    return [];
  }
  const indexed = pythonIndex(expression, meta, y, x);
  const code =
    `(lambda __v: __import__('json').dumps({'ok': True, 'v': (` +
    `__v.detach().cpu().float().reshape(-1).tolist() if hasattr(__v, 'detach') else ` +
    `(__v.astype('float64').reshape(-1).tolist() if hasattr(__v, 'reshape') else ` +
    `(list(__v) if isinstance(__v, (list, tuple)) else ` +
    `([int(__v)] if isinstance(__v, (bool, int)) else [float(__v)]))))))})` +
    `(${indexed})`;
  const parsed = parseDapJson(await evaluate(session, frameId, code)) as {
    v?: unknown;
  };
  return normalizeProbe(parsed.v);
}

function pythonIndex(
  expression: string,
  meta: ExtractOk,
  y: number,
  x: number,
): string {
  const e = `(${expression})`;
  if (meta.typeName === "Image") {
    return `${e}.getpixel((${x}, ${y}))`;
  }
  const b = meta.batchIndex;
  const c = meta.channelIndex;
  if (meta.layout === "NCHW") {
    return meta.rgbMode ? `${e}[${b}, :3, ${y}, ${x}]` : `${e}[${b}, ${c}, ${y}, ${x}]`;
  }
  if (meta.layout === "NHWC") {
    return meta.rgbMode ? `${e}[${b}, ${y}, ${x}, :3]` : `${e}[${b}, ${y}, ${x}, ${c}]`;
  }
  if (meta.layout === "CHW") {
    return meta.rgbMode ? `${e}[:3, ${y}, ${x}]` : `${e}[${c}, ${y}, ${x}]`;
  }
  if (meta.layout === "HWC") {
    return meta.rgbMode ? `${e}[${y}, ${x}, :3]` : `${e}[${y}, ${x}, ${c}]`;
  }
  if (meta.layout === "1D") {
    return `${e}[${x}]`;
  }
  return `${e}[${y}, ${x}]`;
}

function normalizeProbe(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  const number = Number(value);
  return Number.isFinite(number) ? [number] : [];
}

async function extractCppMat(
  session: vscode.DebugSession,
  frameId: number | undefined,
  expression: string,
  slice: SliceOpts,
): Promise<ExtractResult> {
  const expr = `(${expression})`;
  const rows = await evalNumber(session, frameId, `${expr}.rows`);
  const cols = await evalNumber(session, frameId, `${expr}.cols`);
  if (!rows || !cols || rows <= 0 || cols <= 0) {
    return {
      ok: false,
      error: "Not a readable cv::Mat (need rows/cols in a paused C++ frame).",
    };
  }
  const type =
    (await evalNumber(session, frameId, `${expr}.type()`)) ??
    (await evalNumber(session, frameId, `${expr}.type`));
  if (type === undefined) {
    return { ok: false, error: "Unable to read cv::Mat type()." };
  }
  const depth = type & 7;
  const channels = (type >> 3) + 1;
  const elemSize =
    (await evalNumber(session, frameId, `${expr}.elemSize()`)) ??
    depthSize(depth) * channels;
  const step =
    (await evalNumber(session, frameId, `(int)${expr}.step[0]`)) ??
    (await evalNumber(session, frameId, `${expr}.step`)) ??
    cols * elemSize;
  const pointer = await evalPointer(
    session,
    frameId,
    `(void*)${expr}.data`,
    `${expr}.data`,
  );
  if (!pointer) {
    return { ok: false, error: "Unable to read cv::Mat data pointer." };
  }
  const byteCount = rows * step;
  if (byteCount <= 0 || byteCount > 64 * 1024 * 1024) {
    return { ok: false, error: `cv::Mat is too large to preview (${byteCount} bytes).` };
  }
  let memory: Buffer;
  try {
    const response = (await session.customRequest("readMemory", {
      memoryReference: pointer,
      count: byteCount,
    })) as { data?: string };
    if (!response.data) {
      return { ok: false, error: "Debugger did not return Mat memory." };
    }
    memory = Buffer.from(response.data, "base64");
  } catch (error) {
    return {
      ok: false,
      error: `C++ memory read failed: ${String(error)}`,
    };
  }
  const { pixels, width, height, format, vmin, vmax, vmean } = rasterizeMat(
    memory,
    rows,
    cols,
    channels,
    depth,
    step,
    slice.maxSide,
    slice.rgbMode && channels >= 3,
    slice.channel,
  );
  const png = encodePng(
    pixels,
    width,
    height,
    format === "rgb" ? 3 : 1,
  );
  return {
    ok: true,
    kind: format === "rgb" ? "image" : "heatmap",
    format,
    typeName: "cv::Mat",
    shape: channels > 1 ? [rows, cols, channels] : [rows, cols],
    dtype: depthName(depth),
    device: "cpu",
    layout: channels > 1 ? "HWC" : "HW",
    batchCount: 1,
    channelCount: channels,
    batchIndex: 0,
    channelIndex: slice.channel,
    rgbMode: format === "rgb",
    bgrGuess: format === "rgb",
    isTorch: false,
    tensorH: rows,
    tensorW: cols,
    displayH: height,
    displayW: width,
    min: vmin,
    max: vmax,
    mean: vmean,
    nanCount: 0,
    infCount: 0,
    png,
    pixels: deflateSync(pixels).toString("base64"),
    pixelChannels: format === "rgb" ? 3 : 1,
    source: "cpp",
  };
}

function depthSize(depth: number): number {
  return [1, 1, 2, 2, 4, 4, 8][depth] ?? 1;
}

function depthName(depth: number): string {
  return ["uint8", "int8", "uint16", "int16", "int32", "float32", "float64"][depth] ?? "unknown";
}

function rasterizeMat(
  memory: Buffer,
  rows: number,
  cols: number,
  channels: number,
  depth: number,
  step: number,
  maxSide: number,
  rgbMode: boolean,
  channelIndex: number,
): {
  pixels: Buffer;
  width: number;
  height: number;
  format: "rgb" | "gray";
  vmin: number;
  vmax: number;
  vmean: number;
} {
  const scale = Math.max(1, Math.max(rows, cols) / maxSide);
  const height = Math.max(1, Math.round(rows / scale));
  const width = Math.max(1, Math.round(cols / scale));
  const rgb = rgbMode && channels >= 3;
  const channel = Math.max(0, Math.min(channels - 1, channelIndex));
  const sample = (y: number, x: number, c: number): number => {
    const offset = y * step + x * depthSize(depth) * channels + c * depthSize(depth);
    return readDepth(memory, offset, depth);
  };
  let vmin = Number.POSITIVE_INFINITY;
  let vmax = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let count = 0;
  const values: number[] = [];
  for (let y = 0; y < height; y++) {
    const sy = Math.min(rows - 1, Math.floor((y / height) * rows));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(cols - 1, Math.floor((x / width) * cols));
      if (rgb) {
        const b = sample(sy, sx, 0);
        const g = sample(sy, sx, 1);
        const r = sample(sy, sx, 2);
        values.push(b, g, r);
        vmin = Math.min(vmin, r, g, b);
        vmax = Math.max(vmax, r, g, b);
        sum += (r + g + b) / 3;
        count += 1;
      } else {
        const v = sample(sy, sx, channel);
        values.push(v);
        vmin = Math.min(vmin, v);
        vmax = Math.max(vmax, v);
        sum += v;
        count += 1;
      }
    }
  }
  const pixels = Buffer.alloc(width * height * (rgb ? 3 : 1));
  for (let i = 0; i < values.length; i++) {
    pixels[i] = scaleToU8(values[i], vmin, vmax, depth);
  }
  return {
    pixels,
    width,
    height,
    format: rgb ? "rgb" : "gray",
    vmin: Number.isFinite(vmin) ? vmin : 0,
    vmax: Number.isFinite(vmax) ? vmax : 0,
    vmean: count ? sum / count : 0,
  };
}

function scaleToU8(value: number, vmin: number, vmax: number, depth: number): number {
  if (depth === 0) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }
  if (vmin >= 0 && vmax <= 1.0001) {
    return Math.max(0, Math.min(255, Math.round(value * 255)));
  }
  if (vmax > vmin) {
    return Math.max(0, Math.min(255, Math.round(((value - vmin) / (vmax - vmin)) * 255)));
  }
  return 0;
}

function readDepth(buffer: Buffer, offset: number, depth: number): number {
  if (offset < 0 || offset >= buffer.length) {
    return 0;
  }
  switch (depth) {
    case 0:
      return buffer[offset];
    case 1:
      return buffer.readInt8(offset);
    case 2:
      return buffer.readUInt16LE(offset);
    case 3:
      return buffer.readInt16LE(offset);
    case 4:
      return buffer.readInt32LE(offset);
    case 5:
      return buffer.readFloatLE(offset);
    case 6:
      return buffer.readDoubleLE(offset);
    default:
      return buffer[offset];
  }
}

function encodePng(pixels: Buffer, width: number, height: number, channels: 1 | 3): string {
  const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * width * channels, (y + 1) * width * channels);
  }
  const compressed = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk(Buffer.from("IHDR"), ihdr),
    pngChunk(Buffer.from("IDAT"), compressed),
    pngChunk(Buffer.from("IEND"), Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function pngChunk(type: Buffer, data: Buffer): Buffer {
  const payload = Buffer.concat([type, data]);
  const chunk = Buffer.alloc(8 + payload.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  payload.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(payload), 4 + payload.length);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function evaluate(
  session: vscode.DebugSession,
  frameId: number | undefined,
  expression: string,
): Promise<string> {
  const response = (await session.customRequest("evaluate", {
    expression,
    frameId,
    context: "repl",
  })) as { result?: string; success?: boolean; message?: string };
  if (!response?.result && response?.message) {
    throw new Error(response.message);
  }
  if (typeof response?.result !== "string") {
    throw new Error("empty evaluate result");
  }
  return response.result;
}

async function evalNumber(
  session: vscode.DebugSession,
  frameId: number | undefined,
  expression: string,
): Promise<number | undefined> {
  try {
    const raw = (await evaluate(session, frameId, expression)).trim();
    const match = raw.match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : undefined;
  } catch {
    return undefined;
  }
}

async function evalPointer(
  session: vscode.DebugSession,
  frameId: number | undefined,
  ...expressions: string[]
): Promise<string | undefined> {
  for (const expression of expressions) {
    try {
      const raw = (await evaluate(session, frameId, expression)).trim();
      const match = raw.match(/0x[0-9a-fA-F]+/);
      if (match) {
        return match[0];
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function parseDapJson(result: string): unknown {
  const trimmed = result.trim();
  const candidates = [trimmed];
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    candidates.unshift(decodePythonString(trimmed));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  throw new Error("extract payload was truncated or is not JSON");
}

function decodePythonString(quoted: string): string {
  if (quoted.startsWith('"')) {
    try {
      return JSON.parse(quoted);
    } catch {
      /* fall through */
    }
  }
  const inner = quoted.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[++i];
      const map: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        "\\": "\\",
        "'": "'",
        '"': '"',
      };
      out += map[next] ?? next;
    } else {
      out += ch;
    }
  }
  return out;
}

function titleFor(expression: string): string {
  const compact = expression.replace(/\s+/g, " ");
  return compact.length > 40 ? `Tensor: ${compact.slice(0, 37)}…` : `Tensor: ${compact}`;
}

export function renderHtml(webview: vscode.Webview, scriptUri: vscode.Uri): string {
  const nonce = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AutoSurg Tensor View</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --muted: var(--vscode-descriptionForeground, #9aa4b2);
      --border: var(--vscode-panel-border, #3c3c3c);
      --btn: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-fg: var(--vscode-button-secondaryForeground, #fff);
      --accent: var(--vscode-button-background, #0e639c);
    }
    html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 12px/1.4 var(--vscode-font-family, sans-serif); }
    #app { display: flex; flex-direction: column; height: 100%; }
    header, .toolbar {
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      padding: 6px 10px; border-bottom: 1px solid var(--border);
    }
    .workspace { display: flex; flex: 1; min-height: 0; }
    .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 36%; }
    .actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
    button, select {
      background: var(--btn); color: var(--btn-fg); border: 1px solid var(--border);
      border-radius: 4px; padding: 3px 8px; cursor: pointer;
    }
    button.active { outline: 1px solid var(--accent); }
    label { display: flex; gap: 6px; align-items: center; color: var(--muted); }
    input[type=range] { width: 120px; }
    #stage { position: relative; flex: 1; overflow: hidden; cursor: grab; background: #111; }
    #cv, #glcv { position: absolute; inset: 0; }
    #glcv[hidden], #cv[hidden] { display: none; }
    #overlay {
      position: absolute; inset: 0; display: grid; place-items: center;
      background: color-mix(in srgb, var(--bg) 72%, transparent); padding: 24px; text-align: center;
    }
    #overlay[hidden] { display: none; }
    #tip {
      position: absolute; pointer-events: none; background: rgba(0,0,0,.82); color: #fff;
      padding: 4px 8px; border-radius: 4px; font-variant-numeric: tabular-nums; z-index: 2;
    }
    #zoom { color: var(--muted); min-width: 42px; }
    #inspector {
      width: 228px; flex-shrink: 0; border-left: 1px solid var(--border);
      overflow: auto; padding: 10px;
    }
    #inspector h2 {
      margin: 0 0 8px; font-size: 11px; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--muted); font-weight: 600;
    }
    #inspector dl { display: grid; grid-template-columns: 78px 1fr; gap: 5px 8px; margin: 0 0 14px; }
    #inspector dt { color: var(--muted); }
    #inspector dd { margin: 0; word-break: break-word; font-variant-numeric: tabular-nums; }
    #inspector .row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    #dead { color: #f85149; }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <div class="title" id="expr">Tensor</div>
      <div class="actions">
        <span id="zoom">100%</span>
        <button id="fit">Fit</button>
        <button id="one">1:1</button>
        <button id="gridBtn">Grid</button>
        <button id="snap">Snapshot</button>
        <label><input type="checkbox" id="auto" checked> Auto</label>
        <button id="refresh">Refresh</button>
      </div>
    </header>
    <div class="toolbar">
      <label id="batchWrap" hidden>B <input type="range" id="batch" min="0" max="0" value="0"> <span id="batchVal">0</span></label>
      <label id="chanWrap" hidden>C <input type="range" id="channel" min="0" max="0" value="0"> <span id="chanVal">0</span></label>
      <label id="rgbWrap" hidden><input type="checkbox" id="rgb" checked> RGB</label>
      <label id="bgrWrap" hidden><input type="checkbox" id="bgr"> BGR→RGB</label>
      <label id="cmapWrap" hidden>Map
        <select id="cmap">
          <option value="viridis" selected>Viridis</option>
          <option value="jet">Jet</option>
          <option value="turbo">Turbo</option>
          <option value="magma">Magma</option>
          <option value="gray">Grayscale</option>
        </select>
      </label>
      <label id="viewAsWrap" hidden>View
        <select id="viewAs">
          <option value="auto" selected>Auto</option>
          <option value="image">Image</option>
          <option value="cloud">Point Cloud</option>
        </select>
      </label>
      <span id="cloudWrap" hidden>
        <label>Size <input type="range" id="ptSize" min="1" max="10" value="2"> <span id="ptSizeVal">2</span>px</label>
        <label>Color
          <select id="cloudColor">
            <option value="auto" selected>Auto</option>
            <option value="gray">Gray</option>
            <option value="cmap">Intensity</option>
            <option value="rgb">RGB</option>
            <option value="height">Height</option>
          </select>
        </label>
        <label>Up
          <select id="upAxis">
            <option value="2" selected>Z</option>
            <option value="1">Y</option>
            <option value="0">X</option>
          </select>
        </label>
      </span>
      <label>Diff
        <select id="diffMode">
          <option value="off">Off</option>
          <option value="split">A | B</option>
          <option value="residual">Residual</option>
        </select>
      </label>
    </div>
    <div class="workspace">
    <div id="stage">
      <canvas id="cv"></canvas>
      <canvas id="glcv" hidden></canvas>
      <div id="overlay">Pause the debugger, then right-click a tensor or Mat.</div>
      <div id="tip" hidden></div>
    </div>
    <aside id="inspector">
      <h2>Stats</h2>
      <dl id="stats"></dl>
      <h2>Compare</h2>
      <div class="row">
        <select id="snapList"><option value="">No snapshot</option></select>
        <button id="compareExpr">Compare expression…</button>
      </div>
      <div id="diffStats"></div>
    </aside>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
