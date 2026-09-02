#!/usr/bin/env python3
"""Stream AutoSurg system events as JSON lines on stdout (read-only).

Connects as a plain ZMQ SUB to the event bridge published by the system's
SystemSupervisor (``infra/zmq_event_bridge.py``, default
``ipc:///tmp/autosurg/system_events.pub.sock``) and prints one JSON object
per relevant event: ``{"event", "module", "kind", "ts"}`` (plus
``graph``/``node`` for graph execution events). Never sends anything back to
the system. Exits 0 on stdin EOF (the parent extension host went away) and
2 on unrecoverable setup errors, after emitting a final
``{"event": "relay:error", "error": ...}`` line.
"""

import json
import sys
import time


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    endpoint = (
        sys.argv[1]
        if len(sys.argv) > 1
        else "ipc:///tmp/autosurg/system_events.pub.sock"
    )
    try:
        import zmq  # provided by the system's own Python environment
    except Exception as exc:  # pragma: no cover - environment dependent
        emit({"event": "relay:error", "error": "pyzmq unavailable: %s" % exc})
        return 2
    try:
        context = zmq.Context.instance()
        sub = context.socket(zmq.SUB)
        sub.connect(endpoint)
        sub.setsockopt_string(zmq.SUBSCRIBE, "")
    except Exception as exc:
        emit({"event": "relay:error", "error": "connect failed: %s" % exc})
        return 2

    while True:
        try:
            raw = sub.recv_string()
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            emit({"event": "relay:error", "error": "recv failed: %s" % exc})
            return 1
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        event = str(msg.get("event") or "")
        payload = msg.get("payload") or {}
        module = payload.get("module") or payload.get("name") or ""
        if not module and not event.startswith("graph:"):
            continue
        out = {
            "event": event,
            "module": module,
            "kind": payload.get("kind") or "",
            "ts": float(msg.get("ts") or time.time()),
        }
        if event.startswith("graph:") or event.startswith("node"):
            out["graph"] = payload.get("graph_name") or ""
            out["node"] = payload.get("node_label") or payload.get("node_id") or ""
        emit(out)


if __name__ == "__main__":
    raise SystemExit(main())
