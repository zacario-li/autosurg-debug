# AutoSurg Debug

**English** | [简体中文](README.zh-cn.md)

AutoSurg Debug is a VS Code / Cursor extension for managing and debugging AutoSurg Compute modules and the Orchestrator.

## Features

- Reads the module manifest from `system/config/modules.yaml`
- Shows Compute, Orchestrator, and infrastructure modules in a sidebar view
- Displays module runtime status and Compute replica counts
- Start, stop, and restart modules
- Green **Hot-Attach**: hot-inject debugpy into a running Compute or Orchestrator while keeping process state
- Orange **Restart-Attach**: restart a Compute, then attach (clears init state)
- Attach to all enabled Compute modules at once
- One-click debugging of the full system: Orchestrator in the main process plus all Compute modules
- One-click Orchestrator debug session (launches `main.py` when the system is not running)
- Automatic allocation of free debugpy ports
- Checks YAML syntax, duplicate keys, dependency references, and path presets
- Right-click Tensor / Mat image inspection while paused at a breakpoint, with slicing, pseudo-color, and a pixel probe

Debug ports are preferredly hot-injected into running workers or the `main.py` process via ControlPlane `start_debug`; no `AUTOSURG_DEBUG_PORT` configuration is needed in `modules.yaml`. Each Compute row in the sidebar has two debug buttons: the green plug is Hot-Attach, the orange cycle arrow is Restart-Attach. Orchestrator rows also have a green Hot-Attach; since all Orchestrators share the single `main.py` process, only one main-process debug session is created.

## Installation

Open the Command Palette in VS Code or Cursor and run:

`Extensions: Install from VSIX...`

Pick the generated `autosurg-debug-*.vsix` file, then run:

`Developer: Reload Window`

## Prerequisites

- The workspace contains `system/config/modules.yaml`, or `autosurg.configPath` is configured
- AutoSurg uses a recent ControlPlane that supports `start_debug` hot-attach
- `autosurg.controlPython` points to a Python with `pyzmq` installed
- `debugpy` is importable in the target Compute environment; the worker tries to install it automatically when missing
- The Python debugging extension is installed in VS Code/Cursor

## Debugging a Compute Module

1. Set breakpoints in the target Compute code.
2. Start AutoSurg normally from the command line:

   ```bash
   cd system
   python3 main.py
   ```

3. Open the AutoSurg view on the left.
4. Find the target Compute, e.g. `stereo`.
5. Two debug buttons appear on the right side of the module row:
   - **Green plug**: Hot-Attach, injects into the running process without restarting or losing state. The module must already be running.
   - **Orange cycle arrow**: Restart-Attach, restarts the module with debug environment variables and then attaches; in-process state is cleared.

You can also right-click and choose `AutoSurg: Hot-Attach Compute` / `AutoSurg: Restart-Attach Compute`.

## Debugging All Compute Modules

Keep `main.py` running in the terminal, then run from the Command Palette:

`AutoSurg: Debug All Compute Modules`

The extension hot-attaches and attaches to each enabled Compute in turn. Every Compute uses its own debug port and its own call stack. Modules that are not running are still launched via their original path.

## Debugging the Full System

Full-system debugging covers all Orchestrators inside `main.py` plus every enabled Compute module.

1. Stop any `main.py` already running in the terminal.
2. Click the Debug Full System button at the top of the AutoSurg module view, or run:

   `AutoSurg: Debug Full System`

3. The extension launches `main.py` in debug mode.
4. Once ControlPlane is ready, the extension hot-attaches and attaches to each Compute in turn (no extra restarts for debugging).

While a breakpoint pauses a Compute, that module cannot serve RPC requests, and dependent business calls may time out. When debugging GPU modules, the initial model load may still take a while.

## Debugging an Orchestrator

Orchestrators and the Supervisor run inside the same `main.py` process. Hot-Attaching to any Orchestrator calls `debugpy.listen()` inside that process (conventional port 5684) and then attaches the debugger; breakpoints in other Orchestrators hit the same session.

1. Start AutoSurg normally from the command line:

   ```bash
   cd system
   python3 main.py
   ```

2. Set breakpoints in the target Orchestrator code.
3. Open the AutoSurg view on the left, find the target Orchestrator, and click the green **Hot-Attach**.

You can also right-click and choose `AutoSurg: Hot-Attach`. Clicking other Orchestrators again will not open a second session.

When the system is not running yet, you can still use `AutoSurg: Debug Orchestrator` to launch `main.py` in debug mode. If the main process is already under an F5 / Full System session, the extension reuses that session instead of attaching again.

A paused breakpoint freezes the entire main process (all Orchestrators, Gateway, ControlPlane), and dependent business calls may time out.

## Viewing Tensors / Mats While Debugging

After a breakpoint pauses execution, you can visually inspect `torch.Tensor`, `numpy.ndarray`, PIL images, OpenCV images, and C++ `cv::Mat`.

1. Right-click a variable in the Variables or Watch pane and choose `View as Image / Tensor`.
2. Or select an expression in Python code and press `Ctrl+Alt+I` (`Cmd+Alt+I` on macOS).
3. The view supports wheel zoom, drag-to-pan, Fit / 1:1, Batch/Channel slicing, pseudo-color, and BGR/RGB toggle.
4. A pixel grid appears above 400% zoom; hovering shows coordinates and raw values.
5. Auto-refresh is on by default: opened views refresh automatically after F10 / F11 steps.
6. Hovering a tensor/image variable in code shows a mini thumbnail; click the link in the hover to open the full view.
7. Multi-channel tensors can be tiled via `Grid`; click a thumbnail to enter that channel.
8. `Snapshot` saves the current frame; Diff supports side-by-side or residual heatmap, and can also compare against another expression.

Data is encoded to PNG inside the debugged process memory and streamed to the webview over DAP—no temporary files are written.

Hover thumbnails can be disabled with the `autosurg.tensorHover` setting.

## Validating Configuration

Click the validate button at the top of the AutoSurg module view, or run:

`AutoSurg: Validate Configuration`

Results are shown in the editor's Problems pane.

## Extension Settings

- `autosurg.configPath`: path to `modules.yaml`; relative paths resolve against the workspace root
- `autosurg.controlHost`: ControlPlane address, defaults to `localhost`
- `autosurg.controlPython`: Python used to run the ControlPlane client, defaults to `python3`
- `autosurg.debugPortBase`: first port tried when auto-assigning debug ports, defaults to `5678`
- `autosurg.tensorHover`: show tensor thumbnails on hover while the debugger is paused, on by default

## Troubleshooting

### Module status is unavailable

Make sure `main.py` is running and that the environment pointed to by `autosurg.controlPython` has `pyzmq` installed.

### A module never becomes ready while debugging

Check `system/log/latest_log.log` for startup errors of the target worker. Common causes include a wrong Python environment, missing CUDA libraries, or `debugpy` failing to import.

### Business requests time out while debugging

Business requests can be sent right after a successful hot-attach. If the program is stopped at a breakpoint, that Compute's RPC calls will wait and may trigger client-side timeouts.

### Hot-attach failed and the module was restarted

When an old ControlPlane lacks `start_debug`, the worker has not loaded the new code, or the conventional debug port is occupied, the extension falls back to the restart path. Confirm that `main.py` with `start_debug` has been restarted, and check that ports 5678–5683 are free.

## Author

Zacario Li  
<zacario.li@outlook.com>

## License

MIT
