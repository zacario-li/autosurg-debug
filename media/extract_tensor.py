# AutoSurg debuggee-side extractor. Loaded via DAP evaluate into an isolated dict.
# Never writes files. Slices first so a 4D CUDA tensor is not copied wholesale.


def _autosurg_viz(obj, batch=0, channel=0, max_side=384, rgb_mode=1, mode="single", max_channels=64, cell_side=48, token="", offset=0, length=16000):
    import json

    mode_name = str(mode or "single")
    if mode_name == "kind":
        return _autosurg_kind(obj)
    if mode_name == "grid":
        return _autosurg_grid(obj, int(batch), int(max_channels), int(cell_side))
    if mode_name == "chunk":
        return _autosurg_chunk(str(token), int(offset), int(length))
    if mode_name == "release":
        return _autosurg_release(str(token))

    def fail(message, code="unsupported"):
        return json.dumps({"ok": False, "error": message, "code": code})

    if obj is None:
        return fail("value is None", "none")

    try:
        import numpy as np
    except Exception:
        return fail("numpy is not available in this process")

    type_name = type(obj).__name__
    module_name = str(getattr(type(obj), "__module__", "") or "")
    is_torch = hasattr(obj, "detach") and hasattr(obj, "cpu") and (
        "torch" in module_name or type_name == "Tensor"
    )
    is_pil = type_name == "Image" or "PIL" in module_name
    device = ""

    try:
        if is_torch:
            device = str(getattr(obj, "device", ""))
            tensor = obj.detach()
            shape = [int(x) for x in tensor.shape]
            layout = _infer_layout(shape, prefer_chw=True)
            sliced, meta = _slice_torch(
                tensor, layout, int(batch), int(channel), bool(rgb_mode)
            )
            dtype_name = str(sliced.dtype)
            if "bfloat16" in dtype_name or dtype_name.endswith("float16"):
                sliced = sliced.float()
            arr = sliced.contiguous().cpu().numpy()
            dtype = str(obj.dtype).replace("torch.", "")
        else:
            if is_pil:
                arr_src = np.array(obj)
            elif hasattr(obj, "numpy") and callable(obj.numpy) and "tensorflow" in module_name:
                arr_src = np.asarray(obj.numpy())
            elif hasattr(obj, "get") and callable(obj.get):
                try:
                    arr_src = np.asarray(obj.get())
                except Exception:
                    arr_src = np.asarray(obj)
            else:
                arr_src = np.asarray(obj)
            if arr_src.dtype == object:
                return fail("unsupported object array / type %s" % type_name)
            shape = [int(x) for x in arr_src.shape]
            layout = _infer_layout(shape, prefer_chw=False)
            arr, meta = _slice_numpy(
                arr_src, layout, int(batch), int(channel), bool(rgb_mode)
            )
            dtype = str(arr_src.dtype)
            if hasattr(obj, "device"):
                device = str(obj.device)
    except Exception as exc:
        return fail("failed to read tensor: %s" % exc)

    if getattr(arr, "size", 0) == 0:
        return fail("tensor is empty")

    rgb = bool(meta.get("rgb"))
    bgr_guess = (not is_torch) and (not is_pil) and rgb and str(arr.dtype) == "uint8"
    nan_count = 0
    inf_count = 0
    vmin = vmax = vmean = None

    if arr.ndim == 0:
        value = _to_float(arr)
        return json.dumps(
            {
                "ok": True,
                "kind": "scalar",
                "format": "scalar",
                "typeName": type_name,
                "shape": shape,
                "dtype": dtype,
                "device": device,
                "layout": "scalar",
                "batchCount": 1,
                "channelCount": 1,
                "batchIndex": 0,
                "channelIndex": 0,
                "rgbMode": False,
                "bgrGuess": False,
                "isTorch": is_torch,
                "tensorH": 1,
                "tensorW": 1,
                "displayH": 1,
                "displayW": 1,
                "min": value,
                "max": value,
                "mean": value,
                "nanCount": 0,
                "infCount": 0,
                "scalar": value,
            }
        )

    if arr.ndim == 1:
        samples, orig_len = _downsample_1d(arr, 2048)
        finite = [x for x in samples if x == x and x not in (float("inf"), float("-inf"))]
        if finite:
            vmin = min(finite)
            vmax = max(finite)
            vmean = sum(finite) / len(finite)
        return json.dumps(
            {
                "ok": True,
                "kind": "line",
                "format": "line",
                "typeName": type_name,
                "shape": shape,
                "dtype": dtype,
                "device": device,
                "layout": "1D",
                "batchCount": 1,
                "channelCount": 1,
                "batchIndex": 0,
                "channelIndex": 0,
                "rgbMode": False,
                "bgrGuess": False,
                "isTorch": is_torch,
                "tensorH": 1,
                "tensorW": orig_len,
                "displayH": 1,
                "displayW": len(samples),
                "min": vmin,
                "max": vmax,
                "mean": vmean,
                "nanCount": 0,
                "infCount": 0,
                "samples": samples,
            }
        )

    spatial = arr
    if rgb and spatial.ndim == 3 and spatial.shape[-1] > 3:
        spatial = spatial[..., :3]
    if (not rgb) and spatial.ndim == 3:
        spatial = spatial[..., 0] if spatial.shape[-1] == 1 else spatial[:, :, 0]

    tensor_h = int(spatial.shape[0])
    tensor_w = int(spatial.shape[1])
    vmin, vmax, vmean, nan_count, inf_count = _stats(spatial)
    packed = (
        _pack_display(spatial, int(max_side))
        if mode_name == "preview"
        else _pack_full(spatial)
    )
    u8 = packed["u8"]
    if u8.ndim == 3:
        kind = "image"
        fmt = "rgb"
    else:
        kind = "heatmap"
        fmt = "gray"
    dh, dw = int(u8.shape[0]), int(u8.shape[1])

    payload = {
        "ok": True,
        "kind": kind,
        "format": fmt,
        "typeName": type_name,
        "shape": shape,
        "dtype": dtype,
        "device": device,
        "layout": layout,
        "batchCount": int(meta["batchCount"]),
        "channelCount": int(meta["channelCount"]),
        "batchIndex": int(meta["batchIndex"]),
        "channelIndex": int(meta["channelIndex"]),
        "rgbMode": rgb,
        "bgrGuess": bgr_guess,
        "isTorch": is_torch,
        "tensorH": tensor_h,
        "tensorW": tensor_w,
        "displayH": dh,
        "displayW": dw,
        "min": vmin,
        "max": vmax,
        "mean": vmean,
        "nanCount": int(nan_count),
        "infCount": int(inf_count),
        "pixelChannels": packed["channels"],
    }
    if packed.get("pixels"):
        payload["pixels"] = packed["pixels"]
    else:
        payload["token"] = packed["token"]
        payload["byteLength"] = packed["byteLength"]
    return json.dumps(payload, allow_nan=False)


def _infer_layout(shape, prefer_chw):
    n = len(shape)
    if n <= 1:
        return "1D" if n == 1 else "scalar"
    if n == 2:
        return "HW"
    if n == 3:
        if prefer_chw:
            return "CHW"
        if shape[-1] in (1, 2, 3, 4) and shape[0] >= 4 and shape[1] >= 4:
            return "HWC"
        if shape[0] <= min(shape[1], shape[2]) and shape[1] >= 4 and shape[2] >= 4:
            return "CHW"
        return "HWC"
    if n == 4:
        if prefer_chw:
            return "NCHW"
        if shape[-1] in (1, 2, 3, 4) and shape[1] >= 8 and shape[2] >= 8:
            return "NHWC"
        return "NCHW"
    return _infer_layout(shape[1:], prefer_chw)


def _slice_torch(tensor, layout, batch, channel, rgb_mode):
    shape = [int(x) for x in tensor.shape]
    if layout == "NCHW":
        b = _clamp(batch, shape[0])
        c_count = shape[1]
        c = _clamp(channel, c_count)
        if rgb_mode and c_count in (3, 4):
            sliced = tensor[b, :3]
            sliced = sliced.permute(1, 2, 0)
            rgb = True
        else:
            sliced = tensor[b, c]
            rgb = False
        return sliced, _meta(shape[0], c_count, b, c, rgb)
    if layout == "NHWC":
        b = _clamp(batch, shape[0])
        c_count = shape[3]
        c = _clamp(channel, c_count)
        if rgb_mode and c_count in (3, 4):
            sliced = tensor[b, :, :, :3]
            rgb = True
        else:
            sliced = tensor[b, :, :, c]
            rgb = False
        return sliced, _meta(shape[0], c_count, b, c, rgb)
    if layout == "CHW":
        c_count = shape[0]
        c = _clamp(channel, c_count)
        if rgb_mode and c_count in (3, 4):
            sliced = tensor[:3].permute(1, 2, 0)
            rgb = True
        else:
            sliced = tensor[c]
            rgb = False
        return sliced, _meta(1, c_count, 0, c, rgb)
    if layout == "HWC":
        c_count = shape[2]
        c = _clamp(channel, c_count)
        if rgb_mode and c_count in (3, 4):
            sliced = tensor[:, :, :3]
            rgb = True
        else:
            sliced = tensor[:, :, c]
            rgb = False
        return sliced, _meta(1, c_count, 0, c, rgb)
    return tensor, _meta(1, 1, 0, 0, False)


def _slice_numpy(arr, layout, batch, channel, rgb_mode):
    shape = [int(x) for x in arr.shape]
    if layout == "NCHW":
        b = _clamp(batch, shape[0])
        c_count = shape[1]
        c = _clamp(channel, c_count)
        if rgb_mode and c_count in (3, 4):
            sliced = arr[b, :3].transpose(1, 2, 0)
            rgb = True
        else:
            sliced = arr[b, c]
            rgb = False
        return sliced, _meta(shape[0], c_count, b, c, rgb)
    if layout == "NHWC":
        b = _clamp(batch, shape[0])
        c_count = shape[3]
        c = _clamp(channel, c_count)
        if rgb_mode and c_count in (3, 4):
            sliced = arr[b, :, :, :3]
            rgb = True
        else:
            sliced = arr[b, :, :, c]
            rgb = False
        return sliced, _meta(shape[0], c_count, b, c, rgb)
    if layout == "CHW":
        c_count = shape[0]
        c = _clamp(channel, c_count)
        if rgb_mode and c_count in (3, 4):
            sliced = arr[:3].transpose(1, 2, 0)
            rgb = True
        else:
            sliced = arr[c]
            rgb = False
        return sliced, _meta(1, c_count, 0, c, rgb)
    if layout == "HWC":
        c_count = shape[2]
        c = _clamp(channel, c_count)
        if rgb_mode and c_count in (3, 4):
            sliced = arr[:, :, :3]
            rgb = True
        else:
            sliced = arr[:, :, c]
            rgb = False
        return sliced, _meta(1, c_count, 0, c, rgb)
    return arr, _meta(1, 1, 0, 0, False)


def _meta(batch_count, channel_count, batch_index, channel_index, rgb):
    return {
        "batchCount": max(1, int(batch_count)),
        "channelCount": max(1, int(channel_count)),
        "batchIndex": int(batch_index),
        "channelIndex": int(channel_index),
        "rgb": bool(rgb),
    }


def _clamp(index, size):
    if size <= 0:
        return 0
    if index < 0:
        return 0
    if index >= size:
        return size - 1
    return int(index)


def _downsample2d(arr, max_side):
    import numpy as np

    h = int(arr.shape[0])
    w = int(arr.shape[1])
    side = max(h, w)
    if side <= max_side or max_side <= 0:
        return arr, 1.0
    scale = side / float(max_side)
    nh = max(1, int(round(h / scale)))
    nw = max(1, int(round(w / scale)))
    ys = np.linspace(0, h - 1, nh).astype(np.int64)
    xs = np.linspace(0, w - 1, nw).astype(np.int64)
    if arr.ndim == 2:
        return arr[ys][:, xs], scale
    return arr[ys][:, xs, :], scale


def _downsample_1d(arr, max_len):
    import numpy as np

    flat = np.asarray(arr).reshape(-1)
    n = int(flat.shape[0])
    if n <= max_len:
        return [_to_float(x) for x in flat.tolist()], n
    idx = np.linspace(0, n - 1, max_len).astype(np.int64)
    return [_to_float(x) for x in flat[idx].tolist()], n


def _stats(arr):
    import numpy as np

    a = np.asarray(arr)
    if np.issubdtype(a.dtype, np.complexfloating):
        a = np.asarray(a.real)
    if a.dtype.kind == "f":
        finite = np.isfinite(a)
        nan_count = int((~finite).sum())
        inf_count = int(np.isinf(a).sum())
        if not finite.any():
            return None, None, None, nan_count, inf_count
        vals = a[finite]
    else:
        nan_count = 0
        inf_count = 0
        vals = a.reshape(-1)
        if vals.size == 0:
            return None, None, None, 0, 0
    return float(vals.min()), float(vals.max()), float(vals.mean()), nan_count, inf_count


def _to_u8(arr):
    import numpy as np

    a = np.asarray(arr)
    finite = np.isfinite(a) if np.issubdtype(a.dtype, np.floating) or np.issubdtype(
        a.dtype, np.complexfloating
    ) else np.ones(a.shape, dtype=bool)
    if np.issubdtype(a.dtype, np.complexfloating):
        a = a.real
        finite = np.isfinite(a)
    nan_count = int((~finite).sum()) if a.dtype.kind == "f" else 0
    inf_count = 0
    if a.dtype.kind == "f":
        inf_count = int(np.isinf(a).sum())
    work = np.where(finite, a, 0)
    if work.dtype == np.bool_:
        u8 = (work.astype(np.uint8) * 255)
        return u8, 0.0, 1.0, float(work.mean()), nan_count, inf_count
    if work.dtype == np.uint8:
        vmin = float(work.min()) if work.size else 0.0
        vmax = float(work.max()) if work.size else 0.0
        vmean = float(work.mean()) if work.size else 0.0
        return work, vmin, vmax, vmean, nan_count, inf_count
    af = work.astype(np.float64)
    if not finite.any():
        z = np.zeros(af.shape, dtype=np.uint8)
        return z, None, None, None, nan_count, inf_count
    vals = af[finite]
    vmin = float(vals.min())
    vmax = float(vals.max())
    vmean = float(vals.mean())
    lo, hi = vmin, vmax
    if vals.size > 32:
        p1, p99 = np.percentile(vals, [0.5, 99.5])
        if p99 > p1:
            lo, hi = float(p1), float(p99)
    if vmin >= 0.0 and vmax <= 1.0 + 1e-4:
        scaled = np.clip(af, 0.0, 1.0)
    elif vmin >= 0.0 and vmax <= 255.0 + 1e-2 and hi - lo >= 8:
        scaled = np.clip(af, 0.0, 255.0) / 255.0
    elif hi - lo < 1e-12:
        scaled = np.zeros_like(af)
    else:
        scaled = (np.clip(af, lo, hi) - lo) / (hi - lo)
    scaled = np.where(finite, scaled, 0.0)
    u8 = (scaled * 255.0 + 0.5).astype(np.uint8)
    return u8, vmin, vmax, vmean, nan_count, inf_count


def _pixel_blob(u8):
    import base64
    import zlib

    import numpy as np

    arr = np.ascontiguousarray(u8)
    if arr.ndim == 3:
        arr = np.ascontiguousarray(arr[:, :, :3])
        channels = 3
    else:
        channels = 1
    compressed = zlib.compress(arr.tobytes(), 6)
    return {
        "u8": arr,
        "pixels": base64.b64encode(compressed).decode("ascii"),
        "compressed": compressed,
        "channels": channels,
    }


def _pack_display(spatial, max_side, limit=40000):
    u8_src, _, _, _, _, _ = _to_u8(spatial)
    blob = None
    for side in (max_side, 256, 192, 160, 128, 96, 64, 48):
        display, _ = _downsample2d(u8_src, int(side))
        blob = _pixel_blob(display[:, :, :3] if display.ndim == 3 else display)
        if len(blob["pixels"]) <= limit:
            return blob
    return blob


def _pack_full(spatial, max_side=2560, inline_limit=35000):
    u8_src, _, _, _, _, _ = _to_u8(spatial)
    display, _ = _downsample2d(u8_src, int(max_side))
    blob = _pixel_blob(display[:, :, :3] if display.ndim == 3 else display)
    if len(blob["compressed"]) <= inline_limit:
        return blob
    token = _buf_set(blob["compressed"])
    return {
        "u8": blob["u8"],
        "channels": blob["channels"],
        "token": token,
        "byteLength": len(blob["compressed"]),
    }


def _buf_store():
    import sys
    import types

    name = "_autosurg_viz_buf"
    bag = sys.modules.get(name)
    if bag is None:
        bag = types.ModuleType(name)
        bag.store = {}
        sys.modules[name] = bag
    if not hasattr(bag, "store"):
        bag.store = {}
    if len(bag.store) > 6:
        bag.store.clear()
    return bag.store


def _buf_set(data):
    import uuid

    token = uuid.uuid4().hex
    _buf_store()[token] = data
    return token


def _autosurg_chunk(token, offset, length):
    import base64
    import json

    blob = _buf_store().get(token)
    if blob is None:
        return json.dumps({"ok": False, "error": "image cache expired"})
    start = max(0, int(offset))
    end = start + max(1, int(length))
    piece = blob[start:end]
    return json.dumps(
        {
            "ok": True,
            "data": base64.b64encode(piece).decode("ascii"),
            "total": len(blob),
        }
    )


def _autosurg_release(token):
    import json

    _buf_store().pop(token, None)
    return json.dumps({"ok": True})


def _png_bytes(u8, color):
    import base64
    import struct
    import zlib

    import numpy as np

    arr = np.ascontiguousarray(u8)
    if color == 0:
        h, w = arr.shape
        raw = b"".join(b"\x00" + arr[i].tobytes() for i in range(h))
    else:
        h, w = arr.shape[0], arr.shape[1]
        rgb = np.ascontiguousarray(arr[:, :, :3])
        raw = b"".join(b"\x00" + rgb[i].tobytes() for i in range(h))

    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, color, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )
    return base64.b64encode(png).decode("ascii")


def _to_float(value):
    try:
        number = float(value)
        if number != number:
            return None
        if number in (float("inf"), float("-inf")):
            return None
        return number
    except Exception:
        return None


def _autosurg_kind(obj):
    import json

    return json.dumps(_describe(obj), allow_nan=False)


def _describe(obj):
    if obj is None:
        return {"ok": True, "visual": False, "error": "None"}
    type_name = type(obj).__name__
    module_name = str(getattr(type(obj), "__module__", "") or "")
    is_torch = hasattr(obj, "detach") and hasattr(obj, "cpu") and (
        "torch" in module_name or type_name == "Tensor"
    )
    is_pil = type_name == "Image" or "PIL" in module_name
    shape = None
    dtype = ""
    device = ""
    try:
        if hasattr(obj, "shape"):
            shape = [int(x) for x in list(obj.shape)]
    except Exception:
        shape = None
    try:
        dtype = str(getattr(obj, "dtype", "")).replace("torch.", "")
    except Exception:
        dtype = ""
    try:
        device = str(getattr(obj, "device", "") or "")
    except Exception:
        device = ""
    visual = bool(
        is_torch
        or is_pil
        or type_name in ("ndarray", "memmap", "matrix", "Array", "EagerTensor", "UMat")
        or (shape is not None and hasattr(obj, "__array__") and len(shape) >= 1)
    )
    return {
        "ok": True,
        "visual": visual,
        "typeName": type_name,
        "shape": shape or [],
        "dtype": dtype,
        "device": device,
        "isTorch": is_torch,
    }


def _autosurg_grid(obj, batch, max_channels, cell_side):
    import json
    import math

    if obj is None:
        return json.dumps({"ok": False, "error": "value is None", "code": "none"})
    try:
        import numpy as np
    except Exception:
        return json.dumps({"ok": False, "error": "numpy is not available in this process"})

    type_name = type(obj).__name__
    module_name = str(getattr(type(obj), "__module__", "") or "")
    is_torch = hasattr(obj, "detach") and hasattr(obj, "cpu") and (
        "torch" in module_name or type_name == "Tensor"
    )
    device = ""
    try:
        if is_torch:
            device = str(getattr(obj, "device", ""))
            tensor = obj.detach()
            shape = [int(x) for x in tensor.shape]
            layout = _infer_layout(shape, prefer_chw=True)
            stack, channel_count, shown = _stack_torch(
                tensor, layout, int(batch), int(max_channels)
            )
            dtype = str(obj.dtype).replace("torch.", "")
        else:
            if type_name == "Image" or "PIL" in module_name:
                arr_src = np.array(obj)
            else:
                arr_src = np.asarray(obj)
            shape = [int(x) for x in arr_src.shape]
            layout = _infer_layout(shape, prefer_chw=False)
            stack, channel_count, shown = _stack_numpy(
                arr_src, layout, int(batch), int(max_channels)
            )
            dtype = str(arr_src.dtype)
        if stack.ndim != 3:
            return json.dumps(
                {"ok": False, "error": "grid view needs a 2D/3D/4D tensor with channels"}
            )
        cell = max(16, min(96, int(cell_side) or 48))
        count = int(stack.shape[0])
        cols = max(1, int(math.ceil(math.sqrt(count))))
        rows = max(1, int(math.ceil(count / float(cols))))
        tiles = []
        dead = []
        for index in range(count):
            small, _ = _downsample2d(stack[index], cell)
            u8, vmin, vmax, _mean, _nan, _inf = _to_u8(small)
            if u8.ndim == 3:
                u8 = u8[:, :, 0]
            tile = np.zeros((cell, cell), dtype=np.uint8)
            th, tw = int(u8.shape[0]), int(u8.shape[1])
            y0 = max(0, (cell - th) // 2)
            x0 = max(0, (cell - tw) // 2)
            tile[y0 : y0 + th, x0 : x0 + tw] = u8[: cell - y0, : cell - x0]
            tiles.append(tile)
            if vmin is None or vmax is None or (vmax - vmin) < 1e-12:
                dead.append(index)
        mosaic = np.zeros((rows * cell, cols * cell), dtype=np.uint8)
        for index, tile in enumerate(tiles):
            row, col = divmod(index, cols)
            mosaic[row * cell : (row + 1) * cell, col * cell : (col + 1) * cell] = tile
        png = _png_bytes(mosaic, color=0)
        packed = _pixel_blob(mosaic)
        vmin, vmax, vmean, nan_count, inf_count = _stats(stack)
        batch_count = int(shape[0]) if layout in ("NCHW", "NHWC") else 1
        return json.dumps(
            {
                "ok": True,
                "kind": "heatmap",
                "format": "grid",
                "typeName": type_name,
                "shape": shape,
                "dtype": dtype,
                "device": device,
                "layout": layout,
                "batchCount": batch_count,
                "channelCount": int(channel_count),
                "batchIndex": _clamp(int(batch), batch_count),
                "channelIndex": 0,
                "rgbMode": False,
                "bgrGuess": False,
                "isTorch": is_torch,
                "tensorH": int(stack.shape[1]),
                "tensorW": int(stack.shape[2]),
                "displayH": int(mosaic.shape[0]),
                "displayW": int(mosaic.shape[1]),
                "min": vmin,
                "max": vmax,
                "mean": vmean,
                "nanCount": int(nan_count),
                "infCount": int(inf_count),
                "pixels": packed["pixels"],
                "pixelChannels": packed["channels"],
                "gridCols": cols,
                "gridRows": rows,
                "cellW": cell,
                "cellH": cell,
                "shownChannels": shown,
                "deadChannels": dead,
            },
            allow_nan=False,
        )
    except Exception as exc:
        return json.dumps({"ok": False, "error": "grid extract failed: %s" % exc})


def _stack_torch(tensor, layout, batch, max_channels):
    shape = [int(x) for x in tensor.shape]

    def _prep(t):
        name = str(t.dtype)
        if "bfloat16" in name or name.endswith("float16"):
            t = t.float()
        return t.contiguous().cpu().numpy()

    limit = max(1, int(max_channels))
    if layout == "NCHW":
        b = _clamp(batch, shape[0])
        shown = min(shape[1], limit)
        return _prep(tensor[b, :shown]), shape[1], shown
    if layout == "NHWC":
        b = _clamp(batch, shape[0])
        shown = min(shape[3], limit)
        arr = _prep(tensor[b, :, :, :shown])
        return arr.transpose(2, 0, 1), shape[3], shown
    if layout == "CHW":
        shown = min(shape[0], limit)
        return _prep(tensor[:shown]), shape[0], shown
    if layout == "HWC":
        shown = min(shape[2], limit)
        arr = _prep(tensor[:, :, :shown])
        return arr.transpose(2, 0, 1), shape[2], shown
    if layout == "HW":
        data = tensor.unsqueeze(0) if hasattr(tensor, "unsqueeze") else tensor
        return _prep(data), 1, 1
    raise ValueError("unsupported layout for grid")


def _stack_numpy(arr, layout, batch, max_channels):
    import numpy as np

    shape = [int(x) for x in arr.shape]
    limit = max(1, int(max_channels))
    if layout == "NCHW":
        b = _clamp(batch, shape[0])
        shown = min(shape[1], limit)
        return np.asarray(arr[b, :shown]), shape[1], shown
    if layout == "NHWC":
        b = _clamp(batch, shape[0])
        shown = min(shape[3], limit)
        return np.asarray(arr[b, :, :, :shown]).transpose(2, 0, 1), shape[3], shown
    if layout == "CHW":
        shown = min(shape[0], limit)
        return np.asarray(arr[:shown]), shape[0], shown
    if layout == "HWC":
        shown = min(shape[2], limit)
        return np.asarray(arr[:, :, :shown]).transpose(2, 0, 1), shape[2], shown
    if layout == "HW":
        return np.asarray(arr)[None, ...], 1, 1
    raise ValueError("unsupported layout for grid")
