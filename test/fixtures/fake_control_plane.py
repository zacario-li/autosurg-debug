#!/usr/bin/env python3
"""Fake AutoSurg ControlPlane for attach failure-injection tests.

Speaks the verified ControlPlane wire contract (ZMQ REP, one JSON object per
message) using reply shapes copied from the real system side:

  runtime/control_plane.py      - {"status":"error","message":"unknown action: X"}
  runtime/system_supervisor.py  - {"status":"error","code":"RPC_TIMEOUT", ...},
                                  "unknown module: X", "X is not running",
                                  "X is not a compute module",
                                  "X has no compute address"
  infra/debugpy_runtime.py      - codes DEBUGPY_IMPORT / DEBUGPY_LISTEN, and the
                                  ok reply {status, host, port, already, pid}

Exactly one `--fault` per process so each test asserts one cause. With
`--listen` the fake really binds the advertised debug port, so the harness
attach probe is a real TCP connect rather than a stub.
"""

import argparse
import json
import socket
import sys
import time

import zmq

FAULTS = (
    "none",
    "no-start-debug",
    "debugpy-import",
    "debugpy-listen",
    "worker-rpc-timeout",
    "worker-unavailable",
    "handler-error",
    "unknown-module",
    "not-running",
    "not-compute",
    "no-address",
    "no-port",
    "sleep",
    "restarting",
    "under-debugger",
    "stale-listener",
    "already-listening",
)

# Kept open for the process lifetime so a --listen port stays bound.
HELD = []


class FakePlane:
    def __init__(self, args) -> None:
        self.args = args
        self.status_polls = 0
        self.debug_calls = 0

    # -- recovery helper -------------------------------------------------
    def _became_ready(self) -> bool:
        """True once --ready-after status polls have elapsed."""
        return self.args.ready_after > 0 and self.status_polls >= self.args.ready_after

    def status_reply(self, module: str) -> dict:
        fault = self.args.fault
        if fault == "unknown-module":
            return {"status": "error", "message": f"unknown module: {module}"}
        if fault == "not-running":
            return {"status": "ok", "module": module, "alive": False, "ready": False}
        if fault == "restarting":
            if self._became_ready():
                return {"status": "ok", "module": module, "alive": True, "ready": True}
            self.status_polls += 1
            return {
                "status": "ok",
                "module": module,
                "alive": True,
                "restarting": True,
                "ready": False,
            }
        return {"status": "ok", "module": module, "alive": True, "ready": True}

    # -- start_debug -----------------------------------------------------
    def debug_reply(self, module: str, host: str, port: int) -> dict:
        fault = self.args.fault
        self.debug_calls += 1

        if fault == "stale-listener":
            # The ControlPlane advertises an endpoint that is already gone:
            # the debugger connect fails after ok, which is the confusing case.
            ghost = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            ghost.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            ghost.bind(("127.0.0.1", port))
            ghost.listen(1)
            ghost.close()
            HELD.append(ghost)
            return {
                "status": "ok",
                "module": module,
                "host": "127.0.0.1",
                "port": port,
                "already": True,
                "listening": True,
                "pid": 4242,
            }

        if fault == "no-start-debug":
            # Real ControlPlane wording for an action it never learned.
            return {"status": "error", "message": "unknown action: start_debug"}
        if fault == "debugpy-import":
            return {
                "status": "error",
                "code": "DEBUGPY_IMPORT",
                "message": "failed to import debugpy: No module named 'debugpy'",
                "pid": 4242,
            }
        if fault == "debugpy-listen":
            return {
                "status": "error",
                "code": "DEBUGPY_LISTEN",
                "message": (
                    f"debugpy.listen failed on {host}:{port}: "
                    "[Errno 98] Address already in use"
                ),
                "pid": 4242,
            }
        if fault == "worker-rpc-timeout":
            return {
                "status": "error",
                "code": "RPC_TIMEOUT",
                "message": f"{module} did not reply to start_debug",
            }
        if fault == "worker-unavailable":
            return {
                "status": "error",
                "code": "WORKER_UNAVAILABLE",
                "message": f"{module}: no replica available",
            }
        if fault == "handler-error":
            return {
                "status": "error",
                "code": "COMPUTE_HANDLER_ERROR",
                "message": (
                    "start_debug handler raised: RuntimeError('worker is shutting down')"
                ),
            }
        if fault == "unknown-module":
            return {"status": "error", "message": f"unknown module: {module}"}
        if fault == "not-compute":
            return {"status": "error", "message": f"{module} is not a compute module"}
        if fault == "no-address":
            return {"status": "error", "message": f"{module} has no compute address"}
        if fault == "not-running":
            return {"status": "error", "message": f"{module} is not running"}
        if fault == "sleep":
            # Longer than the client's --timeout-ms so the REQ collapses.
            time.sleep(6)
            return {"status": "ok", "module": module, "host": host, "port": port}
        if fault == "restarting" and not self._became_ready():
            return {"status": "error", "message": f"{module} is not running"}
        if fault == "under-debugger":
            return {
                "status": "ok",
                "already": True,
                "listening": True,
                "under_debugger": True,
                "host": host,
                "port": None,
                "pid": 4242,
                "module": module,
                "kind": "orchestrator",
                "message": "main process is already under a debugger (launch session)",
            }
        if fault == "no-port":
            return {"status": "ok", "module": module, "host": host, "already": False}

        bound = port
        if self.args.listen:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", port))
            listener.listen(1)
            HELD.append(listener)
            bound = listener.getsockname()[1]
        return {
            "status": "ok",
            "module": module,
            "host": host,
            "port": bound,
            "already": fault == "already-listening",
            "listening": True,
            "pid": 4242,
        }

    def handle(self, request: dict) -> dict:
        action = request.get("action")
        module = str(request.get("module") or "all")
        host = str(request.get("host") or "localhost")
        # The real ControlPlane derives the port; a fixed offset is enough here.
        port = self.args.port + 100
        if action == "ping":
            return {"status": "ok", "service": "ControlPlane"}
        if action == "status":
            return self.status_reply(module)
        if action == "start_debug":
            return self.debug_reply(module, host, port)
        return {"status": "error", "message": f"unknown action: {action}"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--fault", choices=FAULTS, default="none")
    parser.add_argument("--listen", action="store_true")
    parser.add_argument(
        "--ready-after",
        type=int,
        default=0,
        help="with --fault restarting: report ready after N status polls",
    )
    args = parser.parse_args()

    plane = FakePlane(args)
    context = zmq.Context()
    rep = context.socket(zmq.REP)
    rep.bind(f"tcp://{args.host}:{args.port}")
    # Handshake line the harness waits for.
    print(f"READY {args.port}", flush=True)

    while True:
        request = json.loads(rep.recv_string())
        rep.send_string(json.dumps(plane.handle(request)))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
