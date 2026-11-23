# TIA Portal V16 MCP · 机器人协会

> 让 AI 客户端通过 **Model Context Protocol (MCP)** 连接 **Siemens TIA Portal V16（博途）**：经 Openness 读取 PLC 变量表与程序块、非覆盖导入、编译、导出回读——**全程只操作无界面副本，不碰你正在用的工程和已有窗口**。

本仓库同时提供：

- **Python MCP 服务器**（`mcp_run.py` + `console_runtime.py`），Streamable HTTP 传输，默认监听 `127.0.0.1:8001`。
- **C# Openness 桥接程序**（`bridge/BridgeV16.cs` → `bin/TiaBridgeV16.exe`），由 Python 侧按需拉起，隔离在独立的无界面 V16 实例中执行 Openness 操作。
- **Electron 桌面控制台**（`desktop/`），可视化启停服务、查看日志与运行状态。

> 本项目源码运行、不提供公开安装包；不携带、不分发任何西门子 DLL。适用于自建/教学/研究场景，使用前请遵守西门子相关软件许可。

## 运行要求

- Windows x64
- **Siemens TIA Portal V16**（含 **Openness API**）
- 当前登录用户属于 Windows 本地组 **`Siemens TIA Openness`**
- **Python 3.12+ (x64)**
- **Node.js 22.12+**（仅桌面控制台需要）
- **.NET Framework 4.x**（编译桥接程序需要）

> 首次连接若出现 Openness 授权/权限提示，请人工核对桥接程序与权限。本工具不会绕过任何授权或安全检查。

## 安装与启动

在仓库根目录依次执行：

```powershell
# 1) Python 虚拟环境与依赖
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2) 编译 Openness 桥接程序（生成 bin\TiaBridgeV16.exe）
powershell -NoProfile -File .\build-bridge.ps1

# 3) 安装并启动桌面控制台
npm --prefix desktop ci --no-audit --no-fund
npm --prefix desktop exec -- install-electron
npm --prefix desktop start
```

打开控制台后点击「启动服务」。若只想直接使用 MCP 服务（不要控制台），运行：

```powershell
.\.venv\Scripts\python.exe -X utf8 .\mcp_run.py
```

客户端 MCP 地址：**`http://127.0.0.1:8001/mcp`**。

### 自定义 TIA 安装路径

默认使用：
`Program Files\Siemens\Automation\Portal V16\PublicAPI\V16\Siemens.Engineering.dll`

若 TIA 装在其他位置，请在**构建桥接程序和控制台之前**设置环境变量 `TIA_V16_PUBLICAPI_DLL` 为 V16 `Siemens.Engineering.dll` 的绝对路径。构建脚本会校验程序集主版本必须为 16。

## MCP 工具一览

连接建立后，服务注册以下工具（通用命名尽量与 V21 版保持一致）：

| 工具 | 作用 |
| --- | --- |
| `detect_tia_installations` | 探测本机 V16 安装位置 |
| `check_openness_prerequisites` | 检查 Openness 组/权限等前置条件 |
| `get_tia_compatibility` | 查询本版能力与兼容性 |
| `connect_tia` | 连接：复制指定 `.ap16` 工程并在**独立无界面实例**打开副本 |
| `disconnect_tia` | 断开连接 |
| `get_tia_status` | 查询当前连接/运行状态 |
| `list_plcs` | 列出工程中的 PLC |
| `select_plc` | 选择目标 PLC |
| `get_plc_inventory` | 读取 PLC、变量表、程序块清单 |
| `export_program_blocks` | 导出指定程序块为 SimaticML XML |
| `write_program_blocks` | 以**非覆盖导入**方式写入程序块（`confirm_write=true`） |
| `compile_plc` | 请求编译 |
| `save_project` | 保存副本（`confirm_save=true`） |

另提供 HTTP 端点：`/ping`、`/health`、`/stats`、`/environment`、`/open_log`。

## 安全与设计原则

- **只操作副本**：`connect_tia` 需要传入一个**已关闭**的、绝对路径的 `.ap16` 工程；工程文件与所在目录需同名。工具会复制完整工程目录，只在自建的无界面 V16 实例中打开副本，**不会附加到你已打开的博途窗口**，返回原件与副本双路径。
- **写入可控**：写入采用非覆盖导入，需显式 `confirm_write=true`；保存副本需 `confirm_save=true`。
- **不改分发**：源码运行，不打包、不携带西门子 DLL，不绕过授权。

## 已知范围与限制

- 本版聚焦读取 + 非覆盖导入 + 编译 + 导出回读。**不含**：下载到 PLC、PLC 在线操作、HMI、SCL 外部源，以及 V21 的 `.s7dcl` 能力。
- 复用界面中的「模板 / 知识库」设置在本版未接入 MCP 工具。
- 源码运行，**不提供公开安装包**。

## 验证

```powershell
.\.venv\Scripts\python.exe -X utf8 .\tests\smoke.py
```

可选的真实工程冒烟测试需要单独准备**可丢弃的 V16 夹具工程**：含一个 PLC，目标副本没有 OB1，输入为同一 V16 导出的 LAD OB1。传入 `--project TEST.ap16 --xml Main.xml` 后，脚本在隔离副本导入、编译、回读、保存，并核对夹具原件哈希。`tests/Fixture.cs` 仅用于从空目录创建该夹具；**不要对现用工程使用夹具生成器**。

**验证状态（如实说明）**：已验证 V16 C# 桥接编译与程序集读回、Electron 后端启动、HTTP MCP 握手/工具列表/版本拒绝/停止。部分主机上的 V16 无界面夹具创建未返回，真实工程的导入/编译/回读仍待现场完成——本项目**不把接口存在或编译成功当作现场验证通过**。

## 目录结构

```
tia-16-mcp/
├─ mcp_run.py            # MCP 服务器主体（FastMCP + Starlette/Uvicorn）
├─ console_runtime.py    # 控制台运行时/日志
├─ requirements.txt      # Python 依赖（mcp==1.30.0）
├─ build-bridge.ps1      # 编译 C# Openness 桥接
├─ start-console.ps1     # 启动 Electron 控制台
├─ bridge/BridgeV16.cs   # Openness 桥接源码
├─ bin/TiaBridgeV16.exe  # 构建产物（git 忽略，需本地编译）
├─ desktop/              # Electron 桌面控制台
└─ tests/                # 冒烟测试与夹具生成器
```

## 许可证

[MIT](LICENSE) · Copyright (c) 2026 机器人协会。
