#!/usr/bin/env python3
"""Validate ``--dummy-shm`` specs without starting a compute worker.

The extension runs this *before* launching ``run_compute_worker.py`` under the
debugger. The point is the cost asymmetry: this finishes in a few hundred
milliseconds, while finding out that a spec was wrong costs a full model load
(vLLM / IGEV startup is minutes) and then a bare traceback.

Slot geometry is read through ``runtime.dummy_shm.load_shared_memory_layout()`` -
the same helper the worker calls - so ``config/modules.yaml`` stays the single
source of truth and nothing in here can drift from it. Payload sizes are measured
with the worker's own frame encoder.

Usage (run with the module's own interpreter)::

    python dummy_preflight.py <system-dir> <n_frames> [--config=PATH]
                              [--alloc-probe] <KEY[=SOURCE]>...

``<system-dir>`` goes on ``sys.path`` so ``runtime.dummy_shm`` resolves; the script
ships inside the extension, so it cannot derive that path from ``__file__``.
``--config`` is the ``modules.yaml`` to measure against (the extension passes the
catalog config, which is not always the repo default). ``--alloc-probe`` builds
each segment for real and reads the geometry back, at the cost of transiently
allocating the full segment size.

Output: one JSON object on stdout.

    {"ok": true,  "segments": [{"key": "shm_frame_buffer", "bytesPerFrame": 812340,
                               "slots": 128, "maxDataSize": 4194304,
                               "segmentBytes": 536871956, ...}]}
    {"ok": false, "code": "DUMMY_SOURCE_TOO_LARGE", "detail": "...", "fits": "..."}

Codes: ``DUMMY_SOURCE_TOO_LARGE`` (slot cap from the yaml would reject a frame),
``DUMMY_LAYOUT_REJECTED`` (key missing from ``shared_memory:`` or ``kind!=ring``),
``DUMMY_SOURCE_UNREADABLE`` (missing file / undecodable video),
``DUMMY_NO_SHM_SPACE`` (``/dev/shm`` cannot hold the segments),
``DUMMY_ENVIRONMENT`` (worker code or OpenCV unavailable).

Printed diagnostics never raise: a preflight that fails loudly is worse than no
preflight, so anything unexpected reports ``ok: true`` with a note.
"""

import json
import os
import sys

EXIT_OK = 0
EXIT_TOO_LARGE = 20
EXIT_SOURCE_UNREADABLE = 21
EXIT_LAYOUT = 23
EXIT_NO_SPACE = 24
EXIT_ENVIRONMENT = 22
EXIT_USAGE = 2

#: Fraction of /dev/shm a debug session may occupy before we call it risky.
SHM_SAFE_SHARE = 0.5


def emit(obj: dict, code: int) -> int:
    obj.setdefault("estimate", {})["exitCode"] = code
    print(json.dumps(obj, ensure_ascii=False))
    return code


def system_dir(raw: str) -> str:
    root = os.path.abspath(os.path.expanduser(raw))
    return root if os.path.isdir(root) else os.path.dirname(root)


def attach_system_path(root: str) -> None:
    sys.path.insert(0, root)


# --------------------------------------------------------------------------- #
# payload measurement, through the worker's own encoder
# --------------------------------------------------------------------------- #


def payload_bytes(dummy_shm, source: str, n_frames: int, seed: dict):
    """Encoded byte size of one dummy frame, or None when not measurable."""
    if hasattr(dummy_shm, "_jpeg_payloads_for_source"):
        kwargs = {
            "default_width": int(seed.get("width") or 1920),
            "default_height": int(seed.get("height") or 1080),
            "default_layout": str(seed.get("layout") or "stereo"),
        }
        payloads = None
        # n_frames is keyword-only today; both call shapes are tried so a signature
        # change cannot degrade this into a silent "not measurable".
        for attempt in (
            lambda: dummy_shm._jpeg_payloads_for_source(source, n_frames=int(n_frames), **kwargs),
            lambda: dummy_shm._jpeg_payloads_for_source(source, int(n_frames), **kwargs),
        ):
            try:
                payloads = attempt()
                break
            except TypeError:
                continue
            except Exception:
                return None
        if payloads is None:
            return None
        return max((len(p) for p in payloads), default=None)
    if hasattr(dummy_shm, "estimate_dummy_payload"):
        try:
            return int(dummy_shm.estimate_dummy_payload(source))
        except Exception:
            return None
    return None


def candidate_scalations(source: str, seed: dict):
    """Smaller ``random:`` specs to suggest, image side halved each round."""
    if not source.startswith("random"):
        return []
    _, _, rest = source.partition(":")
    rest = rest or ""
    layout = "mono" if rest.rstrip().endswith(":mono") else str(seed.get("layout") or "stereo")
    num = ""
    for ch in rest:
        if ch.isdigit():
            num += ch
        elif ch == "x":
            num += "x"
        elif ch != "m":
            break
    if "x" not in num:
        start = (int(seed.get("width") or 1920), int(seed.get("height") or 1080))
    else:
        try:
            w, h = num.split("x", 1)
            start = (int(w), int(h))
        except ValueError:
            return []
    out = []
    w, h = start
    for _ in range(4):
        w, h = w // 2, h // 2
        if w < 64 or h < 64:
            break
        out.append(f"random:{w}x{h}" + (":mono" if layout == "mono" else ""))
    if layout == "stereo":
        out.append(f"random:{start[0]}x{start[1]}:mono")
    return out


# --------------------------------------------------------------------------- #
# segment geometry, through the worker's own yaml loader
# --------------------------------------------------------------------------- #


def layout_geometry(dummy_shm, key: str, config_path):
    """``(slots, max_data_size)`` the worker will build, from ``modules.yaml``.

    Only the capacity -> power-of-two rounding is restated here; ``--alloc-probe``
    checks it against a real allocation.
    """
    cfg = dummy_shm.load_shared_memory_layout(key, config_path=config_path)
    return 1 << (int(cfg["capacity"]).bit_length()), int(cfg["max_data_size"])


def alloc_geometry(dummy_shm, key: str, config_path):
    """Build the segment for real, read its geometry back, then unlink it."""
    buf = dummy_shm.create_dummy_buffer(
        key, source="random:64x64", n_frames=1, config_path=config_path
    )
    try:
        return int(buf.capacity), int(buf.max_data_size)
    finally:
        try:
            buf.close()
        except Exception:
            pass


def seed_profile(dummy_shm, key: str) -> dict:
    if hasattr(dummy_shm, "_seed_profile"):
        try:
            return dict(dummy_shm._seed_profile(key))
        except Exception:
            pass
    return {"seed_kind": "frame", "width": 1920, "height": 1080, "layout": "stereo"}


def shm_quota():
    try:
        st = os.statvfs("/dev/shm")
        return st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize
    except OSError:
        return None, None


def classify_layout_error(detail: str) -> str:
    return "DUMMY_LAYOUT_REJECTED"


def check_spec(dummy_shm, spec: str, n_frames: int, config_path, probe: bool):
    """Return (segment_info | None, problem | None)."""
    try:
        key, source = dummy_shm.parse_dummy_spec(spec)
    except Exception as exc:
        return None, {"code": "DUMMY_LAYOUT_REJECTED", "detail": f"{spec}: {exc}"}

    seed = seed_profile(dummy_shm, key)
    # seed_kind: 'action' seeds JSON, everything else ('frame', 'wrist_cam', ...)
    # goes through the JPEG frame encoder, so only action needs a separate branch.
    kind = str(seed.get("seed_kind") or "frame")

    geometry = layout_geometry if not probe else alloc_geometry
    try:
        slots, max_data_size = geometry(dummy_shm, key, config_path)
    except ValueError as exc:
        # missing from shared_memory:, or kind != ring (frozen pools etc.)
        return None, {
            "code": "DUMMY_LAYOUT_REJECTED",
            "key": key,
            "detail": str(exc),
        }
    except OSError as exc:
        return None, {
            "code": "DUMMY_NO_SHM_SPACE",
            "key": key,
            "detail": f"{key}: cannot allocate {slots} slots (errno={exc.errno}): {exc.strerror}",
        }
    except Exception as exc:
        return None, {
            "code": "DUMMY_LAYOUT_REJECTED",
            "key": key,
            "detail": f"{key}: could not resolve segment geometry: {exc}",
        }

    segment = {
        "key": key,
        "kind": kind,
        "source": source,
        "slots": slots,
        "maxDataSize": max_data_size,
        "segmentBytes": slots * max_data_size,
        "bytesPerFrame": None,
    }

    if kind == "action":
        segment["bytesPerFrame"] = len(json.dumps({"joints": [0.0] * 6}))
        segment["note"] = "action key: image/video sources are ignored, JSON payloads are seeded"
        return segment, None

    size = payload_bytes(dummy_shm, source, n_frames, seed)
    if size is None:
        try:
            expanded = os.path.abspath(os.path.expanduser(source))
            if not source.startswith("random") and not os.path.exists(expanded):
                return None, {
                    "code": "DUMMY_SOURCE_UNREADABLE",
                    "key": key,
                    "detail": f"{key}: source not found: {expanded}",
                }
        except OSError:
            pass
        segment["note"] = "source size not measurable before the worker runs"
        return segment, None

    segment["bytesPerFrame"] = size
    if size > max_data_size:
        fits = None
        for candidate in candidate_scalations(source, seed):
            probe_size = payload_bytes(dummy_shm, candidate, n_frames, seed)
            if probe_size is not None and probe_size <= max_data_size:
                fits = candidate
                break
        detail = (
            f"{key}: one '{source}' frame encodes to {size / 1e6:.2f} MB but "
            f"modules.yaml gives {key} a {max_data_size / 1e6:.2f} MB slot "
            f"(startup ValueError: dummy payload exceeds max_data_size)"
        )
        if fits is None and not source.startswith("random"):
            detail += (
                "; on-disk sources cannot be rescaled through the spec - downscale the file "
                "(e.g. ffmpeg -i in.jpg -vf scale=iw/2:-2 out.jpg) or attach an existing "
                "segment via autosurg.dummyExtraArgs (--shm KEY:NAME:CAP:MAX:ring)"
            )
        return None, {
            "code": "DUMMY_SOURCE_TOO_LARGE",
            "detail": detail,
            "fits": fits,
            "key": key,
            "source": source,
            "bytesPerFrame": size,
            "maxDataSize": max_data_size,
        }
    return segment, None


def main() -> int:
    args = sys.argv[1:]
    positional = [a for a in args if not a.startswith("--")]
    flags = [a for a in args if a.startswith("--")]
    if len(positional) < 3:
        return emit(
            {
                "ok": False,
                "code": "USAGE",
                "detail": "usage: dummy_preflight.py <system-dir> <n_frames> "
                "[--config=PATH] [--alloc-probe] <KEY[=SOURCE]>...",
            },
            EXIT_USAGE,
        )

    root = system_dir(positional[0])
    try:
        n_frames = max(1, int(positional[1]))
    except ValueError:
        return emit({"ok": False, "code": "USAGE", "detail": f"bad n_frames: {positional[1]}"}, EXIT_USAGE)
    specs = positional[2:]
    attach_system_path(root)

    config_path = None
    for flag in flags:
        if flag.startswith("--config="):
            config_path = os.path.abspath(os.path.expanduser(flag.split("=", 1)[1]))
    probe = "--alloc-probe" in flags

    try:
        import yaml  # noqa: F401  (dependency probe: the worker imports it too)

        import runtime.dummy_shm as dummy_shm
    except Exception as exc:
        # No worker code -> no opinion. Launching is still better than blocking.
        return emit(
            {
                "ok": True,
                "segments": [],
                "problems": [],
                "notes": [f"preflight skipped: cannot import runtime.dummy_shm ({exc})"],
                "estimate": {},
            },
            EXIT_OK,
        )

    segments, problems, codes = [], [], []
    for spec in specs:
        info, problem = check_spec(dummy_shm, spec, n_frames, config_path, probe)
        if info is not None:
            segments.append(info)
        if problem is not None:
            problems.append(problem)
            codes.append(str(problem["code"]))

    notes = []
    total = sum(int(s.get("segmentBytes") or 0) for s in segments)
    total_bytes, avail_bytes = shm_quota()
    share = None
    if total and total_bytes:
        share = total / float(total_bytes)
        if avail_bytes is not None and total > avail_bytes * SHM_SAFE_SHARE:
            problems.append(
                {
                    "code": "DUMMY_NO_SHM_SPACE",
                    "detail": (
                        f"these segments need {total / 1e6:.0f} MB of /dev/shm but only "
                        f"{avail_bytes / 1e6:.0f} MB is free; segment size follows "
                        "modules.yaml capacity verbatim - trim capacity or free /dev/shm"
                    ),
                }
            )
            codes.append("DUMMY_NO_SHM_SPACE")
        else:
            notes.append(
                f"segments would occupy {total / 1e6:.0f} MB of /dev/shm "
                f"({total / float(total_bytes) * 100:.2f}% of {total_bytes / 1e9:.0f} GB)"
            )

    code = EXIT_OK
    if codes:
        priority = [
            "DUMMY_LAYOUT_REJECTED",
            "DUMMY_SOURCE_UNREADABLE",
            "DUMMY_NO_SHM_SPACE",
            "DUMMY_SOURCE_TOO_LARGE",
        ]
        code = {
            "DUMMY_LAYOUT_REJECTED": EXIT_LAYOUT,
            "DUMMY_SOURCE_UNREADABLE": EXIT_SOURCE_UNREADABLE,
            "DUMMY_NO_SHM_SPACE": EXIT_NO_SPACE,
            "DUMMY_SOURCE_TOO_LARGE": EXIT_TOO_LARGE,
        }[next((c for c in priority if c in codes), codes[0])]

    return emit(
        {
            "ok": not problems,
            "code": codes[0] if codes else None,
            "config": config_path or os.environ.get("AUTOSURG_MODULES_CONFIG") or "default",
            "geometryMode": "alloc-probe" if probe else "yaml",
            "segments": segments,
            "problems": problems,
            "notes": notes,
            "estimate": {
                "segmentBytes": total,
                "shmTotalBytes": total_bytes,
                "shmAvailBytes": avail_bytes,
                "sharePct": (round(share * 100, 3) if share is not None else None),
            },
        },
        code,
    )


if __name__ == "__main__":
    sys.exit(main())
