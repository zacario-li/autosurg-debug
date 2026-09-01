import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { renderHtml } from "./tensorView";

const MAX_POINTS = 150000;

const SCALAR_TYPES: Record<
  string,
  { size: number; read: (v: DataView, o: number, le: boolean) => number }
> = {
  char: { size: 1, read: (v, o) => v.getInt8(o) },
  int8: { size: 1, read: (v, o) => v.getInt8(o) },
  uchar: { size: 1, read: (v, o) => v.getUint8(o) },
  uint8: { size: 1, read: (v, o) => v.getUint8(o) },
  short: { size: 2, read: (v, o, le) => v.getInt16(o, le) },
  int16: { size: 2, read: (v, o, le) => v.getInt16(o, le) },
  ushort: { size: 2, read: (v, o, le) => v.getUint16(o, le) },
  uint16: { size: 2, read: (v, o, le) => v.getUint16(o, le) },
  int: { size: 4, read: (v, o, le) => v.getInt32(o, le) },
  int32: { size: 4, read: (v, o, le) => v.getInt32(o, le) },
  uint: { size: 4, read: (v, o, le) => v.getUint32(o, le) },
  uint32: { size: 4, read: (v, o, le) => v.getUint32(o, le) },
  float: { size: 4, read: (v, o, le) => v.getFloat32(o, le) },
  float32: { size: 4, read: (v, o, le) => v.getFloat32(o, le) },
  double: { size: 8, read: (v, o, le) => v.getFloat64(o, le) },
  float64: { size: 8, read: (v, o, le) => v.getFloat64(o, le) },
};

interface PlyHeader {
  format: "ascii" | "binary_little_endian" | "binary_big_endian";
  vertexCount: number;
  properties: { name: string; type: string }[];
  headerEnd: number;
}

function readHeader(buffer: Buffer): PlyHeader {
  const text = buffer.toString("latin1");
  const end = text.indexOf("end_header");
  if (!text.startsWith("ply") || end < 0) {
    throw new Error("not a PLY file (missing ply header)");
  }
  const headerText = text.slice(0, end);
  const lines = headerText.split(/\r?\n/);
  let format: PlyHeader["format"] | undefined;
  let vertexCount = 0;
  let insideVertex = false;
  let sawVertex = false;
  let sawOtherBefore = false;
  const properties: { name: string; type: string }[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (!parts.length) {
      continue;
    }
    switch (parts[0]) {
      case "format":
        if (parts[1] === "ascii") {
          format = "ascii";
        } else if (parts[1] === "binary_little_endian" || parts[1] === "binary_big_endian") {
          format = parts[1];
        } else {
          throw new Error(`unsupported PLY format "${parts[1]}"`);
        }
        break;
      case "element":
        insideVertex = parts[1] === "vertex";
        if (insideVertex) {
          sawVertex = true;
          vertexCount = parseInt(parts[2], 10) || 0;
        } else if (!sawVertex) {
          throw new Error(
            `PLY element "${parts[1]}" before vertex is not supported`,
          );
        }
        break;
      case "property":
        if (insideVertex) {
          if (parts[1] === "list") {
            throw new Error("PLY vertex list properties are not supported");
          }
          properties.push({ name: parts[2], type: parts[1] });
        }
        break;
      default:
        break;
    }
  }
  if (!format) {
    throw new Error("PLY header has no format line");
  }
  if (!sawVertex || vertexCount <= 0) {
    throw new Error("PLY file has no vertices");
  }
  return {
    format,
    vertexCount,
    properties,
    headerEnd: end + "end_header".length + 1,
  };
}

function findField(names: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = names.indexOf(candidate);
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

interface PlyCloud {
  count: number;
  positions: Float32Array;
  colors: Float32Array | null;
  intensity: Float32Array | null;
}

export function parsePly(buffer: Buffer): PlyCloud {
  const header = readHeader(buffer);
  const names = header.properties.map((p) => p.name);
  const ix = findField(names, ["x", "X", "px"]);
  const iy = findField(names, ["y", "Y", "py"]);
  const iz = findField(names, ["z", "Z", "pz", "height"]);
  if (ix < 0 || iy < 0 || iz < 0) {
    throw new Error("PLY vertex has no x/y/z properties");
  }
  const ir = findField(names, ["red", "diffuse_red", "r"]);
  const ig = findField(names, ["green", "diffuse_green", "g"]);
  const ib = findField(names, ["blue", "diffuse_blue", "b"]);
  const ii = findField(names, ["intensity", "scalar_intensity", "i"]);
  const hasRgb = ir >= 0 && ig >= 0 && ib >= 0;
  const total = header.vertexCount;
  const step = Math.max(1, Math.ceil(total / MAX_POINTS));
  const count = Math.ceil(total / step);
  const positions = new Float32Array(count * 3);
  const colors = hasRgb ? new Float32Array(count * 3) : null;
  const intensity = ii >= 0 ? new Float32Array(count) : null;

  if (header.format === "ascii") {
    const text = buffer.subarray(header.headerEnd).toString("latin1");
    const lines = text.split(/\r?\n/);
    let out = 0;
    for (let i = 0; i < lines.length && out < count; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }
      const lineIndex = i * step / step;
      if (i % step !== 0) {
        continue;
      }
      const parts = line.split(/\s+/).map(Number);
      if (parts.length < header.properties.length) {
        continue;
      }
      void lineIndex;
      positions[out * 3] = parts[ix];
      positions[out * 3 + 1] = parts[iy];
      positions[out * 3 + 2] = parts[iz];
      if (colors) {
        colors[out * 3] = parts[ir];
        colors[out * 3 + 1] = parts[ig];
        colors[out * 3 + 2] = parts[ib];
      }
      if (intensity) {
        intensity[out] = parts[ii];
      }
      out++;
    }
    if (out === 0) {
      throw new Error("PLY ascii body has no parsable vertex rows");
    }
    return trimPly({ count: out, positions, colors, intensity });
  }

  const little = header.format === "binary_little_endian";
  const offsets: number[] = [];
  let stride = 0;
  for (const property of header.properties) {
    const info = SCALAR_TYPES[property.type];
    if (!info) {
      throw new Error(`unsupported PLY property type "${property.type}"`);
    }
    offsets.push(stride);
    stride += info.size;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let out = 0;
  for (let vertex = 0; vertex < total; vertex++) {
    if (vertex % step !== 0) {
      continue;
    }
    const base = header.headerEnd + vertex * stride;
    if (base + stride > buffer.byteLength) {
      break;
    }
    const read = (index: number) =>
      SCALAR_TYPES[header.properties[index].type].read(view, base + offsets[index], little);
    positions[out * 3] = read(ix);
    positions[out * 3 + 1] = read(iy);
    positions[out * 3 + 2] = read(iz);
    if (colors) {
      colors[out * 3] = read(ir);
      colors[out * 3 + 1] = read(ig);
      colors[out * 3 + 2] = read(ib);
    }
    if (intensity) {
      intensity[out] = read(ii);
    }
    out++;
  }
  if (out === 0) {
    throw new Error("PLY binary body was truncated");
  }
  return trimPly({ count: out, positions, colors, intensity });
}

function trimPly(cloud: PlyCloud): PlyCloud {
  const { count, positions, colors, intensity } = cloud;
  return {
    count,
    positions: positions.subarray(0, count * 3),
    colors: colors ? colors.subarray(0, count * 3) : null,
    intensity: intensity ? intensity.subarray(0, count) : null,
  };
}

function normalizeColors(
  colors: Float32Array,
  count: number,
): Float32Array {
  let max = 0;
  for (let i = 0; i < count * 3; i++) {
    if (colors[i] > max) {
      max = colors[i];
    }
  }
  const out = new Float32Array(count * 3);
  const scale = max <= 1.0001 ? 255 : 1;
  for (let i = 0; i < count * 3; i++) {
    out[i] = Math.max(0, Math.min(255, colors[i] * scale));
  }
  return out;
}

class PlyViewPanel {
  private static readonly panels = new Map<string, PlyViewPanel>();
  private panel: vscode.WebviewPanel | undefined;
  private disposed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly file: vscode.Uri,
  ) {}

  static async open(context: vscode.ExtensionContext, file: vscode.Uri): Promise<void> {
    const key = file.fsPath;
    const existing = PlyViewPanel.panels.get(key);
    if (existing && !existing.disposed) {
      existing.ensurePanel();
      existing.panel!.reveal(vscode.ViewColumn.Beside, true);
      await existing.load();
      return;
    }
    const panel = new PlyViewPanel(context, file);
    PlyViewPanel.panels.set(key, panel);
    panel.ensurePanel();
    await panel.load();
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }
    const scriptUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "tensorView.js",
    );
    this.panel = vscode.window.createWebviewPanel(
      "autosurg.plyView",
      `Cloud: ${path.basename(this.file.fsPath)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "autosurg.svg",
    );
    const webviewUri = this.panel.webview.asWebviewUri(scriptUri);
    this.panel.webview.html = renderHtml(this.panel.webview, webviewUri);
    this.panel.onDidDispose(() => {
      this.disposed = true;
      PlyViewPanel.panels.delete(this.file.fsPath);
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "ready" || message?.type === "refresh") {
        void this.load();
      }
    });
    return this.panel;
  }

  async load(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(this.file.fsPath);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `AutoSurg could not read ${path.basename(this.file.fsPath)}: ${String(error)}`,
      );
      return;
    }
    try {
      const payload = buildCloudPayload(buffer, this.file);
      if (this.panel) {
        void this.panel.webview.postMessage({ type: "payload", data: payload });
      }
    } catch (error) {
      if (this.panel) {
        void this.panel.webview.postMessage({
          type: "status",
          state: "error",
          message: `PLY load failed: ${String(error)}`,
        });
      } else {
        void vscode.window.showErrorMessage(`AutoSurg PLY failed: ${String(error)}`);
      }
    }
  }
}

function buildCloudPayload(buffer: Buffer, file: vscode.Uri): Record<string, unknown> {
  const cloud = parsePly(buffer);
  const count = cloud.count;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  let finite = 0;
  for (let i = 0; i < count; i++) {
    let ok = true;
    for (let a = 0; a < 3; a++) {
      const v = cloud.positions[i * 3 + a];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
      sum[a] += v;
    }
    if (ok) finite++;
  }
  if (!finite) {
    throw new Error("all PLY coordinates are non-finite");
  }
  const rgb = cloud.colors ? normalizeColors(cloud.colors, count) : null;
  const blocks: Buffer[] = [
    Buffer.from(cloud.positions.buffer, cloud.positions.byteOffset, count * 12),
  ];
  if (rgb) {
    blocks.push(Buffer.from(rgb.buffer, rgb.byteOffset, count * 12));
  }
  if (cloud.intensity) {
    blocks.push(
      Buffer.from(cloud.intensity.buffer, cloud.intensity.byteOffset, count * 4),
    );
  }
  const blob = Buffer.concat(blocks);
  const fileName = path.basename(file.fsPath);
  return {
    ok: true,
    kind: "pointcloud",
    format: "cloud",
    typeName: "PLY",
    expression: fileName,
    shape: [cloud.count, 3],
    dtype: "ply",
    device: "",
    layout: "CLOUD",
    batchCount: 1,
    channelCount: 1,
    batchIndex: 0,
    channelIndex: 0,
    rgbMode: false,
    bgrGuess: false,
    isTorch: false,
    tensorH: 0,
    tensorW: 0,
    displayH: 0,
    displayW: 0,
    min: null,
    max: null,
    mean: null,
    nanCount: 0,
    infCount: 0,
    source: "file",
    pixelChannels: 1,
    pixelEncoding: "raw",
    pixels: blob.toString("base64"),
    cloud: {
      count: cloud.count,
      sampled: cloud.count,
      cols: 3,
      rgb: !!rgb,
      intensity: !!cloud.intensity,
      min,
      max,
      mean: sum.map((v) => v / finite),
    },
  };
}

export function registerPlyView(context: vscode.ExtensionContext): void {
  const open = async (arg?: unknown) => {
    let file: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) {
      file = arg as vscode.Uri;
    }
    if (!file) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active && active.scheme === "file" && active.fsPath.toLowerCase().endsWith(".ply")) {
        file = active;
      }
    }
    if (!file) {
      const picked = await vscode.window.showOpenDialog({
        title: "Open point cloud (PLY)",
        canSelectMany: false,
        filters: { "Point cloud (PLY)": ["ply"] },
      });
      file = picked?.[0];
    }
    if (!file) {
      return;
    }
    await PlyViewPanel.open(context, file);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("autosurg.viewPly", (arg?: unknown) => {
      void open(arg).catch((error) =>
        vscode.window.showErrorMessage(`AutoSurg PLY failed: ${String(error)}`),
      );
    }),
  );
}
