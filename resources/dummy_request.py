#!/usr/bin/env python3
"""Fire one RPC request at a standalone AutoSurg compute worker.

Used by the AutoSurg Debug extension's "Send Request to Dummy Worker" entry:
a standalone ``workers/run_compute_worker.py --dummy-shm`` process is not
registered with any ComputeRegistry, so nothing routes to its endpoint and the
request-driven compute loop never runs. This script connects a one-shot DEALER
(the same shape ``infra/zmq_client.ZmqClient`` uses), sends a JSON request, and
prints one JSON verdict line.

Usage::

    python dummy_request.py <endpoint> <json-request> [timeout_ms]

Output (stdout, single JSON object)::

    {"ok": true, "reply": {...}, "binary": [{"name": "...", "bytes": 123}]}
    {"ok": false, "error": "..."}            -> exit 1

Uses only ``zmq`` + stdlib so it runs under any module interpreter (conda envs,
venvs) without importing the project's ``infra`` package. Multipart replies are
decoded with the same ``__bin__`` framing as ``infra/rpc_frames.py``: the binary
frames are *not* printed (they can be megabytes), only named and measured.

Note: a hit breakpoint blocks the worker's reply, so a timeout while a
breakpoint is suspended is expected - re-send after continuing.
"""

import json
import sys
import time

BIN_KEYS_KEY = "__bin__"

#: Long strings in a reply are usually payloads nobody reads in a log line
#: (base64 frames, serialized masks). Truncate them where the semantics allow
#: it, so the reply stays readable in the output panel and bounded on the wire
#: into the extension host.
MAX_STRING_CHARS = 4096
MAX_SEQUENCE_ITEMS = 50


def trim(value):
    """Recursively shorten huge values for display, keeping structure visible."""
    if isinstance(value, str):
        if len(value) <= MAX_STRING_CHARS:
            return value
        return "<%d chars, first %d: %s…>" % (len(value), 120, value[:120])
    if isinstance(value, dict):
        return {str(k): trim(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        items = [trim(item) for item in value[:MAX_SEQUENCE_ITEMS]]
        if len(value) > MAX_SEQUENCE_ITEMS:
            items.append("<+%d more items>" % (len(value) - MAX_SEQUENCE_ITEMS))
        return items
    return value


def emit(obj: dict, code: int = 0) -> int:
    line = json.dumps(obj, ensure_ascii=False, default=str) + "\n"
    try:
        sys.stdout.write(line)
        sys.stdout.flush()
    except BrokenPipeError:
        # Reader went away (piped into head, or the extension killed us after a
        # timeout). Nothing to report and nothing to fix - stay silent rather
        # than printing a traceback that would look like a worker failure.
        try:
            os.close(sys.stdout.fileno())
        except OSError:
            pass
    return code


def identity(payload: dict) -> dict:
    """Mirror the minimal client-side envelope (request_id for tracing)."""
    if "request_id" in payload:
        return payload
    out = dict(payload)
    out["request_id"] = "autosurg-dbg-%d" % int(time.time() * 1000)
    return out


def main() -> int:
    if len(sys.argv) < 3:
        emit({"ok": False, "error": "usage: dummy_request.py <endpoint> <json> [timeout_ms]"})
        return 2
    endpoint = sys.argv[1]
    raw_request = sys.argv[2]
    try:
        timeout_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 30000
    except ValueError:
        emit({"ok": False, "error": "timeout_ms must be an integer: %r" % sys.argv[3]})
        return 2
    try:
        request = json.loads(raw_request)
    except Exception as exc:
        emit({"ok": False, "error": "request is not valid JSON: %s" % exc})
        return 2
    if not isinstance(request, dict):
        emit({"ok": False, "error": "request must be a JSON object"})
        return 2

    try:
        import zmq  # provided by the module's own Python environment
    except Exception as exc:  # pragma: no cover - environment dependent
        emit({"ok": False, "error": "pyzmq unavailable in this interpreter: %s" % exc})
        return 2

    context = None
    socket = None
    try:
        context = zmq.Context.instance()
        socket = context.socket(zmq.DEALER)
        socket.setsockopt(zmq.LINGER, 0)
        socket.setsockopt(zmq.RCVTIMEO, timeout_ms)
        socket.setsockopt(zmq.SNDTIMEO, timeout_ms)
        socket.connect(endpoint)
        socket.send_string(json.dumps(identity(request)))
        frames = socket.recv_multipart()
    except zmq.Again:
        emit(
            {
                "ok": False,
                "error": "no reply within %d ms - is the worker up, and is a breakpoint holding it?"
                % timeout_ms,
                "timeout": True,
                "endpoint": endpoint,
            },
            1,
        )
        return 1
    except Exception as exc:
        emit(
            {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc), "endpoint": endpoint},
            1,
        )
        return 1
    finally:
        if socket is not None:
            socket.close(linger=0)

    body = [frame for frame in frames if frame != b""]
    if not body:
        emit({"ok": False, "error": "empty response", "endpoint": endpoint})
        return 1
    try:
        reply = json.loads(body[0].decode("utf-8"))
    except Exception as exc:
        emit({"ok": False, "error": "response is not JSON: %s (%r)" % (exc, body[0][:200])})
        return 1

    binary = []
    bin_names = reply.pop(BIN_KEYS_KEY, None) if isinstance(reply, dict) else None
    if isinstance(bin_names, list):
        for index, name in enumerate(bin_names):
            frame = body[index + 1] if index + 1 < len(body) else b""
            binary.append({"name": str(name), "bytes": len(frame)})
        if len(bin_names) != len(body) - 1:
            emit(
                {
                    "ok": False,
                    "error": "malformed multipart response: %d binary keys, %d frames"
                    % (len(bin_names), len(body) - 1),
                }
            )
            return 1

    emit(
        {
            "ok": True,
            "endpoint": endpoint,
            "request": request,
            "reply": trim(reply),
            "binary": binary,
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
