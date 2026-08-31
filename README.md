# AutoSurg Debug

AutoSurg Debug 是用于管理和调试 AutoSurg Compute 模块及 Orchestrator 的 VS Code/Cursor 插件。

## 功能

- 从 `system/config/modules.yaml` 读取模块清单
- 在侧边栏显示 Compute、Orchestrator 和基础设施模块
- 显示模块运行状态和 Compute replica 数量
- 启动、停止和重启模块
- 一键调试 Compute 模块
- 一次附加所有已启用的 Compute 模块
- 一键调试完整系统，包括主进程中的 Orchestrator 和所有 Compute
- 一键启动 Orchestrator 调试会话
- 自动分配空闲的 debugpy 端口
- 检查 YAML 语法、重复键、依赖引用和 path preset
- 调试暂停时右键查看 Tensor / Mat 图像，支持切片、伪彩色和像素探针

调试端口由插件临时分配并通过 ControlPlane 传递，不需要在 `modules.yaml` 中配置 `AUTOSURG_DEBUG_PORT`。

## 安装

在 VS Code 或 Cursor 中打开命令面板，执行：

`Extensions: Install from VSIX...`

选择生成的 `autosurg-debug-*.vsix` 文件，安装完成后执行：

`Developer: Reload Window`

## 使用前提

- 工作区中包含 `system/config/modules.yaml`，或者已经配置 `autosurg.configPath`
- AutoSurg 使用包含临时调试环境支持的新版 ControlPlane
- `autosurg.controlPython` 指向安装了 `pyzmq` 的 Python
- 目标 Compute 环境能够导入 `debugpy`；缺少时 worker 会尝试自动安装
- VS Code/Cursor 已安装 Python 调试扩展

## 调试 Compute

1. 在目标 Compute 代码中设置断点。
2. 在命令行正常启动 AutoSurg：

   ```bash
   cd system
   python3 main.py
   ```

3. 打开左侧 AutoSurg 视图。
4. 找到目标 Compute，例如 `stereo`。
5. 点击模块右侧的调试图标，或者右键选择 `AutoSurg: Debug Module`。

插件会实时查询模块状态、分配空闲端口、使用临时调试环境重启模块、等待模块恢复 ready，然后附加调试器。

Compute 调试会重启目标 worker，其进程内状态会被清空。对于 Stereo 等有状态模块，后续业务请求需要重新执行初始化流程。

## 调试全部 Compute

保持命令行中的 `main.py` 正常运行，然后通过命令面板执行：

`AutoSurg: Debug All Compute Modules`

插件会依次重启并附加所有已启用的 Compute。每个 Compute 使用独立调试端口和独立调用栈。

## 调试完整系统

完整系统调试同时覆盖 `main.py` 中的所有 Orchestrator 和全部已启用的 Compute。

1. 停止命令行中已经运行的 `main.py`。
2. 点击 AutoSurg 模块视图顶部的 Debug Full System 按钮，或者执行：

   `AutoSurg: Debug Full System`

3. 插件以 Debug 模式启动 `main.py`。
4. ControlPlane 就绪后，插件依次重启并附加每个 Compute。

断点暂停某个 Compute 时，该模块无法处理 RPC 请求，依赖它的业务调用可能发生超时。调试 GPU 模块时，批量重启和初始化也可能需要较长时间。

## 调试 Orchestrator

Orchestrator 与 Supervisor 运行在 `main.py` 进程中，不能像 Compute 一样独立重启并附加。

1. 停止命令行中已经运行的 `main.py`。
2. 在 Orchestrator 代码中设置断点。
3. 在 AutoSurg 视图中点击目标 Orchestrator 的调试按钮。

插件会以 Debug 模式启动 `main.py`。

## 调试时查看 Tensor / Mat

在断点暂停后，可以用图形方式查看 `torch.Tensor`、`numpy.ndarray`、PIL Image、OpenCV 图像，以及 C++ `cv::Mat`。

1. 在 Variables 或 Watch 窗口中右键变量，选择 `View as Image / Tensor`。
2. 也可以在 Python 代码中选中表达式后按 `Ctrl+Alt+I`（macOS 为 `Cmd+Alt+I`）。
3. 视图支持滚轮缩放、拖拽平移、Fit / 1:1、Batch/Channel 切片、伪彩色和 BGR/RGB 切换。
4. 放大到 400% 以上会显示像素网格；鼠标悬停会显示坐标和原始数值。
5. 默认开启 Auto：单步 F10 / F11 后，已打开的视图会自动刷新。
6. 鼠标悬停在代码中的张量/图像变量上时，会显示迷你缩略图；点击 hover 里的链接可打开完整视图。
7. 多通道张量可点击 `Grid` 平铺通道；点击某个缩略图进入该通道。
8. `Snapshot` 保存当前画面，Diff 可选左右对比或残差热力图，也可与另一个表达式比较。

数据在调试进程内存中编码为 PNG，通过 DAP 传到 Webview，不会写临时文件。

悬停缩略图可用设置 `autosurg.tensorHover` 关闭。

## 配置检查

点击 AutoSurg 模块视图顶部的检查按钮，或者执行：

`AutoSurg: Validate Configuration`

检查结果会显示在编辑器 Problems 面板中。

## 插件设置

- `autosurg.configPath`：`modules.yaml` 路径；相对路径以工作区根目录为基准
- `autosurg.controlHost`：ControlPlane 地址，默认 `localhost`
- `autosurg.controlPython`：运行 ControlPlane 客户端的 Python，默认 `python3`
- `autosurg.debugPortBase`：自动寻找调试端口的起始值，默认 `5678`
- `autosurg.tensorHover`：调试暂停时在代码悬停处显示张量缩略图，默认开启

## 常见问题

### 无法获取模块状态

确认 `main.py` 正在运行，并且 `autosurg.controlPython` 所指向的环境安装了 `pyzmq`。

### 调试时模块一直没有 ready

检查 `system/log/latest_log.log` 中目标 worker 的启动错误。常见原因包括 Python 环境错误、CUDA 库缺失或 debugpy 无法导入。

### 调试后业务请求超时

等待插件完成模块 ready 检查并成功附加调试器后再发送请求。同时确认程序没有停在断点上；停在断点期间，该 Compute 的 RPC 请求会等待并可能触发客户端超时。

## 作者

Zacario Li  
<zacario.li@outlook.com>

## 许可证

MIT
