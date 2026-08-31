/* AutoSurg tensor / image viewer. Runs inside a VS Code webview. */
(function () {
  const vscode = acquireVsCodeApi();

  const exprEl = document.getElementById("expr");
  const statsEl = document.getElementById("stats");
  const diffStatsEl = document.getElementById("diffStats");
  const stageEl = document.getElementById("stage");
  const canvas = document.getElementById("cv");
  const ctx = canvas.getContext("2d");
  const overlay = document.getElementById("overlay");
  const tip = document.getElementById("tip");
  const batchWrap = document.getElementById("batchWrap");
  const chanWrap = document.getElementById("chanWrap");
  const rgbWrap = document.getElementById("rgbWrap");
  const bgrWrap = document.getElementById("bgrWrap");
  const cmapWrap = document.getElementById("cmapWrap");
  const batchInput = document.getElementById("batch");
  const channelInput = document.getElementById("channel");
  const batchVal = document.getElementById("batchVal");
  const chanVal = document.getElementById("chanVal");
  const rgbInput = document.getElementById("rgb");
  const bgrInput = document.getElementById("bgr");
  const cmapInput = document.getElementById("cmap");
  const autoInput = document.getElementById("auto");
  const zoomEl = document.getElementById("zoom");
  const gridBtn = document.getElementById("gridBtn");
  const snapBtn = document.getElementById("snap");
  const snapList = document.getElementById("snapList");
  const diffMode = document.getElementById("diffMode");
  const compareExprBtn = document.getElementById("compareExpr");
  const GAP = 2;

  const state = {
    payload: null,
    gray: null,
    rgb: null,
    width: 0,
    height: 0,
    scale: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    dragX: 0,
    dragY: 0,
    fitted: true,
    swapBgr: false,
    probeTimer: 0,
    viewMode: "single",
    snapshots: [],
    compare: null,
    dragMoved: false,
  };

  const maps = {
    gray: (t) => [t, t, t],
    viridis: lerp([
      [0.267, 0.005, 0.329],
      [0.283, 0.141, 0.458],
      [0.254, 0.265, 0.53],
      [0.207, 0.372, 0.553],
      [0.164, 0.471, 0.558],
      [0.128, 0.567, 0.551],
      [0.135, 0.659, 0.518],
      [0.267, 0.749, 0.441],
      [0.478, 0.821, 0.318],
      [0.741, 0.873, 0.15],
      [0.993, 0.906, 0.144],
    ]),
    jet: lerp([
      [0, 0, 0.5],
      [0, 0, 1],
      [0, 1, 1],
      [1, 1, 0],
      [1, 0, 0],
      [0.5, 0, 0],
    ]),
    turbo: lerp([
      [0.19, 0.07, 0.23],
      [0.25, 0.33, 0.81],
      [0.18, 0.64, 0.9],
      [0.22, 0.86, 0.55],
      [0.64, 0.86, 0.2],
      [0.98, 0.72, 0.2],
      [0.99, 0.3, 0.16],
      [0.73, 0.05, 0.01],
    ]),
    magma: lerp([
      [0.001, 0.0, 0.014],
      [0.232, 0.06, 0.31],
      [0.55, 0.161, 0.34],
      [0.87, 0.398, 0.248],
      [0.988, 0.726, 0.222],
      [0.987, 0.991, 0.75],
    ]),
  };

  function lerp(stops) {
    return (t) => {
      const x = Math.min(1, Math.max(0, t));
      const p = x * (stops.length - 1);
      const i = Math.min(stops.length - 2, Math.floor(p));
      const f = p - i;
      const a = stops[i];
      const b = stops[i + 1];
      return [
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
      ];
    };
  }

  function showOverlay(text) {
    if (!text) {
      overlay.hidden = true;
      overlay.textContent = "";
      return;
    }
    overlay.hidden = false;
    overlay.textContent = text;
  }

  function stageRect() {
    return stageEl.getBoundingClientRect();
  }

  function syncCanvasSize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = stageRect();
    const cssW = Math.max(0, rect.width);
    const cssH = Math.max(0, rect.height);
    if (cssW < 2 || cssH < 2) {
      return false;
    }
    const nextW = Math.max(1, Math.floor(cssW * dpr));
    const nextH = Math.max(1, Math.floor(cssH * dpr));
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    return true;
  }

  function resizeCanvas() {
    if (syncCanvasSize()) {
      draw();
    }
  }

  function viewSize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = stageRect();
    return {
      w: rect.width || canvas.width / dpr,
      h: rect.height || canvas.height / dpr,
      dpr,
    };
  }

  function fit() {
    if (!state.width || !state.height) {
      return;
    }
    if (!syncCanvasSize()) {
      return;
    }
    const { w, h } = viewSize();
    if (w < 8 || h < 8) {
      return;
    }
    const pad = 16;
    state.scale = Math.min((w - pad) / state.width, (h - pad) / state.height);
    if (!isFinite(state.scale) || state.scale <= 0) {
      state.scale = 1;
    }
    state.panX = (w - state.width * state.scale) / 2;
    state.panY = (h - state.height * state.scale) / 2;
    state.fitted = true;
    draw();
  }

  function oneToOne() {
    const { w, h } = viewSize();
    state.scale = 1;
    state.panX = (w - state.width) / 2;
    state.panY = (h - state.height) / 2;
    state.fitted = false;
    draw();
  }

  function applyColormap(gray, width, height, name) {
    const fn = maps[name] || maps.viridis;
    const out = new ImageData(width, height);
    const dst = out.data;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      const [r, g, b] = fn(gray[i] / 255);
      dst[p] = r * 255;
      dst[p + 1] = g * 255;
      dst[p + 2] = b * 255;
      dst[p + 3] = 255;
    }
    return out;
  }

  function maybeSwapBgr(imageData) {
    if (!state.swapBgr) {
      return imageData;
    }
    const copy = new ImageData(imageData.width, imageData.height);
    const s = imageData.data;
    const d = copy.data;
    for (let i = 0; i < s.length; i += 4) {
      d[i] = s[i + 2];
      d[i + 1] = s[i + 1];
      d[i + 2] = s[i];
      d[i + 3] = s[i + 3];
    }
    return copy;
  }

  function currentImageData() {
    const payload = state.payload;
    if (!payload || !state.width) {
      return null;
    }
    if (payload.format === "grid" && state.gray) {
      return composeGrid(state.gray, payload);
    }
    if ((payload.format === "gray" || payload.format === "grid") && state.gray) {
      return applyColormap(state.gray, state.width, state.height, cmapInput.value);
    }
    if (state.rgb) {
      return maybeSwapBgr(state.rgb);
    }
    return null;
  }

  function luminance(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    const gray = new Uint8Array(w * h);
    const src = imageData.data;
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = src[j] * 0.299 + src[j + 1] * 0.587 + src[j + 2] * 0.114;
    }
    return { gray, width: w, height: h };
  }

  function composeGrid(mosaic, p) {
    const cols = p.gridCols || 1;
    const rows = p.gridRows || 1;
    const cw = p.cellW || 1;
    const ch = p.cellH || 1;
    const shown = p.shownChannels || cols * rows;
    const dw = cols * cw + (cols + 1) * GAP;
    const dh = rows * ch + (rows + 1) * GAP;
    const packedW = cols * cw;
    const out = new ImageData(dw, dh);
    const dst = out.data;
    const fn = maps[cmapInput.value] || maps.viridis;
    for (let i = 3; i < dst.length; i += 4) {
      dst[i] = 255;
    }
    for (let index = 0; index < shown; index++) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const dx0 = GAP + col * (cw + GAP);
      const dy0 = GAP + row * (ch + GAP);
      for (let ty = 0; ty < ch; ty++) {
        for (let tx = 0; tx < cw; tx++) {
          const src = mosaic[(row * ch + ty) * packedW + (col * cw + tx)] / 255;
          const [r, g, b] = fn(src);
          const o = ((dy0 + ty) * dw + (dx0 + tx)) * 4;
          dst[o] = r * 255;
          dst[o + 1] = g * 255;
          dst[o + 2] = b * 255;
          dst[o + 3] = 255;
        }
      }
    }
    return out;
  }

  function bufferFromPayload() {
    if (state.rgb) {
      return luminance(maybeSwapBgr(state.rgb));
    }
    if (state.gray) {
      if (state.payload && state.payload.format === "grid") {
        const image = composeGrid(state.gray, state.payload);
        return luminance(image);
      }
      return { gray: state.gray, width: state.width, height: state.height };
    }
    return null;
  }

  function draw() {
    const { w, h, dpr } = viewSize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    zoomEl.textContent = Math.round(state.scale * 100) + "%";

    const payload = state.payload;
    if (!payload) {
      return;
    }

    if (payload.format === "scalar") {
      ctx.fillStyle = "#e6edf3";
      ctx.font = "28px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(formatNumber(payload.scalar), w / 2, h / 2);
      return;
    }

    if (payload.format === "line") {
      drawLine(payload.samples || [], w, h);
      return;
    }

    const image = currentImageData();
    if (!image) {
      return;
    }
    if (diffMode.value === "split" && state.compare) {
      drawSplit(image, state.compare.image, w, h, dpr);
      return;
    }
    if (diffMode.value === "residual" && state.compare) {
      const residual = residualImage(bufferFromPayload(), state.compare.buffer);
      if (residual) {
        drawTransformed(residual, dpr);
        return;
      }
    }
    drawTransformed(image, dpr);
  }

  function drawTransformed(image, dpr) {
    ctx.imageSmoothingEnabled = state.scale < 4;
    ctx.imageSmoothingQuality = "low";
    ctx.setTransform(
      state.scale * dpr,
      0,
      0,
      state.scale * dpr,
      state.panX * dpr,
      state.panY * dpr,
    );
    drawImageData(image);
    if (state.scale >= 4 && state.payload && state.payload.format !== "grid") {
      drawGrid(dpr);
    }
  }

  function drawSplit(left, right, w, h, dpr) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w / 2, h);
    ctx.clip();
    drawTransformed(left, dpr);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(w / 2, 0, w / 2, h);
    ctx.clip();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = state.scale;
    const panX = state.panX + w / 2;
    ctx.imageSmoothingEnabled = scale < 4;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, panX * dpr, state.panY * dpr);
    drawImageData(right);
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.moveTo(w / 2 + 0.5, 0);
    ctx.lineTo(w / 2 + 0.5, h);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "11px sans-serif";
    ctx.fillText("A", 8, 16);
    ctx.fillText("B", w / 2 + 8, 16);
  }

  function residualImage(a, b) {
    if (!a || !b) {
      return null;
    }
    const out = new Uint8Array(a.width * a.height);
    let sum = 0;
    let max = 0;
    for (let y = 0; y < a.height; y++) {
      const by = Math.min(b.height - 1, Math.floor((y / a.height) * b.height));
      for (let x = 0; x < a.width; x++) {
        const bx = Math.min(b.width - 1, Math.floor((x / a.width) * b.width));
        const d = Math.abs(a.gray[y * a.width + x] - b.gray[by * b.width + bx]);
        out[y * a.width + x] = d;
        sum += d;
        if (d > max) {
          max = d;
        }
      }
    }
    const mean = sum / Math.max(1, out.length);
    diffStatsEl.innerHTML =
      "<dl><dt>Abs max</dt><dd>" +
      max +
      "</dd><dt>Abs mean</dt><dd>" +
      mean.toFixed(2) +
      "</dd></dl>";
    return applyColormap(out, a.width, a.height, cmapInput.value);
  }

  function drawImageData(image) {
    if (!state._off) {
      state._off = document.createElement("canvas");
    }
    if (state._off.width !== image.width || state._off.height !== image.height) {
      state._off.width = image.width;
      state._off.height = image.height;
    }
    state._off.getContext("2d").putImageData(image, 0, 0);
    ctx.drawImage(state._off, 0, 0);
  }

  function drawGrid(dpr) {
    const { w, h } = viewSize();
    const x0 = Math.max(0, Math.floor((-state.panX) / state.scale));
    const y0 = Math.max(0, Math.floor((-state.panY) / state.scale));
    const x1 = Math.min(state.width, Math.ceil((w - state.panX) / state.scale));
    const y1 = Math.min(state.height, Math.ceil((h - state.panY) / state.scale));
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    for (let x = x0; x <= x1; x++) {
      const sx = state.panX + x * state.scale + 0.5;
      ctx.moveTo(sx, state.panY + y0 * state.scale);
      ctx.lineTo(sx, state.panY + y1 * state.scale);
    }
    for (let y = y0; y <= y1; y++) {
      const sy = state.panY + y * state.scale + 0.5;
      ctx.moveTo(state.panX + x0 * state.scale, sy);
      ctx.lineTo(state.panX + x1 * state.scale, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawLine(samples, w, h) {
    if (!samples.length) {
      return;
    }
    const pad = 24;
    const finite = samples.filter((v) => typeof v === "number" && isFinite(v));
    const lo = finite.length ? Math.min.apply(null, finite) : 0;
    const hi = finite.length ? Math.max.apply(null, finite) : 1;
    const span = hi - lo || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.strokeStyle = "#7ee787";
    ctx.lineWidth = 1.5;
    samples.forEach((v, i) => {
      const x = pad + (i / Math.max(1, samples.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - lo) / span) * (h - pad * 2);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  function screenToPixel(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - state.panX) / state.scale;
    const y = (clientY - rect.top - state.panY) / state.scale;
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
      return null;
    }
    return { dx: Math.floor(x), dy: Math.floor(y) };
  }

  function toTensorCoord(dx, dy) {
    const p = state.payload;
    if (!p) {
      return null;
    }
    const ox = Math.min(p.tensorW - 1, Math.max(0, Math.floor((dx / p.displayW) * p.tensorW)));
    const oy = Math.min(p.tensorH - 1, Math.max(0, Math.floor((dy / p.displayH) * p.tensorH)));
    return { x: ox, y: oy };
  }

  function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return "n/a";
    }
    if (typeof value !== "number") {
      return String(value);
    }
    if (!Number.isFinite(value)) {
      return String(value);
    }
    if (Number.isInteger(value) || Math.abs(value) >= 1000) {
      return String(value);
    }
    return value.toPrecision(4);
  }

  function renderStats(p) {
    const rows = [
      ["Expression", p.expression || ""],
      ["Type", p.typeName || ""],
      ["Shape", p.shape ? p.shape.join(" × ") : ""],
      ["Dtype", p.dtype || ""],
      ["Device", p.device || "cpu"],
      ["Layout", p.layout || ""],
      ["Min", formatNumber(p.min)],
      ["Max", formatNumber(p.max)],
      ["Mean", formatNumber(p.mean)],
      ["NaN", String(p.nanCount || 0)],
      ["Inf", String(p.infCount || 0)],
      ["Batch", p.batchIndex + " / " + Math.max(0, (p.batchCount || 1) - 1)],
      ["Channel", p.channelIndex + " / " + Math.max(0, (p.channelCount || 1) - 1)],
      ["Spatial", (p.tensorW || 0) + " × " + (p.tensorH || 0)],
    ];
    if (p.format === "grid") {
      rows.push(["Shown", (p.shownChannels || 0) + " / " + (p.channelCount || 0)]);
      rows.push(["Dead ch", String((p.deadChannels || []).length)]);
    }
    statsEl.innerHTML = rows
      .map(function (row) {
        return "<dt>" + escapeHtml(row[0]) + "</dt><dd>" + escapeHtml(row[1]) + "</dd>";
      })
      .join("");
    const deadEl = document.getElementById("dead");
    if (deadEl) {
      deadEl.textContent = "";
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function setControls(p) {
    const multiBatch = p.batchCount > 1;
    const multiChan = p.channelCount > 1;
    const canRgb = (p.channelCount === 3 || p.channelCount === 4) && p.format !== "line" && p.format !== "scalar" && p.format !== "grid";
    batchWrap.hidden = !multiBatch;
    chanWrap.hidden = !multiChan || p.rgbMode || p.format === "grid";
    rgbWrap.hidden = !canRgb;
    bgrWrap.hidden = p.format !== "rgb";
    cmapWrap.hidden = p.format !== "gray" && p.format !== "grid";
    gridBtn.hidden = (p.channelCount || 0) <= 1 || p.format === "line" || p.format === "scalar";
    gridBtn.classList.toggle("active", p.format === "grid");
    batchInput.max = String(Math.max(0, p.batchCount - 1));
    channelInput.max = String(Math.max(0, p.channelCount - 1));
    batchInput.value = String(p.batchIndex);
    channelInput.value = String(p.channelIndex);
    batchVal.textContent = p.batchIndex + " / " + Math.max(0, p.batchCount - 1);
    chanVal.textContent = p.channelIndex + " / " + Math.max(0, p.channelCount - 1);
    rgbInput.checked = !!p.rgbMode;
    if (bgrInput.dataset.expr !== (p.expression || "")) {
      bgrInput.dataset.expr = p.expression || "";
      bgrInput.checked = !!p.bgrGuess;
      state.swapBgr = !!p.bgrGuess;
    }
  }

  function b64ToBytes(b64) {
    const cleaned = String(b64).replace(/\s+/g, "");
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  async function inflateZlib(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("deflate is not available");
    }
    const formats = ["deflate", "deflate-raw"];
    let lastError = new Error("inflate failed");
    for (let i = 0; i < formats.length; i++) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(
          new DecompressionStream(formats[i]),
        );
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function imageDataFromPixels(raw, width, height, channels) {
    const data = new ImageData(width, height);
    const dst = data.data;
    if (channels === 1) {
      for (let i = 0, j = 0; i < width * height; i++, j += 4) {
        const v = raw[i];
        dst[j] = v;
        dst[j + 1] = v;
        dst[j + 2] = v;
        dst[j + 3] = 255;
      }
      return data;
    }
    for (let i = 0, j = 0, s = 0; i < width * height; i++, j += 4, s += 3) {
      dst[j] = raw[s];
      dst[j + 1] = raw[s + 1];
      dst[j + 2] = raw[s + 2];
      dst[j + 3] = 255;
    }
    return data;
  }

  function decodePng(base64) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const off = document.createElement("canvas");
        off.width = img.width;
        off.height = img.height;
        const c = off.getContext("2d");
        c.drawImage(img, 0, 0);
        const data = c.getImageData(0, 0, img.width, img.height);
        resolve({ imageData: data, width: img.width, height: img.height });
      };
      img.onerror = () => reject(new Error("invalid png payload"));
      img.src = "data:image/png;base64," + base64;
    });
  }

  async function decodeFrame(p) {
    if (p.pixels && p.displayW && p.displayH) {
      let raw = b64ToBytes(p.pixels);
      if (p.pixelEncoding !== "raw") {
        raw = await inflateZlib(raw);
      }
      const channels = p.pixelChannels === 3 ? 3 : 1;
      const expected = p.displayW * p.displayH * channels;
      if (raw.length < expected) {
        throw new Error("truncated pixel payload");
      }
      return {
        imageData: imageDataFromPixels(raw, p.displayW, p.displayH, channels),
        width: p.displayW,
        height: p.displayH,
      };
    }
    if (p.png) {
      return decodePng(p.png);
    }
    throw new Error("no image payload");
  }

  async function applyPayload(p) {
    state.payload = p;
    exprEl.textContent = p.expression || "";
    exprEl.title = p.expression || "";
    renderStats(p);
    setControls(p);
    showOverlay("");
    if (p.format === "scalar" || p.format === "line") {
      state.width = p.displayW || 1;
      state.height = p.displayH || 1;
      state.gray = null;
      state.rgb = null;
      showOverlay("");
      scheduleFit();
      return;
    }
    let decoded;
    try {
      decoded = await decodeFrame(p);
    } catch (error) {
      showOverlay("Could not decode the image. Click Refresh.");
      return;
    }
    showOverlay("");
    state.width = decoded.width;
    state.height = decoded.height;
    if (p.format === "gray" || p.format === "grid") {
      const gray = new Uint8Array(decoded.width * decoded.height);
      const src = decoded.imageData.data;
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
        gray[i] = src[j];
      }
      state.gray = gray;
      state.rgb = null;
      if (p.format === "grid") {
        const cols = p.gridCols || 1;
        const rows = p.gridRows || 1;
        state.width = cols * (p.cellW || decoded.width) + (cols + 1) * GAP;
        state.height = rows * (p.cellH || decoded.height) + (rows + 1) * GAP;
      }
    } else {
      state.rgb = decoded.imageData;
      state.gray = null;
    }
    scheduleFit();
  }

  function scheduleFit() {
    requestAnimationFrame(() => {
      syncCanvasSize();
      if (state.fitted) {
        fit();
      } else {
        draw();
      }
    });
  }

  function requestSlice() {
    vscode.postMessage({
      type: "slice",
      batch: Number(batchInput.value),
      channel: Number(channelInput.value),
      rgbMode: rgbInput.checked,
    });
  }

  document.getElementById("fit").addEventListener("click", () => fit());
  document.getElementById("one").addEventListener("click", () => oneToOne());
  document.getElementById("refresh").addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });
  autoInput.addEventListener("change", () => {
    vscode.postMessage({ type: "autoWatch", enabled: autoInput.checked });
  });
  batchInput.addEventListener("input", () => {
    batchVal.textContent = batchInput.value + " / " + batchInput.max;
    requestSlice();
  });
  channelInput.addEventListener("input", () => {
    chanVal.textContent = channelInput.value + " / " + channelInput.max;
    requestSlice();
  });
  rgbInput.addEventListener("change", requestSlice);
  bgrInput.addEventListener("change", () => {
    state.swapBgr = bgrInput.checked;
    draw();
  });
  cmapInput.addEventListener("change", () => draw());
  gridBtn.addEventListener("click", () => {
    if (state.payload && state.payload.format === "grid") {
      vscode.postMessage({
        type: "slice",
        batch: Number(batchInput.value),
        channel: Number(channelInput.value),
        rgbMode: rgbInput.checked,
      });
      return;
    }
    vscode.postMessage({
      type: "grid",
      batch: Number(batchInput.value),
    });
  });
  snapBtn.addEventListener("click", () => {
    const image = currentImageData();
    const buffer = bufferFromPayload();
    if (!image || !buffer || !state.payload) {
      return;
    }
    const copy = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    const item = {
      id: String(Date.now()),
      label: new Date().toLocaleTimeString() + "  " + (state.payload.expression || "A"),
      image: copy,
      buffer: { gray: new Uint8Array(buffer.gray), width: buffer.width, height: buffer.height },
    };
    state.snapshots.push(item);
    if (state.snapshots.length > 12) {
      state.snapshots.shift();
    }
    state.compare = item;
    refreshSnapList(item.id);
    draw();
  });
  snapList.addEventListener("change", () => {
    const found = state.snapshots.find((item) => item.id === snapList.value);
    state.compare = found || null;
    draw();
  });
  diffMode.addEventListener("change", () => draw());
  compareExprBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "compare" });
  });

  function refreshSnapList(selected) {
    snapList.innerHTML = '<option value="">No snapshot</option>';
    state.snapshots.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      snapList.appendChild(option);
    });
    snapList.value = selected || "";
  }

  async function applyCompare(p) {
    const decoded = await decodeFrame(p);
    let image;
    if (p.format === "gray" || p.format === "grid") {
      const gray = new Uint8Array(decoded.width * decoded.height);
      const src = decoded.imageData.data;
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
        gray[i] = src[j];
      }
      image = p.format === "grid" ? composeGrid(gray, p) : applyColormap(gray, decoded.width, decoded.height, cmapInput.value);
      const buffer = p.format === "grid"
        ? luminance(image)
        : { gray: gray, width: decoded.width, height: decoded.height };
      const item = {
        id: "expr-" + Date.now(),
        label: p.expression || "B",
        image: image,
        buffer: buffer,
      };
      state.snapshots.push(item);
      state.compare = item;
      refreshSnapList(item.id);
      if (diffMode.value === "off") {
        diffMode.value = "split";
      }
      draw();
      return;
    }
    image = decoded.imageData;
    const item = {
      id: "expr-" + Date.now(),
      label: p.expression || "B",
      image: image,
      buffer: luminance(image),
    };
    state.snapshots.push(item);
    state.compare = item;
    refreshSnapList(item.id);
    if (diffMode.value === "off") {
      diffMode.value = "split";
    }
    draw();
  }

  stageEl.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (!state.width) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const prev = state.scale;
      const next = Math.min(64, Math.max(0.05, prev * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const imgX = (mx - state.panX) / prev;
      const imgY = (my - state.panY) / prev;
      state.scale = next;
      state.panX = mx - imgX * next;
      state.panY = my - imgY * next;
      state.fitted = false;
      draw();
    },
    { passive: false },
  );

  stageEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    state.dragging = true;
    state.dragMoved = false;
    state.dragX = event.clientX - state.panX;
    state.dragY = event.clientY - state.panY;
    stageEl.setPointerCapture(event.pointerId);
  });
  stageEl.addEventListener("pointerup", (event) => {
    if (state.dragging && !state.dragMoved) {
      const pixel = screenToPixel(event.clientX, event.clientY);
      const payload = state.payload;
      if (pixel && payload && payload.format === "grid") {
        const col = Math.floor((pixel.dx - GAP) / ((payload.cellW || 1) + GAP));
        const row = Math.floor((pixel.dy - GAP) / ((payload.cellH || 1) + GAP));
        const index = row * (payload.gridCols || 1) + col;
        if (index >= 0 && index < (payload.shownChannels || 0)) {
          vscode.postMessage({
            type: "slice",
            batch: Number(batchInput.value),
            channel: index,
            rgbMode: false,
          });
        }
      }
    }
    state.dragging = false;
  });
  stageEl.addEventListener("pointercancel", () => {
    state.dragging = false;
  });
  stageEl.addEventListener("pointermove", (event) => {
    if (state.dragging) {
      if (Math.abs(event.clientX - state.panX - state.dragX) > 3 || Math.abs(event.clientY - state.panY - state.dragY) > 3) {
        state.dragMoved = true;
      }
      state.panX = event.clientX - state.dragX;
      state.panY = event.clientY - state.dragY;
      state.fitted = false;
      draw();
      tip.hidden = true;
      return;
    }
    const pixel = screenToPixel(event.clientX, event.clientY);
    if (!pixel || !state.payload || state.payload.format === "scalar") {
      tip.hidden = true;
      return;
    }
    const rect = stageEl.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = event.clientX - rect.left + 12 + "px";
    tip.style.top = event.clientY - rect.top + 12 + "px";
    if (state.payload.format === "grid") {
      const col = Math.floor((pixel.dx - GAP) / ((state.payload.cellW || 1) + GAP));
      const row = Math.floor((pixel.dy - GAP) / ((state.payload.cellH || 1) + GAP));
      const index = row * (state.payload.gridCols || 1) + col;
      tip.textContent = index >= 0 && index < (state.payload.shownChannels || 0) ? "ch " + index : "";
      return;
    }
    const orig = toTensorCoord(pixel.dx, pixel.dy);
    if (!orig) {
      tip.hidden = true;
      return;
    }
    if (!tip.dataset.x || tip.dataset.x !== String(orig.x) || tip.dataset.y !== String(orig.y)) {
      tip.dataset.x = String(orig.x);
      tip.dataset.y = String(orig.y);
      tip.textContent = "(" + orig.x + ", " + orig.y + ")";
      window.clearTimeout(state.probeTimer);
      state.probeTimer = window.setTimeout(() => {
        vscode.postMessage({ type: "probe", x: orig.x, y: orig.y });
      }, 40);
    }
  });
  stageEl.addEventListener("pointerleave", () => {
    tip.hidden = true;
  });

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "payload") {
      void applyPayload(msg.data);
    } else if (msg.type === "comparePayload") {
      void applyCompare(msg.data);
    } else if (msg.type === "status") {
      if (msg.state === "loading") {
        showOverlay(msg.message || "Extracting…");
      } else if (msg.state === "ok") {
        showOverlay("");
      } else {
        showOverlay(msg.message || msg.state);
      }
    } else if (msg.type === "probe") {
      const bits = ["(" + msg.x + ", " + msg.y + ")"];
      if (Array.isArray(msg.value) && msg.value.length > 1) {
        bits.push(msg.value.map(formatNumber).join(", "));
      } else if (Array.isArray(msg.value) && msg.value.length === 1) {
        bits.push(formatNumber(msg.value[0]));
      } else if (msg.value !== undefined) {
        bits.push(formatNumber(msg.value));
      }
      if (msg.error) {
        bits.push(msg.error);
      }
      tip.textContent = bits.join("  ");
    }
  });

  window.addEventListener("resize", () => {
    resizeCanvas();
    if (state.fitted) {
      fit();
    }
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      const rect = stageRect();
      if (rect.width < 2 || rect.height < 2) {
        return;
      }
      const sized = syncCanvasSize();
      if (sized && state.fitted && state.payload) {
        fit();
      } else if (sized) {
        draw();
      }
    }).observe(stageEl);
  }

  syncCanvasSize();
  vscode.postMessage({ type: "ready" });
})();
