# AutoSurg debuggee-side extractor. Loaded via DAP evaluate into an isolated dict.
# Never writes files. Slices first so a 4D CUDA tensor is not copied wholesale.


def _autosurg_viz(obj, batch=0, channel=0, max_side=384, rgb_mode=1, mode="single", max_channels=64, cell_side=48, token="", offset=0, length=16000, cloud_mode=0):
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

    cloud_flag = int(cloud_mode or 0)
    if cloud_flag == 1 or (cloud_flag != 2 and _cloud_candidate(obj, cloud_flag)):
        return _autosurg_cloud(obj, int(batch), mode_name, cloud_flag)

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
        or _is_open3d_cloud(obj)
        or _is_trimesh_cloud(obj)
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


# ---------------------------------------------------------------------------
# Point cloud support
# ---------------------------------------------------------------------------

CLOUD_MIN_POINTS = 16
CLOUD_MAX_POINTS = 150000
CLOUD_PREVIEW_POINTS = 2000
CLOUD_INLINE_LIMIT = 35000


def _is_open3d_cloud(obj):
    type_name = type(obj).__name__
    module_name = str(getattr(type(obj), "__module__", "") or "")
    return (
        type_name == "PointCloud"
        and "open3d" in module_name
        and hasattr(obj, "points")
    )


def _is_trimesh_cloud(obj):
    if not hasattr(obj, "vertices"):
        return False
    module_name = str(getattr(type(obj), "__module__", "") or "")
    return "trimesh" in module_name


def _cloud_vertices_colors(obj):
    """Duck-typed extraction for open3d / trimesh point clouds."""
    import numpy as np

    pts = np.asarray(getattr(obj, "points", None) if _is_open3d_cloud(obj) else obj.vertices)
    rgb = None
    colors = getattr(obj, "colors", None)
    if colors is not None:
        try:
            colors = np.asarray(colors)
            if colors.ndim == 2 and colors.shape[1] in (3, 4) and colors.shape[0] == pts.shape[0]:
                rgb = colors[:, :3]
        except Exception:
            rgb = None
    return pts, rgb


def _cloud_candidate(obj, cloud_flag):
    if _is_open3d_cloud(obj) or _is_trimesh_cloud(obj):
        return True
    shape = getattr(obj, "shape", None)
    if shape is None:
        return False
    try:
        dims = [int(x) for x in shape]
    except Exception:
        return False
    if cloud_flag == 1:
        # Manual force: also accept (3, N) transposed clouds and (B, N, C).
        if len(dims) == 2:
            return (
                dims[1] in (2, 3, 4, 5, 6, 7) and dims[0] >= 4
            ) or (
                dims[0] in (2, 3, 4, 5, 6, 7) and dims[1] >= 4
            )
        if len(dims) == 3:
            return dims[2] in (2, 3, 4, 5, 6, 7) and dims[1] >= 4
        return False
    # Auto heuristic: strict 2-D (N, C) with C in 3..7 and enough points.
    return (
        len(dims) == 2
        and dims[1] in (3, 4, 5, 6, 7)
        and dims[0] >= CLOUD_MIN_POINTS
    )


def _cloud_read(obj, batch, flatten_all=0):
    """Return (points_2d, rgb_or_none, type_name, dtype, device) or raise."""
    import numpy as np

    type_name = type(obj).__name__
    module_name = str(getattr(type(obj), "__module__", "") or "")
    is_torch = hasattr(obj, "detach") and hasattr(obj, "cpu") and (
        "torch" in module_name or type_name == "Tensor"
    )
    device = ""
    rgb = None

    if _is_open3d_cloud(obj) or _is_trimesh_cloud(obj):
        pts, rgb = _cloud_vertices_colors(obj)
        dtype = str(pts.dtype)
        return pts, rgb, type_name, dtype, device

    if is_torch:
        device = str(getattr(obj, "device", ""))
        tensor = obj.detach()
        if tensor.ndim == 3:
            if flatten_all and int(batch) <= 0:
                tensor = tensor.reshape(-1, int(tensor.shape[-1]))
            else:
                tensor = tensor[_clamp(int(batch), int(tensor.shape[0]))]
        if str(tensor.dtype) in ("torch.bfloat16", "torch.float16"):
            tensor = tensor.float()
        arr = tensor.contiguous().cpu().numpy()
        dtype = str(obj.dtype).replace("torch.", "")
    elif hasattr(obj, "numpy") and callable(obj.numpy) and "tensorflow" in module_name:
        arr = np.asarray(obj.numpy())
        dtype = str(arr.dtype)
    else:
        arr = np.asarray(obj)
        dtype = str(arr.dtype)
        if hasattr(obj, "device"):
            device = str(getattr(obj, "device", ""))

    if arr.dtype == object:
        raise ValueError("unsupported object array for point cloud")
    if arr.ndim == 3:
        if flatten_all and int(batch) <= 0:
            arr = arr.reshape(-1, int(arr.shape[-1]))
        else:
            arr = arr[_clamp(int(batch), int(arr.shape[0]))]
    if arr.ndim != 2:
        raise ValueError("point cloud needs shape (N, C) or (B, N, C), got %r" % (arr.shape,))
    return arr, rgb, type_name, dtype, device


def _autosurg_cloud(obj, batch, mode_name, cloud_flag):
    import base64
    import json
    import zlib

    import numpy as np

    def fail(message):
        return json.dumps({"ok": False, "error": message, "code": "cloud"})

    try:
        arr, rgb, type_name, dtype, device = _cloud_read(
            obj, batch, 1 if int(cloud_flag) == 1 else 0
        )
    except Exception as exc:
        return fail("point cloud extract failed: %s" % exc)

    # Auto path only fires for (N, C); force path may need a transpose.
    cols = int(arr.shape[1]) if arr.ndim == 2 else 0
    rows = int(arr.shape[0]) if arr.ndim == 2 else 0
    if cols not in (3, 4, 5, 6, 7):
        if rows in (2, 3, 4, 5, 6, 7):
            arr = arr.T
            cols = int(arr.shape[1])
        if cols == 2 and cloud_flag == 1:
            # Forced (N, 2): treat as a planar cloud with z = 0.
            arr = np.concatenate(
                [arr, np.zeros((int(arr.shape[0]), 1), dtype=arr.dtype)], axis=1
            )
            cols = 3
        if cols not in (3, 4, 5, 6, 7):
            return fail(
                "not a point cloud (expected (N, 2..7), got %r)" % (list(arr.shape),)
            )

    xyz = np.asarray(arr[:, :3], dtype=np.float64)
    finite = np.isfinite(xyz).all(axis=1)
    if rgb is not None:
        rgb = np.asarray(rgb, dtype=np.float64)
        finite &= np.isfinite(rgb).all(axis=1)
    else:
        rgb = None
        if cols >= 6:
            rgb = np.asarray(arr[:, 3:6], dtype=np.float64)
    intensity = None
    if rgb is None and cols in (4, 5, 7, 9):
        intensity = np.asarray(arr[:, 3], dtype=np.float64)
        finite &= np.isfinite(intensity)
    xyz = xyz[finite]
    if rgb is not None:
        rgb = rgb[finite]
    if intensity is not None:
        intensity = intensity[finite]

    total = int(xyz.shape[0])
    if total < 1:
        return fail("point cloud is empty (all coordinates non-finite)")

    sampled = total
    limit = CLOUD_PREVIEW_POINTS if mode_name == "preview" else CLOUD_MAX_POINTS
    if total > limit:
        # Random (seeded, stable) sampling: uniform-stride aliases badly on
        # organized (row-ordered) clouds and shows stripe artefacts.
        rng = np.random.RandomState(0x5EED)
        idx = rng.choice(total, size=limit, replace=False)
        xyz = xyz[idx]
        if rgb is not None:
            rgb = rgb[idx]
        if intensity is not None:
            intensity = intensity[idx]
        sampled = limit

    if rgb is not None and float(np.nanmax(rgb)) <= 1.0001:
        rgb = rgb * 255.0
    if rgb is not None:
        rgb = np.clip(rgb, 0.0, 255.0)

    count = int(xyz.shape[0])
    k = 3
    blocks = [np.ascontiguousarray(xyz, dtype=np.float32).tobytes()]
    if rgb is not None:
        blocks.append(
            np.ascontiguousarray(rgb.reshape(-1), dtype=np.float32).tobytes()
        )
    if intensity is not None:
        blocks.append(
            np.ascontiguousarray(intensity, dtype=np.float32).tobytes()
        )
    blob = zlib.compress(b"".join(blocks), 6)

    xyz_min = [float(x) for x in xyz.min(axis=0)]
    xyz_max = [float(x) for x in xyz.max(axis=0)]
    xyz_mean = [float(x) for x in xyz.mean(axis=0)]

    payload = {
        "ok": True,
        "kind": "pointcloud",
        "format": "cloud",
        "typeName": type_name,
        "shape": [total, cols],
        "dtype": dtype,
        "device": device,
        "layout": "CLOUD",
        "batchCount": 1,
        "channelCount": 1,
        "batchIndex": 0,
        "channelIndex": 0,
        "rgbMode": False,
        "bgrGuess": False,
        "isTorch": "torch" in str(getattr(type(obj), "__module__", "")),
        "tensorH": 0,
        "tensorW": 0,
        "displayH": 0,
        "displayW": 0,
        "min": None,
        "max": None,
        "mean": None,
        "nanCount": 0,
        "infCount": 0,
        "cloudCount": total,
        "cloudSampled": sampled,
        "cloudK": k,
        "cloudRgb": rgb is not None,
        "cloudIntensity": intensity is not None,
        "cloudMin": xyz_min,
        "cloudMax": xyz_max,
        "cloudMean": xyz_mean,
        "pixelChannels": 1,
    }
    if len(blob) <= CLOUD_INLINE_LIMIT:
        payload["pixels"] = base64.b64encode(blob).decode("ascii")
        payload["pixelEncoding"] = "zlib"
    else:
        payload["token"] = _buf_set(blob)
        payload["byteLength"] = len(blob)
    return json.dumps(payload, allow_nan=False)
