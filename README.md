# 星火图片工具 (Xinghuo Image Tool)

一个基于 [Tauri 2](https://v2.tauri.app/) 的 Windows 桌面工具，调用 OpenAI 兼容的图片接口做**文生图 / 图生图**，结果自动保存到本地。

- 前端：TypeScript + Vite（无框架，纯原生 DOM）
- 后端：Rust（`reqwest` + `rustls`，所有 HTTP / 存图都在 Rust 端完成）

---

## 界面预览

**图生图：添加参考图 + 提示词，选「出图张数」后点生成**

![图生图界面](image/screenshot-img2img.png)

**任务页：实时查看生成进度与结果，图片自动保存到本地**

![任务结果](image/screenshot-tasks.png)

---

## 功能

- **文生图**：输入提示词生成图片。
- **图生图**：添加参考图（文件 / 粘贴剪贴板 / 图片链接），按提示词改图、翻译图中文字等。
- **出图张数**：一次点击可生成 1~4 张（每张是一个独立任务，自动排队 / 并发）。
- **任务队列**：连续提交多个任务，并发数可调，实时显示「生成中 / 排队 / 完成 / 失败」。
- **自动保存**：生成的图片保存到 `图片(Pictures)/xinghuo-image-tool/`。
- **本地参考图自动上传**：本地 / 剪贴板图片会先上传到平台自带 OSS（`/api/v1/uploads/upload?public=true`）换成公网地址，供下游服务读取。
- **任务持久化**：任务列表与结果在重启后仍在（只存路径不存 base64，重新打开时从磁盘读回预览）。
- **图片放大**：点任意结果图 / 参考图可全屏放大查看。
- **🎬 漫剧工作台**：内嵌一个本地工作台（分镜 / 剧本助手 / 角色库），由应用自带的 Rust 网关提供服务，无需外部依赖。详见下方说明。

---

## 使用

打开应用后，先到 **设置** 填写：

| 项 | 说明 |
|---|---|
| 接口地址 (Base URL) | OpenAI 兼容服务地址，例如 `https://uuerqapsftez.sealosgzg.site` |
| API Key | 形如 `sk_xxx`，用 `Authorization: Bearer` 发送 |
| 等待超时（秒） | 单个请求最长等待，默认 600（10 分钟），图片生成较慢，建议别调太小 |
| 最大同时任务数 | 并发数，默认 3 |
| 图片上传地址 | **留空即用平台自带 OSS（推荐）**；填了才用自定义第三方图床 |
| 聊天接口地址 / Key / 模型 | 仅「漫剧工作台」用的聊天上游（sub2api 标准 OpenAI 兼容），与图片接口独立。聊天 Key 只存在 Rust 端，工作台页面拿不到。 |

模型：

- `gpt-5-3` — GPT-Image（标准）
- `gpt-5-4-thinking` — GPT-Image2（Plus 专属）

填好后到「文生图 / 图生图」输入提示词，选「出图张数」，点 **生成**，到「任务」页查看结果。

---

## 开发运行

需要 [Node.js](https://nodejs.org/)、[Rust](https://rustup.rs/) 工具链，Windows 上还需 WebView2 运行时（Win10/11 一般自带）。

```bash
npm install
npx tauri dev      # 启动开发模式（首次会编译 Rust，需要几分钟）
```

改前端（`src/`）会热重载；改 Rust（`src-tauri/src/`）会自动重新编译重启。

---

## 打包

```bash
# 一键打两种产物（安装版 exe + 绿色免安装 zip）
package.bat
```

或手动：

```bash
npx tauri build
```

产物位置（`src-tauri/target/release/`）：

- **安装版 exe**：`bundle/nsis/XinghuoImageTool_<版本>_x64-setup.exe`
  双击安装，进开始菜单 / 桌面。
- **绿色免安装版**：`XinghuoImageTool.exe`（单文件，可直接运行）
  `package.bat` 会把它压缩成 `dist-portable/XinghuoImageTool-<版本>-portable-x64.zip`，解压即用、无需安装。

> 绿色版依赖系统的 **WebView2 运行时**（Windows 10/11 默认已装；老系统需先装一次 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)）。

---

## 漫剧工作台 & 内嵌网关

「漫剧工作台」是一个内嵌在应用里的本地网页工作台（分镜预览、剧本/台词助手、角色库），用来把图片接口串成漫剧分镜的生产流程。它**不依赖任何外部服务**：

- 应用启动时，Rust 端会在 `127.0.0.1` 上随机端口拉起一个 **内嵌 axum 网关**（`gateway.rs`），用 `rust-embed` 把 `web-assets/` 里的工作台页面打进二进制直接提供。
- 前端「漫剧工作台」标签页用 `<iframe>` 加载这个本地地址（`gateway_url` 命令拿到端口）。
- 网关提供这些接口：
  - `POST /api/lobster/task` — 生成一张分镜图（复用图片接口 `run_generation`），存到项目目录。
  - `POST /api/scene-image/save-local` — 把远程图片下载保存到本地项目目录。
  - `GET  /api/projects` — 列出本地项目。
  - `POST /v1/chat/completions` — 转发到独立的聊天上游（剧本助手）。
- **凭据隔离**：图片 / 聊天接口的 Key 通过 `configure_gateway` 命令从设置推到 Rust 端共享状态，工作台 iframe 页面本身不持有任何 Key。
- 工作台的项目数据 / 生成图保存在 `图片(Pictures)/xinghuo-image-tool/projects/`。

> 视频生成 / 配音（`/api/video/*`、`/api/dubbing/*`）尚未在网关实现，属后续功能。

---

## 关键技术说明（踩坑记录）

- **强制 HTTP/2（rustls）**：Windows 自带的 SChannel(native-tls) 在 ALPN 协商上不稳，常降级到 HTTP/1.1，而服务端网关会在约 120s 把空闲的 HTTP/1.1 长连接掐断。改用 `rustls` 可靠协商出 HTTP/2，配合 **HTTP/2 KeepAlive PING** 心跳，长达数分钟的生成请求不再被当成空闲连接断开。
- **账号错误自动重试**：服务端轮换 ChatGPT 账号，偶尔抽到 token 被吊销的账号会快速失败（`token_revoked`），客户端遇到这类临时错误会自动重试，重新抽号。
- **每请求独立连接**：禁用空闲连接池复用，避免并发长连接触发 rustls 的 TLS 状态问题。

---

## 目录结构

```
src/                 前端（TypeScript）
  main.ts            UI、任务队列、设置、漫剧工作台 iframe、图片放大
src-tauri/           Rust 后端
  src/lib.rs         run_generation（核心生成）+ generate_images / configure_gateway /
                     gateway_url / read_saved_image 命令；启动时拉起内嵌网关
  src/gateway.rs     内嵌 axum 网关：服务漫剧工作台静态页 + /api/* + 聊天转发
  web-assets/        打进二进制的工作台页面（main.html、分镜预览、JS、角色库）
  tauri.conf.json    窗口 / 打包配置
package.bat          一键打包脚本（安装版 + 绿色版）
```
