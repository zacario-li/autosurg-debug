import * as childProcess from "node:child_process";
import * as readline from "node:readline";
import * as vscode from "vscode";

export interface SystemEvent {
  event: string;
  module?: string;
  kind?: string;
  ts: number;
}

const VERBS: Record<string, string> = {
  started: "started",
  stopped: "stopped",
  crashed: "crashed",
  restarted: "restarted",
  cloned: "cloned",
};

const NOTE_WINDOW_S = 10 * 60;

/**
 * Keeps the last lifecycle event per module by tailing
 * `resources/event_relay.py` (a read-only ZMQ SUB inside the system's own
 * Python environment). The tree decorates module rows with "crashed 12s ago"
 * style notes; the system itself stores no history, so this ring is ours.
 */
export class EventTimeline implements vscode.Disposable {
  private proc: childProcess.ChildProcess | undefined;
  private latest = new Map<string, SystemEvent>();
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = true;
  private scriptPath = "";
  private python = "python3";
  public onEvent: ((event: SystemEvent) => void) | undefined;

  start(python: string, scriptPath: string): void {
    this.python = python;
    this.scriptPath = scriptPath;
    this.stopped = false;
    try {
      this.spawn();
    } catch {
      // Never let observer setup take down activation.
      this.stopped = true;
    }
  }

  noteFor(name: string): string | undefined {
    const event = this.latest.get(name);
    if (!event) {
      return undefined;
    }
    const suffix = event.event.split(":")[1] ?? "";
    const verb = VERBS[suffix];
    if (!verb) {
      return undefined;
    }
    const age = Math.max(0, Date.now() / 1000 - event.ts);
    if (age > NOTE_WINDOW_S) {
      return undefined;
    }
    const ago = age < 60 ? `${Math.max(1, Math.round(age))}s` : `${Math.round(age / 60)}m`;
    return `${verb} ${ago} ago`;
  }

  dispose(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.proc?.kill();
    this.proc = undefined;
  }

  private spawn(): void {
    if (this.stopped) {
      return;
    }
    let proc: childProcess.ChildProcess;
    try {
      proc = childProcess.spawn(this.python, [this.scriptPath], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // The configured interpreter does not exist (e.g. "python3" is absent
      // on Windows). Give up quietly instead of crash-looping.
      this.stopped = true;
      return;
    }
    this.proc = proc;
    proc.on("error", () => {
      // ENOENT/EACCES on spawn arrive here asynchronously: stop retrying.
      if (this.proc === proc) {
        this.proc = undefined;
      }
      this.stopped = true;
    });
    const lines = readline.createInterface({ input: proc.stdout! });
    lines.on("line", (line) => {
      let event: SystemEvent;
      try {
        event = JSON.parse(line) as SystemEvent;
      } catch {
        return;
      }
      if (typeof event.event !== "string") {
        return;
      }
      if (event.event === "relay:error") {
        // Environment lacks pyzmq or the endpoint: degrade silently, but do
        // not hammer the machine restarting a relay that can never work.
        this.stopped = true;
        return;
      }
      this.attempts = 0;
      if (event.module) {
        this.latest.set(event.module, event);
      }
      this.onEvent?.(event);
    });
    proc.on("close", () => {
      lines.close();
      if (this.proc === proc) {
        this.proc = undefined;
        this.scheduleRestart();
      }
    });
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) {
      return;
    }
    const delay = Math.min(30000, 2000 * 2 ** Math.min(4, this.attempts));
    this.attempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawn();
    }, delay);
  }
}
