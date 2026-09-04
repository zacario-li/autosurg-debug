#!/usr/bin/env python3
"""CLI client for AutoSurg ControlPlane (:5560)."""

import argparse
import json
import sys
import time

import zmq


class ControlClient:
    def __init__(self, host: str = "localhost", port: int = 5560, timeout_ms: int = 10000):
        self.host = host
        self.port = port
        self.timeout_ms = timeout_ms
        self.context = zmq.Context()
        self.socket = None

    def connect(self) -> bool:
        self.socket = self.context.socket(zmq.REQ)
        # Never block shutdown when a ControlPlane endpoint is unavailable.
        self.socket.setsockopt(zmq.LINGER, 0)
        self.socket.setsockopt(zmq.RCVTIMEO, self.timeout_ms)
        self.socket.setsockopt(zmq.SNDTIMEO, self.timeout_ms)
        self.socket.connect(f"tcp://{self.host}:{self.port}")
        return True

    def request(self, payload: dict) -> dict:
        self.socket.send_string(json.dumps(payload))
        reply = self.socket.recv_string()
        return json.loads(reply)

    def close(self):
        if self.socket:
            self.socket.close(linger=0)
        self.context.term()


def main():
    parser = argparse.ArgumentParser(description="AutoSurg ControlPlane client")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=5560)
    parser.add_argument("--timeout-ms", type=int, default=10000)
    parser.add_argument(
        "action",
        choices=["list", "status", "restart", "start", "stop", "ping"],
        help="Control action",
    )
    parser.add_argument("--module", default=None, help="Module name (for status/restart/start/stop/start_debug)")
    parser.add_argument(
        "--orchestrator",
        default=None,
        help="Orchestrator name (for restart / start / stop / start_debug)",
    )
    parser.add_argument("--python", default=None, help="Override python executable on restart")
    parser.add_argument("--force", action="store_true", help="Start a disabled module")
    parser.add_argument(
        "--env",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Temporary environment override for a compute start/restart",
    )
    parser.add_argument(
        "--debug-port",
        type=int,
        default=None,
        help="debugpy port for start_debug (default: conventional launch.json port)",
    )
    parser.add_argument(
        "--debug-host",
        default="localhost",
        help="debugpy bind host for start_debug (default: localhost)",
    )
    parser.add_argument("--json", action="store_true", help="Print raw JSON only")
    args = parser.parse_args()

    # --orchestrator takes precedence; both default to module-level semantics
    target = args.orchestrator or args.module or "all"

    client = ControlClient(
        host=args.host,
        port=args.port,
        timeout_ms=args.timeout_ms,
    )
    client.connect()

    payload = {"action": args.action}
    if args.action in ("status", "restart", "start", "stop", "start_debug"):
        payload["module"] = target
    if args.action == "start_debug":
        if not args.module and not args.orchestrator:
            parser.error("start_debug requires --module or --orchestrator")
        if args.debug_port is not None:
            payload["port"] = args.debug_port
        payload["host"] = args.debug_host
    if args.action == "restart" and args.python:
        payload["python"] = args.python
    if args.action == "start" and args.force:
        payload["force"] = True
    if args.env:
        env = {}
        for item in args.env:
            key, separator, value = item.partition("=")
            if not separator or not key:
                parser.error(f"--env expects KEY=VALUE, got: {item}")
            env[key] = value
        payload["env"] = env
    if args.orchestrator and args.action in (
        "restart",
        "start",
        "stop",
        "start_debug",
    ):
        payload["is_orchestrator"] = True

    try:
        response = client.request(payload)
    except zmq.Again:
        print("Request timed out", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()

    if args.json:
        print(json.dumps(response, indent=2))
        return

    if args.action == "list" and "items" in response:
        _print_list_table(response["items"])
        return

    print(json.dumps(response, indent=2))
    if response.get("status") in ("error", "started_not_ready"):
        sys.exit(1)


def _print_list_table(items: list) -> None:
    """Pretty-print modules + orchestrators listing."""
    print(f"{'NAME':<25} {'KIND':<12} {'TYPE':<14} {'ADDR':<45} {'RESTARTABLE'}")
    print("-" * 112)
    for item in items:
        name = item.get("name", "")
        kind = item.get("kind", "")
        typ = item.get("type", "")
        addr = str(item.get("addr", "-"))
        restartable = "yes" if item.get("restartable") else "no"
        print(f"{name:<25} {kind:<12} {typ:<14} {addr:<45} {restartable}")


if __name__ == "__main__":
    main()
