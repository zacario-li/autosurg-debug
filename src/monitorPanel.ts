import * as vscode from "vscode";
import { PYTHON_TYPES } from "./tensorView";
import type { SystemEvent } from "./eventTimeline";

interface WatchEntry {
  id: number;
  expression: string;
  sessionName?: string;
  sessionId?: string;
  capturedAt?: number;
  detail?: string;
  error?: string;
}

interface EventRow {
  at: number;
  text: string;
}

const VERB: Record<string, string> = {
  started: "started",
  stopped: "stopped",
  crashed: "CRASHED",
  restarted: "restarted",
  cloned: "cloned",
};

/** Python snippet shared by all watch captures; must never raise. */
const PROBE_SRC = [
  "def __w(v):",
  "    import json",
  "    out = {'ok': True, 'type': type(v).__name__}",
  "    try:",
  "        import numpy as _np",
  "        raw = v",
  "        if hasattr(raw, 'detach'):",
  "            raw = raw.detach()",
  "        if hasattr(raw, 'cpu') and callable(getattr(raw, 'cpu', None)):",
  "            raw = raw.cpu()",
  "        arr = raw.numpy() if hasattr(raw, 'numpy') and callable(getattr(raw, 'numpy', None)) else _np.asarray(raw)",
  "        if getattr(arr, 'dtype', None) is None or arr.dtype == object:",
  "            raise TypeError('non-array')",
  "        if arr.size > 3000000:",
  "            arr = arr.reshape(-1)[:: max(1, arr.size // 300000)]",
  "        out['shape'] = list(getattr(v, 'shape', arr.shape))",
  "        out['dtype'] = str(arr.dtype)",
  "        if _np.issubdtype(arr.dtype, _np.number):",
  "            f = arr.astype('float64').reshape(-1)",
  "            f = f[_np.isfinite(f)]",
  "            if f.size:",
  "                out['min'] = float(f.min())",
  "                out['max'] = float(f.max())",
  "                out['mean'] = float(f.mean())",
  "    except Exception:",
  "        try:",
  "            out['text'] = repr(v)[:140].replace(chr(10), ' ')",
  "        except Exception:",
  "            pass",
  "    return json.dumps(out, default=str)",
].join("\n");

export function probeExpression(expression: string): string {
  return (
    `(lambda __g, __obj: (__import__('builtins').exec(${JSON.stringify(
      PROBE_SRC,
    )}, __g) or __g['__w'](__obj)))` +
    `({'__builtins__': __import__('builtins')}, (${expression}))`
  );
}

export class MonitorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private entries: WatchEntry[] = [];
  private nextId = 1;
  private events: EventRow[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastFrame = new Map<string, number>();
  private sweeping = false;
  private sweepQueued = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly webui: () => { host: string; port: number },
  ) {
    // Capability-gated: cheap insurance for editor builds predating this API
    // (Cursor forks lag VS Code); activation must never depend on it.
    const debugAnything = vscode.debug as unknown as {
      onDidChangeActiveStackItem?: (
        listener: (item: unknown) => void,
      ) => vscode.Disposable;
    };
    if (typeof debugAnything.onDidChangeActiveStackItem === "function") {
      context.subscriptions.push(
        debugAnything.onDidChangeActiveStackItem!((item) => {
          const anyItem = item as
            | { session?: vscode.DebugSession; frameId?: number }
            | undefined;
          if (
            anyItem?.session &&
            PYTHON_TYPES.has(anyItem.session.type) &&
            typeof anyItem.frameId === "number"
          ) {
            this.lastFrame.set(anyItem.session.id, anyItem.frameId);
          }
        }),
      );
    }
  }

  show(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "autosurg.monitor",
        "AutoSurg Monitor",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.webview.html = this.renderHtml();
      this.panel.iconPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "autosurg.svg",
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.stopPolling();
      });
      this.panel.webview.onDidReceiveMessage((message) => {
        void this.onMessage(message);
      });
      this.startPolling();
    }
    this.panel.reveal(undefined, true);
    void this.pushSnapshot();
  }

  /** Called for every relayed system event (lifecycle timeline feed). */
  handleEvent(event: SystemEvent): void {
    const suffix = event.event.split(":")[1] ?? event.event;
    this.events.unshift({
      at: Date.now(),
      text: `${event.module || "system"} ${VERB[suffix] ?? suffix}`,
    });
    if (this.events.length > 80) {
      this.events.length = 80;
    }
    void this.pushSnapshot();
  }

  async promptAdd(): Promise<void> {
    const sessions = currentPythonSessions();
    let sessionName: string | undefined;
    let sessionId: string | undefined;
    const active = vscode.debug.activeStackItem;
    if (active && "frameId" in active && PYTHON_TYPES.has(active.session.type)) {
      sessionName = active.session.name;
      sessionId = active.session.id;
    } else if (sessions.length > 0) {
      const picks = await vscode.window.showQuickPick(
        sessions.map((s) => ({ label: s.name, description: s.type })),
        { placeHolder: "Attach point for this watch expression" },
      );
      if (!picks) {
        return;
      }
      const found = sessions.find((s) => s.name === picks.label);
      sessionName = found?.name;
      sessionId = found?.id;
    }
    const expression = await vscode.window.showInputBox({
      prompt: "Watch expression (evaluated when the target is paused)",
      value: sessionName
        ? `from ${sessionName}: `
        : "",
      validateInput: (v) => (v.includes("from ") ? undefined : v ? undefined : "empty"),
    });
    if (!expression) {
      return;
    }
    this.addEntry(expression.replace(/^from .*?: /, ""), sessionName, sessionId);
  }

  addEntry(raw: string, sessionName?: string, sessionId?: string): void {
    const expression = raw.trim();
    if (!expression) {
      return;
    }
    if (
      this.entries.some(
        (e) => e.expression === expression && e.sessionName === sessionName,
      )
    ) {
      void vscode.window.showInformationMessage(
        `Already watched: ${expression}`,
      );
      return;
    }
    this.entries.push({ id: this.nextId++, expression, sessionName, sessionId });
    this.show();
    void this.sweep();
  }

  /** Capture every watchable entry whose session is currently stopped. */
  async sweep(): Promise<void> {
    if (this.sweeping) {
      this.sweepQueued = true;
      return;
    }
    this.sweeping = true;
    try {
      const sessions = currentPythonSessions();
      const active = vscode.debug.activeStackItem;
      const promises: Promise<void>[] = [];
      for (const entry of this.entries) {
        const target =
          sessions.find((s) => s.id === entry.sessionId) ??
          (entry.sessionName
            ? sessions.find((s) => s.name === entry.sessionName)
            : active && "frameId" in active
              ? active.session
              : undefined);
        const frameId = target
          ? this.lastFrame.get(target.id) ??
            (active && "frameId" in active && active.session === target
              ? (active.frameId as number)
              : undefined)
          : undefined;
        if (!target || frameId === undefined) {
          continue;
        }
        promises.push(this.capture(entry, target, frameId));
      }
      await Promise.allSettled(promises);
    } finally {
      this.sweeping = false;
      await this.pushSnapshot();
      if (this.sweepQueued) {
        this.sweepQueued = false;
        void this.sweep();
      }
    }
  }

  private async capture(
    entry: WatchEntry,
    session: vscode.DebugSession,
    frameId: number,
  ): Promise<void> {
    try {
      const response = (await session.customRequest("evaluate", {
        expression: probeExpression(entry.expression),
        frameId,
        context: "repl",
      })) as { result?: string; message?: string };
      if (!response?.result) {
        throw new Error(response?.message ?? "empty result");
      }
      const parsed = JSON.parse(response.result) as {
        type?: string;
        shape?: number[];
        dtype?: string;
        min?: number;
        max?: number;
        mean?: number;
        text?: string;
      };
      const bits: string[] = [];
      if (parsed.shape) {
        bits.push(`(${parsed.shape.join(", ")})`);
      }
      if (parsed.dtype) {
        bits.push(parsed.dtype);
      }
      if (parsed.type && !parsed.shape) {
        bits.push(parsed.type);
      }
      if (parsed.min !== undefined && parsed.max !== undefined) {
        bits.push(
          `${fmt(parsed.min)} … ${fmt(parsed.max)}` +
            (parsed.mean !== undefined ? ` · μ ${fmt(parsed.mean)}` : ""),
        );
      }
      if (parsed.text) {
        bits.push(parsed.text);
      }
      entry.detail = bits.join("  ") || parsed.type || "—";
      entry.capturedAt = Date.now();
      entry.error = undefined;
      entry.sessionName = session.name;
      entry.sessionId = session.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.trim() !== "notStopped" && !/\bnotStopped\b/.test(message)) {
        entry.error = message.slice(0, 80);
      }
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pushSnapshot();
    }, 2500);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pushSnapshot(): Promise<void> {
    if (!this.panel || !this.panel.visible) {
      return;
    }
    const { host, port } = this.webui();
    const [streams, modules] = await Promise.all([
      fetchJson(host, port, "/api/streams"),
      fetchJson(host, port, "/api/modules"),
    ]);
    void this.panel.webview.postMessage({
      type: "snapshot",
      streams: streams ?? null,
      modules: modules ?? null,
      watches: this.entries.map((e) => ({ ...e })),
      events: this.events.slice(0, 40),
      at: Date.now(),
    });
  }

  private async onMessage(message: {
    type?: string;
    id?: number;
  }): Promise<void> {
    if (message.type === "add") {
      await this.promptAdd();
    } else if (message.type === "refresh") {
      await this.sweep();
    } else if (message.type === "remove" && typeof message.id === "number") {
      this.entries = this.entries.filter((e) => e.id !== message.id);
      await this.pushSnapshot();
    }
  }

  dispose(): void {
    this.stopPolling();
    this.panel?.dispose();
  }

  private renderHtml(): string {
    const nonce = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 36).toString(36),
    ).join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; padding: 10px 14px; font: 12px/1.5 var(--vscode-font-family, sans-serif);
    background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--vscode-descriptionForeground); margin: 16px 0 6px; }
  .bar { display: flex; gap: 8px; align-items: center; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: 0; padding: 3px 10px; cursor: pointer; border-radius: 2px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; min-width: 130px; }
  .card b { font-size: 15px; display: block; }
  .card small { color: var(--vscode-descriptionForeground); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 3px 8px 3px 0; vertical-align: baseline;
    border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); font-weight: 400; font-size: 11px; }
  code { font-family: var(--vscode-editor-font-family, monospace); }
  .muted { color: var(--vscode-descriptionForeground); }
  .err { color: var(--vscode-errorForeground); }
  .evt { color: var(--vscode-descriptionForeground); }
  svg { vertical-align: bottom; }
</style>
</head>
<body>
  <div class="bar">
    <button class="primary" id="add">+ Watch expression</button>
    <button id="refresh">⟳ Capture now</button>
    <span id="status">…</span>
  </div>
  <h2>Streams · live</h2>
  <div class="grid" id="streams"><span class="muted">waiting for ${"" /*filled at runtime*/}WebUI…</span></div>
  <h2>Modules</h2>
  <div class="grid" id="mods"></div>
  <h2>Watches · captured on pause</h2>
  <table id="watch"><thead><tr><th>Expression</th><th>Target</th><th>Value</th><th>Age</th><th></th></tr></thead><tbody></tbody></table>
  <h2>Recent events</h2>
  <div id="events" class="evt muted">none yet</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const fpsHist = {};
  let last = null;
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type !== "snapshot") return;
    last = msg;
    if (msg.streams) {
      for (const [name, st] of Object.entries(msg.streams)) {
        const h = (fpsHist[name] = fpsHist[name] || []);
        h.push(st && typeof st.fps === "number" ? st.fps : 0);
        if (h.length > 60) h.shift();
      }
    }
    render();
  });
  document.getElementById("add").addEventListener("click", () =>
    vscode.postMessage({ type: "add" }));
  document.getElementById("refresh").addEventListener("click", () =>
    vscode.postMessage({ type: "refresh" }));
  document.addEventListener("click", (event) => {
    const del = event.target && event.target.closest && event.target.closest("[data-del]");
    if (del) vscode.postMessage({ type: "remove", id: Number(del.getAttribute("data-del")) });
  });
  setInterval(() => { if (last) render(); }, 1000);
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function ago(ts) {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 60 ? s + "s" : Math.round(s / 60) + "m";
  }
  function spark(h) {
    if (!h || h.length < 2) return "";
    const w = 90, hgt = 22, max = Math.max(1, ...h);
    const pts = h.map((v, i) => (i / (h.length - 1)) * w + "," + (hgt - (v / max) * (hgt - 2) - 1)).join(" ");
    return '<svg width="' + w + '" height="' + hgt + '"><polyline fill="none" stroke="currentColor" points="' + pts + '"/></svg>' +
      ' <small class="muted">max ' + max.toFixed(1) + "</small>";
  }
  function fmt(v) { return typeof v === "number" ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(3)) : String(v); }
  function render() {
    if (!last) return;
    document.getElementById("status").textContent =
      (last.streams ? "WebUI online" : "WebUI offline (start main.py / check autosurg.webuiPort)") +
      " · polled " + ago(last.at);
    const streams = document.getElementById("streams");
    if (last.streams) {
      streams.innerHTML = Object.entries(last.streams).map(function (row) {
        const name = row[0], st = row[1] || {};
        const fps = typeof st.fps === "number" ? st.fps : null;
        const meta = [];
        if (st.frame_number !== undefined) meta.push("f" + st.frame_number);
        if (st.net_ms !== undefined) meta.push("net " + fmt(st.net_ms) + "ms");
        if (st.idle) meta.push("idle");
        return '<div class="card"><small>' + esc(name) + "</small><b>" +
          (fps === null ? "—" : fps.toFixed(1) + " fps") + "</b>" +
          spark(fpsHist[name]) + "<br><small>" + esc(meta.join(" · ")) + "</small></div>";
      }).join("");
    }
    const mods = document.getElementById("mods");
    if (last.modules && Array.isArray(last.modules.items)) {
      mods.innerHTML = last.modules.items.map(function (m) {
        const color = m.restarting ? "var(--vscode-editorWarning-foreground, #cca700)"
          : m.running ? "var(--vscode-charts-green, #89d185)"
          : "var(--vscode-descriptionForeground, #888)";
        const extra = m.replica_count !== undefined ? " " + m.replica_count + "r" : "";
        return '<div class="card"><span class="dot" style="background:' + color + '"></span>' +
          esc(m.name) + (m.kind ? ' <small class="muted">' + esc(m.kind) + "</small>" : "") +
          "<b style=\"font-size:12px\">" + (m.restarting ? "restarting" : m.running ? "running" : "stopped") + extra + "</b></div>";
      }).join("");
    } else if (last.modules === null) {
      mods.innerHTML = '<span class="muted">unreachable</span>';
    }
    const tbody = document.querySelector("#watch tbody");
    if (!last.watches.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">No watches yet — click “+ Watch expression”. Values are captured whenever the target process is stopped at a breakpoint or step.</td></tr>';
    } else {
      tbody.innerHTML = last.watches.map(function (w) {
        const value = w.error ? '<span class="err">' + esc(w.error) + "</span>"
          : w.detail ? "<code>" + esc(w.detail) + "</code>"
          : '<span class="muted">waiting for a pause…</span>';
        return "<tr><td><code>" + esc(w.expression) + "</code></td>" +
          '<td class="muted">' + esc(w.sessionName || "any") + "</td>" +
          "<td>" + value + "</td>" +
          '<td class="muted">' + ago(w.capturedAt) + "</td>" +
          '<td><button data-del="' + w.id + '">×</button></td></tr>';
      }).join("");
    }
    const events = document.getElementById("events");
    events.innerHTML = last.events.length
      ? last.events.map(function (e) { return esc(ago(e.at) + " ago — " + e.text); }).join("<br>")
      : "none yet";
  }
})();
</script>
</body>
</html>`;
  }
}

function currentPythonSessions(): vscode.DebugSession[] {
  const debugApi = vscode.debug as typeof vscode.debug & {
    activeDebugSessions?: readonly vscode.DebugSession[];
  };
  const all = debugApi.activeDebugSessions ?? [
    ...(debugApi.activeDebugSession ? [debugApi.activeDebugSession] : []),
  ];
  return all.filter((s) => PYTHON_TYPES.has(s.type));
}

function fetchJson(
  host: string,
  port: number,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  const fetchFn = (
    globalThis as {
      fetch?: (
        url: string,
        init?: { signal?: { clearTimeout: (t: unknown) => void } | unknown },
      ) => Promise<{
        ok: boolean;
        json: () => Promise<Record<string, unknown>>;
      }>;
    }
  ).fetch;
  const signalApi = (
    globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }
  ).AbortSignal;
  if (!fetchFn) {
    return Promise.resolve(undefined);
  }
  return fetchFn(`http://${host}:${port}${path}`, {
    signal: signalApi?.timeout ? signalApi.timeout(1800) : undefined,
  })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined);
}

function fmt(v: number): string {
  return Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.001)
    ? v.toExponential(2)
    : String(Number(v.toFixed(4)));
}
