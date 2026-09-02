import * as http from "node:http";
import * as vscode from "vscode";

export interface LogStreamTarget {
  host: string;
  port: number;
}

interface LogEntry extends Record<string, unknown> {
  time?: string;
  level?: string;
  name?: string;
  message?: string;
  function?: string;
  line?: number | string;
  file?: string;
  process?: string;
  request_id?: string;
}

const RECONNECT_MAX_MS = 15000;
const PENDING_MAX_LINES = 4000;

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

/**
 * Level colors mirrored from loguru's defaults (loguru/_defaults.py):
 * TRACE "<cyan><bold>", DEBUG "<blue><bold>", INFO "<bold>",
 * SUCCESS "<green><bold>", WARNING "<yellow><bold>", ERROR "<red><bold>",
 * CRITICAL "<RED><bold>" (red background). The default loguru format wraps
 * {time} in green, {name}:{function}:{line} in cyan, and {level}/{message}
 * in the level color; we reproduce exactly that.
 */
const LEVEL_SGR: Record<string, string> = {
  TRACE: `${ESC}1;36m`,
  DEBUG: `${ESC}1;34m`,
  INFO: `${ESC}1m`,
  SUCCESS: `${ESC}1;32m`,
  WARNING: `${ESC}1;33m`,
  ERROR: `${ESC}1;31m`,
  CRITICAL: `${ESC}1;41m`,
};
const TIME_SGR = `${ESC}32m`;
const ORIGIN_SGR = `${ESC}36m`;
const RID_SGR = `${ESC}4;36m`; // underlined cyan: our own trace-id convention
const SYS_SGR = `${ESC}90m`; // dim gray for extension banners

type Socket = {
  close?: () => void;
  send?: (data: string) => void;
  onopen?: (() => void) | null;
  onmessage?: ((event: { data?: unknown }) => void) | null;
  onclose?: (() => void) | null;
  onerror?: (() => void) | null;
};

// Only CSI ... m (SGR) sequences are allowed through; every other complete
// CSI sequence (alt screen, cursor, title OSC via BEL, ...) is stripped.
const sgrToken = /\x1b\[[0-9;]*m/g;
const anyCsi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const osc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** >= + ESC literal (\x1b): control chars that would corrupt a terminal line. */
// eslint-disable-next-line no-control-regex
const unsafeControl = /[\x00-\x08\x0a-\x0d\x0e-\x1a]/g;

/**
 * Tail of the system WebUI log stream (`/api/logs/stream`).
 *
 * Wire protocol of the AutoSurg system WebUI (FastAPI, port = ControlPlane
 * port - 8): the first frame is `{"recent":[...]}` (up to 200 buffered
 * entries), live frames are plain JSON arrays of at most 50 log entries, and
 * `{"ping":true}` frames are keepalive probes that we mirror with a `ping`
 * text message. Read-mostly: the only bytes ever sent are keepalive.
 *
 * Presentation: VS Code Output channels never render ANSI colors (excluding
 * `messageOptions` file tailing). Colored output therefore renders inside a
 * pseudoterminal, which uses the real xterm.js renderer. The pseudoterminal
 * never spawns a process: bytes come from our WebSocket connection.
 */
export class LogStreamPanel implements vscode.Disposable {
  private channel: vscode.OutputChannel | undefined;
  private terminal: vscode.Terminal | undefined;
  private ptyWrite: vscode.EventEmitter<string> | undefined;
  private ptyReady = false;
  private pending: string[] = [];
  private pendingBytes = 0;
  private terminalClosedSub: vscode.Disposable | undefined;
  private socket: Socket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;
  private target: LogStreamTarget | undefined;
  private mode: "terminal" | "output" | "both" = "terminal";

  constructor(private readonly extensionUri: vscode.Uri) {}

  open(target: LogStreamTarget): void {
    const alreadyConnected = Boolean(this.socket);
    const settings = vscode.workspace.getConfiguration("autosurg");
    const raw = settings.get<string>("logView", "terminal");
    this.mode =
      raw === "output" || raw === "both" ? raw : "terminal";
    this.target = target;
    this.stopped = false;
    this.attempt = 0;
    // Switching views shows live entries only from now on; no stale replay.
    this.pending = [];
    this.pendingBytes = 0;
    if (this.mode !== "output") {
      this.ensureTerminal();
    }
    if (this.mode !== "terminal") {
      if (!this.channel) {
        this.channel = vscode.window.createOutputChannel(
          "AutoSurg System Logs",
        );
      }
      this.channel.clear();
      this.channel.show(true);
    }
    if (alreadyConnected) {
      return; // one socket serves the reopened view; no duplicate stream
    }
    void this.connect();
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      this.socket?.close?.();
    } catch {
      /* socket already gone */
    }
    this.socket = undefined;
    this.channel?.dispose();
    this.channel = undefined;
    this.terminalClosedSub?.dispose();
    this.terminalClosedSub = undefined;
    this.terminal?.dispose();
    this.terminal = undefined;
    this.ptyWrite?.dispose();
    this.ptyWrite = undefined;
  }

  private ensureTerminal(): void {
    if (this.terminal) {
      this.terminal.show(true);
      this.ptyWrite?.fire(`${ESC}c`); // clear screen on (re)open
      return;
    }
    const writes = new vscode.EventEmitter<string>();
    this.ptyWrite = writes;
    const panel = this;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writes.event,
      open() {
        panel.ptyReady = true;
        panel.flushPending();
      },
      close() {
        panel.ptyReady = false;
      },
    };
    this.terminal = vscode.window.createTerminal({
      name:
        "AutoSurg System Logs" +
        (this.target ? ` (${this.target.host}:${this.target.port})` : ""),
      iconPath: vscode.Uri.joinPath(
        this.extensionUri,
        "media",
        "autosurg.svg",
      ),
      pty,
    });
    if (!this.terminalClosedSub) {
      this.terminalClosedSub = vscode.window.onDidCloseTerminal((closed) => {
        if (closed === this.terminal) {
          this.terminal = undefined;
          this.ptyReady = false;
          this.ptyWrite?.dispose();
          this.ptyWrite = undefined;
          // Closing the log view tears down the transport; the next command
          // opens a fresh terminal and reconnects cleanly.
          this.stopped = true;
          if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
          }
          try {
            this.socket?.close?.();
          } catch {
            /* already gone */
          }
          this.socket = undefined;
        }
      });
    }
    this.terminal.show(true);
  }

  /** Route one formatted line to the active sinks. */
  private write(colored: string, plain: string): void {
    if (this.mode !== "output") {
      if (this.ptyReady && this.ptyWrite) {
        this.ptyWrite.fire(sanitizeForTerminal(colored) + "\r\n");
      } else {
        this.pending.push(colored + "\r\n");
        this.pendingBytes += colored.length + 2;
        while (
          this.pending.length > PENDING_MAX_LINES ||
          this.pendingBytes > 4 * 1024 * 1024
        ) {
          this.pendingBytes -= this.pending.shift()?.length ?? 0;
        }
      }
    }
    if (this.mode !== "terminal" && this.channel) {
      this.channel.appendLine(plain);
    }
  }

  private flushPending(): void {
    if (!this.ptyWrite) {
      return;
    }
    const data = this.pending.map((line) => sanitizeForTerminal(line)).join("");
    this.pending = [];
    this.pendingBytes = 0;
    if (data) {
      this.ptyWrite.fire(data);
    }
  }

  private banner(text: string): void {
    this.write(`${SYS_SGR}${text}${RESET}`, text);
  }

  private async connect(): Promise<void> {
    const target = this.target;
    if (!target || this.stopped) {
      return;
    }
    const online = await probeHttp(target.host, target.port);
    if (this.stopped) {
      return;
    }
    if (!online) {
      this.banner(
        `[autosurg] system WebUI unreachable at http://${target.host}:${target.port} ` +
          "(start the system with main.py, or set autosurg.webuiPort). Retrying...",
      );
      this.scheduleReconnect();
      return;
    }
    const Ctor = (
      globalThis as {
        WebSocket?: new (url: string) => NonNullable<Socket>;
      }
    ).WebSocket;
    if (!Ctor) {
      this.banner(
        "[autosurg] this VS Code runtime has no WebSocket client; log streaming unavailable.",
      );
      return;
    }
    const url = `ws://${target.host}:${target.port}/api/logs/stream`;
    try {
      this.socket = new Ctor(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    const socket = this.socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.banner(`[autosurg] connected to ${url}`);
    };
    socket.onmessage = (event) => {
      const raw = event?.data;
      if (typeof raw !== "string") {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.write(String(raw), String(raw));
        return;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (obj.ping === true) {
          try {
            socket.send?.("ping");
          } catch {
            /* keepalive is best-effort */
          }
          return;
        }
        if (obj.pong === true) {
          return;
        }
        if (Array.isArray(obj.recent)) {
          this.emitBatch(obj.recent, "(backfill)");
          return;
        }
      }
      if (Array.isArray(parsed)) {
        this.emitBatch(parsed);
        return;
      }
      this.emitEntry(parsed);
    };
    socket.onclose = () => {
      if (!this.stopped && this.socket === socket) {
        this.banner("[autosurg] log stream closed; reconnecting...");
        this.scheduleReconnect();
      }
    };
    socket.onerror = () => {
      try {
        socket.close?.();
      } catch {
        /* onclose will follow */
      }
    };
  }

  private emitBatch(entries: unknown[], note?: string): void {
    if (entries.length === 0) {
      return;
    }
    if (note) {
      this.banner(
        `[autosurg] ${entries.length} recent entries ${note}`,
      );
    }
    for (const entry of entries) {
      this.emitEntry(entry);
    }
  }

  private emitEntry(entry: unknown): void {
    if (typeof entry === "string") {
      this.write(entry, entry);
      return;
    }
    if (!entry || typeof entry !== "object") {
      const text = String(entry);
      this.write(text, text);
      return;
    }
    const e = entry as LogEntry;
    if (typeof e.message !== "string") {
      const text = JSON.stringify(entry);
      this.write(text, text);
      return;
    }
    const level = String(e.level ?? "").toUpperCase();
    const levelSgr = LEVEL_SGR[level] ?? `${ESC}1m`;
    const origin = [e.name, e.function, e.line]
      .filter((part) => part !== undefined && part !== null && part !== "")
      .join(":");
    // Mirrors loguru's default format:
    // <green>time</green> | <level>level    </level> | <cyan>origin</cyan> - <level>message</level>
    const head =
      `${TIME_SGR}${e.time ?? ""}${RESET} | ` +
      `${levelSgr}${level.padEnd(8)}${RESET} | ` +
      (origin
        ? `${ORIGIN_SGR}${origin}${RESET}` + (hasRid(e) ? " " : "")
        : "") +
      (hasRid(e) ? `${RID_SGR}rid=${e.request_id}${RESET} ` : "") +
      `- `;
    const plainHead =
      `[${e.time ?? ""}] ${level.padEnd(8)} ` +
      (origin ? `${origin} ` : "") +
      (hasRid(e) ? `rid=${e.request_id} ` : "") +
      "- ";
    const messageLines = e.message.split("\n");
    this.write(
      head + levelSgr + messageLines[0] + RESET,
      plainHead + messageLines[0],
    );
    for (let i = 1; i < messageLines.length; i += 1) {
      // Continuation lines (tracebacks) keep the level color, like loguru.
      this.write(levelSgr + messageLines[i] + RESET, messageLines[i]);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) {
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      1000 * 2 ** Math.min(4, this.attempt),
    );
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }
}

function hasRid(entry: LogEntry): boolean {
  return Boolean(entry.request_id) && entry.request_id !== "-";
}

/**
 * Keep terminal data audience-safe: transparently pass real ANSI color
 * sequences through, drop anything after a stray ESC that is not a color
 * token, and strip control characters that could rewrite the prompt line.
 */
function sanitizeForTerminal(line: string): string {
  if (line.indexOf("\x1b") === -1 && !unsafeControl.test(line)) {
    return line;
  }
  unsafeControl.lastIndex = 0;
  unsafeControl.lastIndex = 0;
  // Keep SGR color tokens, drop everything else an untrusted stream could
  // send (alt-screen, cursor moves, OSC title changes, orphan ESC bytes).
  let cleaned = line.replace(osc, "");
  const keep: string[] = [];
  cleaned = cleaned.replace(sgrToken, (m) => {
    keep.push(m);
    return "\u0001";
  });
  cleaned = cleaned.replace(anyCsi, "").replace(/\x1b/g, "");
  cleaned = cleaned.replace(/\u0001/g, () => keep.shift() ?? "");
  unsafeControl.lastIndex = 0;
  return cleaned.replace(unsafeControl, "");
}

/** Exported for unit testing of the palette + format. */
export const __test = { LEVEL_SGR, sanitizeForTerminal };

function probeHttp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      { host, port, path: "/api/ping", timeout: 1500 },
      (response) => {
        response.resume();
        resolve(
          (response.statusCode ?? 0) > 0 && (response.statusCode ?? 0) < 500,
        );
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}
