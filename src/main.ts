import "./style.css";
import { invoke } from "@tauri-apps/api/core";

// ---------- types ----------
interface ImageOut {
  b64: string;
  mime: string;
  saved_path: string;
  source_url: string | null;
}
type AuthMode = "apikey" | "password";
interface Settings {
  baseUrl: string;
  /// How we authenticate: "apikey" (Bearer + API Key) or "password" (session
  /// JWT obtained from a username/password login).
  authMode: AuthMode;
  apiKey: string;
  loginUser: string;
  loginToken: string;
  /// Unix seconds when `loginToken` expires; 0 = unknown (server didn't tell us).
  loginExp: number;
  model: string;
  size: string;
  timeoutSec: number;
  accountTier: string;
  debugToken: string;
  maxConcurrent: number;
  uploadUrl: string;
  // --- pic2api video generation ---
  pic2apiBase: string;
  pic2apiKey: string;
  pic2apiModel: string;
  // --- dashscope dubbing ---
  dashscopeKey: string;
  dashscopeDesignModel: string;
  dashscopeTtsModel: string;
  // --- ffmpeg for frame capture ---
  ffmpegPath: string;
}
interface RefImg {
  value: string; // http(s) URL or data: URI
  label: string;
}
type TaskStatus = "queued" | "running" | "done" | "error";
interface Task {
  id: number;
  kind: "t2i" | "i2i";
  model: string;
  size: string | null;
  prompt: string;
  image: string[];
  status: TaskStatus;
  outs: ImageOut[];
  error: string;
  timeLabel: string;
}

// ---------- feature flags ----------
// 「漫剧工作台」目前不随正式版开放：置为 false 会隐藏入口标签，但代码、
// 内嵌网关与设置项全部保留，改回 true 重新构建即可恢复。
const SHOW_DRAMA = false;

// ---------- catalog (fixed by the API spec) ----------
const MODELS = [
  { value: "gpt-5-3", label: "GPT-Image（标准）" },
  { value: "gpt-5-4-thinking", label: "GPT-Image2（Plus 专属）" },
];
const SIZES = [
  { value: "1024x1024", label: "1024 × 1024（方形）" },
  { value: "1920x1080", label: "1920 × 1080（横版）" },
  { value: "1080x1920", label: "1080 × 1920（竖版）" },
];
const AUTO_SIZE = "__auto__";
const INVALID_SIZE = "__invalid__";
const SIZE_PATTERN = /^[0-9]{2,5}x[0-9]{2,5}$/;

// ---------- settings persistence ----------
const STORE_KEY = "linggan10s_settings";
const TASKS_KEY = "linggan10s_tasks";
const LEGACY_STORE_KEYS = ["xinghuo_settings"];
const LEGACY_TASKS_KEYS = ["xinghuo_tasks"];
const DEFAULT_BASE = "https://uuerqapsftez.sealosgzg.site";
// Empty = use the platform's own OSS endpoint ({base}/api/v1/uploads/upload).
const DEFAULT_UPLOAD = "";
const DEFAULT_PIC2API_BASE = "https://www.pic2api.com/v1";
const DEFAULT_PIC2API_MODEL = "sora2-pro";
const DEFAULT_DASHSCOPE_DESIGN = "qwen-voice-design";
const DEFAULT_DASHSCOPE_TTS = "qwen3-tts-vd-realtime-2026-01-15";

function loadSettings(): Settings {
  const d: Settings = {
    baseUrl: DEFAULT_BASE,
    authMode: "apikey",
    apiKey: "",
    loginUser: "",
    loginToken: "",
    loginExp: 0,
    model: MODELS[0].value,
    size: SIZES[0].value,
    timeoutSec: 600,
    accountTier: "",
    debugToken: "",
    maxConcurrent: 3,
    uploadUrl: DEFAULT_UPLOAD,
    pic2apiBase: DEFAULT_PIC2API_BASE,
    pic2apiKey: "",
    pic2apiModel: DEFAULT_PIC2API_MODEL,
    dashscopeKey: "",
    dashscopeDesignModel: DEFAULT_DASHSCOPE_DESIGN,
    dashscopeTtsModel: DEFAULT_DASHSCOPE_TTS,
    ffmpegPath: "",
  };
  try {
    const raw =
      localStorage.getItem(STORE_KEY) ??
      LEGACY_STORE_KEYS.map((k) => localStorage.getItem(k)).find((v): v is string => !!v);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      const loaded: Settings = {
        baseUrl: s.baseUrl ?? d.baseUrl,
        authMode: s.authMode === "password" ? "password" : "apikey",
        apiKey: s.apiKey ?? d.apiKey,
        loginUser: s.loginUser ?? d.loginUser,
        loginToken: s.loginToken ?? d.loginToken,
        loginExp: typeof s.loginExp === "number" ? s.loginExp : d.loginExp,
        model: s.model ?? d.model,
        size: s.size ?? d.size,
        timeoutSec: s.timeoutSec ?? d.timeoutSec,
        accountTier: s.accountTier ?? d.accountTier,
        debugToken: s.debugToken ?? d.debugToken,
        maxConcurrent: s.maxConcurrent ?? d.maxConcurrent,
        uploadUrl: s.uploadUrl ?? d.uploadUrl,
        pic2apiBase: s.pic2apiBase ?? d.pic2apiBase,
        pic2apiKey: s.pic2apiKey ?? d.pic2apiKey,
        pic2apiModel: s.pic2apiModel ?? d.pic2apiModel,
        dashscopeKey: s.dashscopeKey ?? d.dashscopeKey,
        dashscopeDesignModel: s.dashscopeDesignModel ?? d.dashscopeDesignModel,
        dashscopeTtsModel: s.dashscopeTtsModel ?? d.dashscopeTtsModel,
        ffmpegPath: s.ffmpegPath ?? d.ffmpegPath,
      };

      // --- one-time migration of stale saved settings ---
      let migrated = false;
      // Image generation needs a generous wait; bump anything below 600s.
      if (!loaded.timeoutSec || loaded.timeoutSec < 600) {
        loaded.timeoutSec = 600;
        migrated = true;
      }
      // The public image host (imageproxy) is unreliable. Clear it so uploads
      // fall back to the platform's own OSS endpoint (derived from base URL).
      if (loaded.uploadUrl.includes("imageproxy.zhongzhuan.chat")) {
        loaded.uploadUrl = "";
        migrated = true;
      }
      if (migrated) {
        saveSettings(loaded);
      }
      return loaded;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return d;
}

function saveSettings(s: Settings): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}

let settings = loadSettings();

// ---------- option builders ----------
function modelOptions(selected: string): string {
  return MODELS.map(
    (m) =>
      `<option value="${m.value}" ${m.value === selected ? "selected" : ""}>${m.label}</option>`,
  ).join("");
}
function sizeOptions(selected: string): string {
  const known = selected === AUTO_SIZE || SIZES.some((s) => s.value === selected);
  const auto = `<option value="${AUTO_SIZE}" ${selected === AUTO_SIZE ? "selected" : ""}>自动（不指定尺寸）</option>`;
  const std = SIZES.map(
    (s) =>
      `<option value="${s.value}" ${s.value === selected ? "selected" : ""}>${s.label}</option>`,
  ).join("");
  return `${auto}${std}<option value="__custom__" ${!known ? "selected" : ""}>自定义…</option>`;
}

// ---------- markup ----------
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="topbar">
    <div class="brand">🎨 灵感10s</div>
    <nav class="tabs">
      <button class="tab" data-tab="home">首页</button>
      <button class="tab" data-tab="t2i">文生图</button>
      <button class="tab" data-tab="i2i">图生图</button>
      <button class="tab" data-tab="video-frames">视频截帧</button>
      <button class="tab" data-tab="tasks">任务<span id="task-badge" class="tab-badge hidden"></span></button>
      <button class="tab${SHOW_DRAMA ? "" : " hidden"}" data-tab="drama">漫剧工作台</button>
      <button class="tab" data-tab="settings">设置</button>
    </nav>
  </header>

  <main>
    <!-- 首页 / 登录 -->
    <section class="panel" id="panel-home">
      <div class="home-wrap">
        <div class="home-hero">
          <div class="home-logo">🎨</div>
          <h1 class="home-title">灵感10s</h1>
          <p class="home-sub">文生图 / 图生图 桌面客户端</p>
        </div>

        <!-- 未登录：账号密码登录 -->
        <div class="home-card" id="home-login-card">
          <h2 class="home-card-title">登录</h2>
          <label class="field">
            <span>用户名</span>
            <input id="home-username" type="text" autocomplete="username" placeholder="网站登录用户名" />
          </label>
          <label class="field">
            <span>密码</span>
            <input id="home-password" type="password" autocomplete="current-password" placeholder="网站登录密码" />
          </label>
          <button class="primary home-block-btn" id="home-login" type="button">登录</button>
          <div class="status" id="home-status"></div>
          <div class="pwd-setup-hint hidden" id="home-pwd-hint"></div>

          <div class="home-divider"><span>或</span></div>

          <button class="mini home-block-btn" id="home-use-apikey" type="button">我想用 API Key 使用</button>

          <p class="hint home-hint">
            请求地址默认 <code>${DEFAULT_BASE}</code>，不填也会自动使用这个地址。<br />
            账密只用于向该地址换取短期 Token，<b>密码不会保存、不会外发</b>。
          </p>
        </div>

        <!-- 已登录：账户状态 -->
        <div class="home-card hidden" id="home-account-card">
          <h2 class="home-card-title">账户</h2>
          <div class="account-box">
            <div class="account-row">
              <span class="account-label">当前账号</span>
              <b id="home-account-name">—</b>
            </div>
            <div class="account-row">
              <span class="account-label">登录方式</span>
              <span id="home-account-mode">—</span>
            </div>
            <div class="account-row">
              <span class="account-label">有效期至</span>
              <span id="home-account-exp">—</span>
            </div>
            <div class="account-row">
              <span class="account-label">请求地址</span>
              <code id="home-account-base">—</code>
            </div>
          </div>
          <div class="row" style="gap:8px;flex-wrap:wrap;">
            <button class="primary" id="home-go-generate" type="button">去生成图片</button>
            <button class="mini" id="home-go-settings" type="button">打开设置</button>
            <button class="mini" id="home-logout" type="button">退出登录</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 文生图 -->
    <section class="panel" id="panel-t2i">
      <label class="field">
        <span>提示词 (Prompt)</span>
        <textarea id="t2i-prompt" rows="4" placeholder="例如：一只穿宇航服的柴犬，赛博朋克霓虹城市背景，电影感打光"></textarea>
      </label>
      <div class="row">
        <label class="field">
          <span>模型</span>
          <select id="t2i-model">${modelOptions(settings.model)}</select>
        </label>
        <label class="field">
          <span>尺寸</span>
          <select id="t2i-size">${sizeOptions(settings.size)}</select>
        </label>
        <input class="custom-size hidden" id="t2i-size-custom" type="text" placeholder="如 1024x1536" />
        <label class="field">
          <span>出图张数</span>
          <input id="t2i-count" type="number" min="1" max="4" value="1" />
        </label>
        <button class="primary" id="t2i-go">生成</button>
      </div>
      <div class="status" id="t2i-status"></div>
    </section>

    <!-- 图生图 -->
    <section class="panel hidden" id="panel-i2i">
      <div class="field">
        <span>参考图（可添加多张，用作图生图的输入）</span>
        <div class="ref-controls">
          <label class="filebtn">
            添加图片文件
            <input id="i2i-file" type="file" accept="image/*" multiple hidden />
          </label>
          <button id="i2i-paste">📋 粘贴剪贴板图片</button>
          <input id="i2i-url" type="text" placeholder="或粘贴图片链接 https://…" />
          <button id="i2i-add-url">添加链接</button>
        </div>
        <p class="ref-hint">提示：在本页直接按 <code>Ctrl/⌘ + V</code> 即可把剪贴板里的图片加为参考图；上传/粘贴的本地图片会先自动上传到图床再生成。</p>
        <div class="refs" id="i2i-refs"></div>
      </div>
      <label class="field">
        <span>提示词 (Prompt)</span>
        <textarea id="i2i-prompt" rows="3" placeholder="例如：参考这两张图，生成同风格人物海报；保留构图，改成水彩画风"></textarea>
      </label>
      <div class="row">
        <label class="field">
          <span>模型</span>
          <select id="i2i-model">${modelOptions(settings.model)}</select>
        </label>
        <label class="field">
          <span>尺寸</span>
          <select id="i2i-size">${sizeOptions(settings.size)}</select>
        </label>
        <input class="custom-size hidden" id="i2i-size-custom" type="text" placeholder="如 1024x1536" />
        <label class="field">
          <span>出图张数</span>
          <input id="i2i-count" type="number" min="1" max="4" value="1" />
        </label>
        <button class="primary" id="i2i-go">生成</button>
      </div>
      <div class="status" id="i2i-status"></div>
    </section>

    <!-- 视频按帧预览与截图 -->
    <section class="panel hidden" id="panel-video-frames">
      <div class="field">
        <span>上传 MP4 视频</span>
        <label class="filebtn">选择视频文件<input id="video-frame-file" type="file" accept="video/mp4,video/*" hidden /></label>
        <span id="video-frame-name" class="video-frame-name">尚未选择视频</span>
      </div>
      <div class="video-frame-stage">
        <video id="video-frame-player" controls playsinline preload="metadata"></video>
        <div id="video-frame-empty" class="video-frame-empty">选择视频后即可预览</div>
      </div>
      <div class="video-frame-controls">
        <span id="video-frame-time">00:00.000 / 00:00.000</span>
        <input id="video-frame-seek" type="range" min="0" max="0" step="0.001" value="0" disabled />
        <button id="video-frame-prev" class="mini" disabled>上一帧</button>
        <button id="video-frame-next" class="mini" disabled>下一帧</button>
        <label class="frame-step">步长 <input id="video-frame-step" type="number" min="0.001" step="0.001" value="0.033" /> 秒</label>
      </div>
      <div class="row">
        <button id="video-frame-copy" class="primary" disabled>📋 复制当前帧到剪贴板</button>
        <button id="video-frame-download" disabled>⬇ 下载当前帧 PNG</button>
      </div>
      <div id="video-frame-status" class="status"></div>
      <p class="hint">使用滑块或左右按钮定位画面。截图会按当前视频分辨率生成 PNG，可直接复制到剪贴板或保存到本地。</p>
    </section>

    <!-- 任务 -->
    <section class="panel hidden" id="panel-tasks">
      <div class="tasks-bar">
        <div class="status" id="task-counts"></div>
        <button class="mini" id="btn-clear-done">清空已完成</button>
      </div>
      <div class="tasklist" id="task-list"></div>
    </section>

    <!-- 漫剧工作台（内嵌本地服务提供的静态页） -->
    <section class="panel hidden" id="panel-drama" style="padding:0;overflow:hidden;">
      <iframe id="drama-iframe" style="width:100%;height:100%;border:none;" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
    </section>

    <!-- 设置 -->
    <section class="panel hidden" id="panel-settings">
      <label class="field">
        <span>请求地址 (Base URL)</span>
        <input id="set-base" type="text" placeholder="${DEFAULT_BASE}" />
      </label>
      <div class="field">
        <span>登录方式</span>
        <div class="row" style="gap:8px;">
          <button class="mini" id="auth-mode-apikey" type="button">① API Key</button>
          <button class="mini" id="auth-mode-password" type="button">② 用户名 + 密码</button>
        </div>
      </div>

      <div id="wrap-apikey">
        <label class="field">
          <span>API Key（Bearer Token）</span>
          <input id="set-key" type="password" placeholder="sk-..." />
        </label>
        <p class="hint">在网站 <code>/profile</code> 的「API Key 管理」创建，会以 <code>Authorization: Bearer</code> 发送。</p>
      </div>

      <div id="wrap-password" class="hidden">
        <label class="field">
          <span>用户名</span>
          <input id="set-username" type="text" autocomplete="username" placeholder="网站登录用户名" />
        </label>
        <label class="field">
          <span>密码</span>
          <input id="set-password" type="password" autocomplete="current-password" placeholder="网站登录密码" />
        </label>
        <div class="row" style="gap:8px;align-items:center;">
          <button class="primary" id="btn-login" type="button">登录</button>
          <button class="mini" id="btn-logout" type="button">退出登录</button>
          <span id="login-state" style="font-size:13px;color:var(--muted);"></span>
        </div>
        <div class="pwd-setup-hint hidden" id="set-pwd-hint"></div>
        <p class="hint">
          登录后只会用你的账号密码向「接口地址」换一个短期 Token，Token 保存在本机、随生图请求发出；<b>密码不会保存，也不会发给任何第三方</b>。<br />
          Token 过期后重新点一次「登录」即可。
        </p>
      </div>
      <label class="field">
        <span>图片上传地址 (Upload URL，留空＝用平台自带 OSS，推荐)</span>
        <input id="set-upload" type="text" placeholder="留空即用平台 OSS：{接口地址}/api/v1/uploads/upload?public=true" />
      </label>
      <div class="row">
        <label class="field small-2">
          <span>等待超时（秒）</span>
          <input id="set-timeout" type="number" min="10" max="1800" />
        </label>
        <label class="field small-2">
          <span>最大同时任务数</span>
          <input id="set-concurrency" type="number" min="1" max="16" />
        </label>
        <label class="field">
          <span>账户类型（调试，可留空）</span>
          <select id="set-tier">
            <option value="">默认</option>
            <option value="free">free</option>
            <option value="plus">plus</option>
            <option value="think">think</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span>调试 Token（debug_chatgpt_token，可留空）</span>
        <input id="set-debug-token" type="text" placeholder="一般无需填写" />
      </label>
      <div class="row">
      <hr style="border-color:var(--border);margin:16px 0;" />
      <p style="color:var(--muted);font-size:13px;margin:0 0 8px;">
        🎬 视频接口（pic2api） — 漫剧工作台视频生成的独立接口
      </p>
      <label class="field">
        <span>视频接口地址</span>
        <input id="set-pic2api-base" type="text" placeholder="${DEFAULT_PIC2API_BASE}" />
      </label>
      <label class="field">
        <span>视频 API Key</span>
        <input id="set-pic2api-key" type="password" placeholder="sk-..." />
      </label>
      <label class="field">
        <span>视频默认模型</span>
        <input id="set-pic2api-model" type="text" placeholder="${DEFAULT_PIC2API_MODEL}" />
      </label>
      <hr style="border-color:var(--border);margin:16px 0;" />
      <p style="color:var(--muted);font-size:13px;margin:0 0 8px;">
        🎙️ 配音接口（DashScope / 阿里云） — 可留空，用本地模拟音
      </p>
      <label class="field">
        <span>DashScope API Key</span>
        <input id="set-dashscope-key" type="password" placeholder="sk-..." />
      </label>
      <label class="field">
        <span>音色设计模型</span>
        <input id="set-dashscope-design" type="text" placeholder="${DEFAULT_DASHSCOPE_DESIGN}" />
      </label>
      <label class="field">
        <span>TTS 模型</span>
        <input id="set-dashscope-tts" type="text" placeholder="${DEFAULT_DASHSCOPE_TTS}" />
      </label>
      <hr style="border-color:var(--border);margin:16px 0;" />
      <p style="color:var(--muted);font-size:13px;margin:0 0 8px;">
        🎞️ 视频截帧（ffmpeg） — 留空用系统 PATH 里的 ffmpeg
      </p>
      <label class="field">
        <span>ffmpeg 路径</span>
        <input id="set-ffmpeg-path" type="text" placeholder="留空或用绝对路径" />
      </label>
        <button class="primary" id="btn-save">保存设置</button>
      </div>
      <div class="status" id="set-status"></div>
      <p class="hint">
        生成的图片会自动保存到「图片 / Pictures」目录下的 <code>linggan10s-image-tool</code> 文件夹。设置仅保存在本机。<br />
        模型：<code>gpt-5-3</code> = GPT-Image（标准）；<code>gpt-5-4-thinking</code> = GPT-Image2（仅 Plus 账户可用）。<br />
        点「生成」会把任务加入队列并立刻返回，可连续提交；同时进行的数量由「最大同时任务数」控制，多出的会排队。<br />
        漫剧工作台的所有 Key <b>留在 Rust 端</b>，工作台页面拿不到。
      </p>
    </section>
  </main>
`;

// ---------- helpers ----------
function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

type StatusKind = "info" | "error" | "ok" | "busy";
function setStatus(id: string, msg: string, kind: StatusKind = "info"): void {
  const e = byId<HTMLDivElement>(id);
  e.textContent = msg;
  e.className = `status ${kind}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function modelLabel(value: string): string {
  return MODELS.find((m) => m.value === value)?.label ?? value;
}

// ---------- lightbox (click any image to enlarge) ----------
let lightboxEl: HTMLDivElement | null = null;
function closeLightbox(): void {
  lightboxEl?.classList.add("hidden");
}
function openLightbox(src: string): void {
  if (!src) return;
  if (!lightboxEl) {
    lightboxEl = document.createElement("div");
    lightboxEl.className = "lightbox hidden";
    lightboxEl.appendChild(document.createElement("img"));
    lightboxEl.addEventListener("click", closeLightbox);
    document.body.appendChild(lightboxEl);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeLightbox();
    });
  }
  (lightboxEl.firstElementChild as HTMLImageElement).src = src;
  lightboxEl.classList.remove("hidden");
}

/** One result image as a card with preview + actions. */
function buildImageCard(out: ImageOut): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "card";

  const img = document.createElement("img");
  img.style.cursor = "pointer";
  img.title = "点击放大查看";
  card.appendChild(img);

  const dl = document.createElement("a");
  dl.className = "mini";
  dl.textContent = "另存为";
  dl.download = out.saved_path.split(/[\\/]/).pop() || "image.png";

  // Resolve the image: use in-memory base64 if present, otherwise read it back
  // from disk (persisted tasks store only the path, not heavy base64).
  let dataUri = "";
  const apply = (b64: string, mime: string) => {
    dataUri = `data:${mime};base64,${b64}`;
    img.src = dataUri;
    dl.href = dataUri;
  };
  if (out.b64) {
    apply(out.b64, out.mime);
  } else if (out.saved_path) {
    invoke<{ b64: string; mime: string }>("read_saved_image", { path: out.saved_path })
      .then((r) => apply(r.b64, r.mime))
      .catch(() => {
        img.alt = "图片已不在磁盘";
        img.title = "原文件已被移动或删除";
      });
  }
  img.addEventListener("click", () => openLightbox(dataUri));

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.appendChild(dl);

  const copyPath = document.createElement("button");
  copyPath.className = "mini";
  copyPath.textContent = "复制路径";
  copyPath.addEventListener("click", async () => {
    copyPath.textContent = (await copyText(out.saved_path)) ? "已复制 ✓" : "复制失败";
    setTimeout(() => (copyPath.textContent = "复制路径"), 1200);
  });
  actions.appendChild(copyPath);

  if (out.source_url) {
    const copyUrl = document.createElement("button");
    copyUrl.className = "mini";
    copyUrl.textContent = "复制链接";
    copyUrl.addEventListener("click", async () => {
      copyUrl.textContent = (await copyText(out.source_url!)) ? "已复制 ✓" : "复制失败";
      setTimeout(() => (copyUrl.textContent = "复制链接"), 1200);
    });
    actions.appendChild(copyUrl);
  }
  card.appendChild(actions);

  const path = document.createElement("div");
  path.className = "path";
  path.textContent = `已保存：${out.saved_path}`;
  card.appendChild(path);

  return card;
}

/** True when the saved login token is still valid (unknown expiry counts as OK). */
function loginValid(): boolean {
  if (settings.authMode !== "password") return false;
  if (!settings.loginToken) return false;
  return !settings.loginExp || settings.loginExp * 1000 > Date.now();
}

function ensureConfigured(statusId: string): boolean {
  if (settings.authMode === "password") {
    if (!settings.loginToken) {
      setStatus(statusId, "请先在「首页」用用户名和密码登录。", "error");
      switchTab("home");
      return false;
    }
    if (!loginValid()) {
      setStatus(statusId, "登录已过期，请到「首页」重新登录。", "error");
      switchTab("home");
      return false;
    }
  } else if (!settings.apiKey) {
    setStatus(statusId, "请先在「设置」里填写 API Key。", "error");
    switchTab("settings");
    return false;
  }
  return true;
}

/** Wire a size <select> + custom input pair; returns the effective-size getter. */
function wireSize(prefix: string): () => string | null {
  const sel = byId<HTMLSelectElement>(`${prefix}-size`);
  const custom = byId<HTMLInputElement>(`${prefix}-size-custom`);
  const sync = () => {
    const isCustom = sel.value === "__custom__";
    custom.classList.toggle("hidden", !isCustom);
    if (isCustom && !custom.value && !SIZES.some((s) => s.value === settings.size)) {
      custom.value = settings.size;
    }
  };
  sel.addEventListener("change", sync);
  sync();
  return () => {
    if (sel.value === AUTO_SIZE) return null;
    if (sel.value !== "__custom__") return sel.value;
    const v = custom.value.trim();
    if (!SIZE_PATTERN.test(v)) return INVALID_SIZE;
    return v;
  };
}

function appendSizeToPrompt(prompt: string, size: string | null): string {
  if (!size) return prompt;
  const [w, h] = size.split("x").map((x) => Number(x));
  const orientation = Number.isFinite(w) && Number.isFinite(h)
    ? w === h
      ? "square"
      : w > h
        ? "landscape"
        : "portrait"
    : "";
  const rule = [
    `Mandatory output canvas: ${size}.`,
    orientation ? `Use a ${orientation} composition exactly matching ${size}.` : "",
    "Do not generate any other aspect ratio. Do not crop to square. Even if the API size parameter is ignored, follow this canvas size/aspect ratio from the prompt.",
  ].filter(Boolean).join(" ");
  return `${prompt}\n\n${rule}`;
}

// ---------- tabs ----------
let dramaLoaded = false;

function switchTab(name: string): void {
  // Never land on a hidden tab (e.g. the drama workspace in the official build).
  if (name === "drama" && !SHOW_DRAMA) name = "t2i";
  for (const t of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    t.classList.toggle("active", t.dataset.tab === name);
  }
  for (const p of document.querySelectorAll<HTMLElement>(".panel")) {
    p.classList.toggle("hidden", p.id !== `panel-${name}`);
  }
  // First time visiting drama: load the embedded workspace into the iframe.
  if (name === "drama" && !dramaLoaded) {
    loadDramaIframe();
  }
}
for (const t of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  t.addEventListener("click", () => switchTab(t.dataset.tab!));
}
// 未配置任何凭证时先落在首页（登录入口），否则直接进文生图。
function isReady(): boolean {
  return settings.authMode === "password"
    ? loginValid()
    : !!settings.apiKey;
}
switchTab(isReady() ? "t2i" : "home");

// ---------- gateway / drama workspace ----------
// Hidden in the official build (see SHOW_DRAMA), but kept intact so flipping
// the flag back is all it takes to bring it back.
async function loadDramaIframe() {
  if (!SHOW_DRAMA) return;
  try {
    const url: string = await invoke("gateway_url");
    const iframe = byId<HTMLIFrameElement>("drama-iframe");
    iframe.src = `${url}/main.html`;
    dramaLoaded = true;
  } catch (e) {
    setStatus("drama-status", `无法连接到漫剧服务：${e}`, "error");
  }
}

// Push current settings to the gateway on startup (best-effort).
syncGatewayConfig();

// ---------- task queue ----------
let tasks: Task[] = [];
let taskSeq = 0;
let running = 0;
const queue: number[] = [];

function statusText(s: TaskStatus): string {
  return { queued: "排队中", running: "生成中…", done: "完成", error: "失败" }[s];
}

function buildTaskCard(t: Task): HTMLDivElement {
  const card = document.createElement("div");
  card.className = `task ${t.status}`;

  const head = document.createElement("div");
  head.className = "task-head";

  const badge = document.createElement("span");
  badge.className = `badge ${t.status}`;
  badge.textContent = statusText(t.status);
  head.appendChild(badge);

  const meta = document.createElement("span");
  meta.className = "task-meta";
  const kind = t.kind === "t2i" ? "文生图" : `图生图·${t.image.length}图`;
  meta.textContent = `${kind} · ${modelLabel(t.model)} · ${t.size ?? "默认"} · ${t.timeLabel}`;
  head.appendChild(meta);

  const acts = document.createElement("div");
  acts.className = "task-actions";
  const regen = document.createElement("button");
  regen.className = "mini";
  regen.textContent = "再来一张";
  regen.addEventListener("click", () => enqueue(t.kind, t.model, t.size, t.prompt, t.image));
  acts.appendChild(regen);
  if (t.status !== "running") {
    const rm = document.createElement("button");
    rm.className = "mini";
    rm.textContent = "删除";
    rm.addEventListener("click", () => removeTask(t.id));
    acts.appendChild(rm);
  }
  head.appendChild(acts);
  card.appendChild(head);

  const promptEl = document.createElement("div");
  promptEl.className = "task-prompt";
  promptEl.textContent = t.prompt;
  card.appendChild(promptEl);

  if (t.status === "queued" || t.status === "running") {
    const body = document.createElement("div");
    body.className = "task-body busy";
    const sp = document.createElement("span");
    sp.className = "spinner";
    body.appendChild(sp);
    const txt = document.createElement("span");
    txt.textContent = t.status === "queued" ? "排队等待空位…" : "正在生成，请稍候…";
    body.appendChild(txt);
    card.appendChild(body);
  } else if (t.status === "error") {
    const body = document.createElement("div");
    body.className = "task-body err";
    body.textContent = t.error;
    card.appendChild(body);
  } else {
    const grid = document.createElement("div");
    grid.className = "results";
    for (const out of t.outs) grid.appendChild(buildImageCard(out));
    card.appendChild(grid);
  }
  return card;
}

function renderTasks(): void {
  const runningCount = tasks.filter((t) => t.status === "running").length;
  const active = runningCount + queue.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const err = tasks.filter((t) => t.status === "error").length;

  const badge = byId<HTMLSpanElement>("task-badge");
  badge.textContent = active ? String(active) : "";
  badge.classList.toggle("hidden", active === 0);

  byId<HTMLDivElement>("task-counts").textContent =
    `生成中 ${runningCount} · 排队 ${queue.length} · 完成 ${done} · 失败 ${err}`;

  const list = byId<HTMLDivElement>("task-list");
  list.innerHTML = "";
  if (tasks.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "还没有任务。在「文生图」或「图生图」点「生成」即可，连续点会并行/排队。";
    list.appendChild(hint);
    return;
  }
  for (const t of tasks) list.appendChild(buildTaskCard(t));
}

function buildReq(t: Task) {
  const useToken = settings.authMode === "password";
  return {
    // 请求地址留空就用默认地址，不让用户卡在这一步
    baseUrl: (settings.baseUrl || DEFAULT_BASE).trim(),
    apiKey: useToken ? "" : settings.apiKey,
    token: useToken ? settings.loginToken : undefined,
    model: t.model,
    prompt: t.prompt,
    size: t.size ?? undefined,
    image: t.image,
    timeoutSec: settings.timeoutSec,
    accountTier: settings.accountTier || undefined,
    debugToken: settings.debugToken || undefined,
    uploadUrl: settings.uploadUrl || undefined,
  };
}

async function runTask(t: Task): Promise<void> {
  try {
    t.outs = await invoke<ImageOut[]>("generate_images", { req: buildReq(t) });
    t.status = "done";
  } catch (e) {
    t.error = String(e);
    t.status = "error";
  } finally {
    running--;
    renderTasks();
    saveTasks();
    pump();
  }
}

function pump(): void {
  while (running < Math.max(1, settings.maxConcurrent) && queue.length > 0) {
    const id = queue.shift()!;
    const t = tasks.find((x) => x.id === id);
    if (!t) continue;
    t.status = "running";
    running++;
    renderTasks();
    void runTask(t);
  }
}

function enqueue(
  kind: Task["kind"],
  model: string,
  size: string | null,
  prompt: string,
  image: string[],
): void {
  const id = ++taskSeq;
  tasks.unshift({
    id,
    kind,
    model,
    size,
    prompt,
    image,
    status: "queued",
    outs: [],
    error: "",
    timeLabel: new Date().toLocaleTimeString(),
  });
  queue.push(id);
  renderTasks();
  saveTasks();
  pump();
}

function removeTask(id: number): void {
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0 || tasks[i].status === "running") return;
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  tasks.splice(i, 1);
  renderTasks();
  saveTasks();
}

byId<HTMLButtonElement>("btn-clear-done").addEventListener("click", () => {
  tasks = tasks.filter((t) => t.status === "running" || t.status === "queued");
  renderTasks();
  saveTasks();
});

function submittedNote(n = 1): string {
  const prefix = n > 1 ? `已加入 ${n} 个任务 ✓` : "已加入任务 ✓";
  return `${prefix}（生成中 ${running}，排队 ${queue.length}）— 切到「任务」查看结果`;
}

/** Read the "出图张数" input (1-4). The API returns one image per request,
 *  so N images = N enqueued tasks, run via the existing concurrency queue. */
function readCount(id: string): number {
  const v = parseInt(byId<HTMLInputElement>(id).value, 10);
  return Number.isFinite(v) ? Math.min(4, Math.max(1, v)) : 1;
}

// ---------- task persistence (survive app restart) ----------
// We store only metadata + each result's saved_path (NOT the base64 bytes —
// that would blow the localStorage quota). On reload the images are read back
// from disk via the `read_saved_image` command.
function saveTasks(): void {
  try {
    const slim = tasks.slice(0, 60).map((t): Task => {
      const interrupted = t.status === "queued" || t.status === "running";
      return {
        ...t,
        status: interrupted ? "error" : t.status,
        error: interrupted ? "（应用已重启，任务未完成）" : t.error,
        outs: t.outs.map((o) => ({ ...o, b64: "" })),
      };
    });
    localStorage.setItem(TASKS_KEY, JSON.stringify({ seq: taskSeq, tasks: slim }));
  } catch {
    /* quota / serialization issues are non-fatal */
  }
}
function loadTasks(): void {
  try {
    const raw =
      localStorage.getItem(TASKS_KEY) ??
      LEGACY_TASKS_KEYS.map((k) => localStorage.getItem(k)).find((v): v is string => !!v);
    if (!raw) return;
    const data = JSON.parse(raw) as { seq?: number; tasks?: Task[] };
    if (!Array.isArray(data.tasks)) return;
    tasks = data.tasks.map((t): Task => ({
      ...t,
      status: t.status === "queued" || t.status === "running" ? "error" : t.status,
      error: t.error || "",
      outs: Array.isArray(t.outs) ? t.outs : [],
    }));
    taskSeq =
      typeof data.seq === "number"
        ? data.seq
        : tasks.reduce((m, t) => Math.max(m, t.id), 0);
    saveTasks();
  } catch {
    /* ignore corrupt storage */
  }
}

loadTasks();
renderTasks();

// ---------- settings wiring ----------
const baseInput = byId<HTMLInputElement>("set-base");
const keyInput = byId<HTMLInputElement>("set-key");
const timeoutInput = byId<HTMLInputElement>("set-timeout");
const concurrencyInput = byId<HTMLInputElement>("set-concurrency");
const tierSelect = byId<HTMLSelectElement>("set-tier");
const debugTokenInput = byId<HTMLInputElement>("set-debug-token");
const uploadInput = byId<HTMLInputElement>("set-upload");
const pic2apiBaseInput = byId<HTMLInputElement>("set-pic2api-base");
const pic2apiKeyInput = byId<HTMLInputElement>("set-pic2api-key");
const pic2apiModelInput = byId<HTMLInputElement>("set-pic2api-model");
const dashscopeKeyInput = byId<HTMLInputElement>("set-dashscope-key");
const dashscopeDesignInput = byId<HTMLInputElement>("set-dashscope-design");
const dashscopeTtsInput = byId<HTMLInputElement>("set-dashscope-tts");
const ffmpegPathInput = byId<HTMLInputElement>("set-ffmpeg-path");
const usernameInput = byId<HTMLInputElement>("set-username");
const passwordInput = byId<HTMLInputElement>("set-password");
const btnLogin = byId<HTMLButtonElement>("btn-login");
const btnLogout = byId<HTMLButtonElement>("btn-logout");
const loginState = byId<HTMLSpanElement>("login-state");
const btnAuthApiKey = byId<HTMLButtonElement>("auth-mode-apikey");
const btnAuthPassword = byId<HTMLButtonElement>("auth-mode-password");

/** Home page login form (mirrors the settings-page one). */
const homeLoginCard = byId<HTMLDivElement>("home-login-card");
const homeAccountCard = byId<HTMLDivElement>("home-account-card");
const homeUsernameInput = byId<HTMLInputElement>("home-username");
const homePasswordInput = byId<HTMLInputElement>("home-password");
const homeLoginBtn = byId<HTMLButtonElement>("home-login");
const homePwdHintEl = byId<HTMLDivElement>("home-pwd-hint");
const setPwdHintEl = byId<HTMLDivElement>("set-pwd-hint");

/**
 * Show the panel matching the current `authMode` and paint the login state.
 * Called on boot, on mode switch, and after a successful login.
 */
function renderAuthUi(): void {
  const isPwd = settings.authMode === "password";
  byId<HTMLDivElement>("wrap-apikey").classList.toggle("hidden", isPwd);
  byId<HTMLDivElement>("wrap-password").classList.toggle("hidden", !isPwd);

  btnAuthApiKey.classList.toggle("primary", !isPwd);
  btnAuthApiKey.classList.toggle("mini", isPwd);
  btnAuthPassword.classList.toggle("primary", isPwd);
  btnAuthPassword.classList.toggle("mini", !isPwd);

  // Home page: swap the login form for the account card once we have a
  // credential. In API-key mode we consider the user "ready" as soon as a
  // key is saved, so the home page doubles as a quick status board.
  const ready = isPwd ? loginValid() : !!settings.apiKey;
  homeLoginCard.classList.toggle("hidden", ready);
  homeAccountCard.classList.toggle("hidden", !ready);
  if (ready) {
    byId("home-account-name").textContent = isPwd ? settings.loginUser : "API Key 用户";
    byId("home-account-mode").textContent = isPwd ? "用户名 + 密码" : "API Key";
    byId("home-account-exp").textContent = isPwd
      ? settings.loginExp
        ? new Date(settings.loginExp * 1000).toLocaleString()
        : "未知"
      : "长期有效";
    byId("home-account-base").textContent = settings.baseUrl || DEFAULT_BASE;
  }

  if (!isPwd) {
    loginState.textContent = "";
    return;
  }
  if (!settings.loginToken) {
    loginState.textContent = "未登录";
    loginState.style.color = "var(--muted)";
    return;
  }
  const expired = !loginValid();
  const when = settings.loginExp
    ? new Date(settings.loginExp * 1000).toLocaleString()
    : "未知";
  loginState.textContent = expired
    ? `已登录：${settings.loginUser}（Token 已于 ${when} 过期，请重新登录）`
    : `已登录：${settings.loginUser}（有效期至 ${when}）`;
  loginState.style.color = expired ? "var(--err, #f85149)" : "var(--ok, #3fb950)";
}

/**
 * Accounts created through phone SMS verification start out with no password
 * (`password` is NULL server-side), so a username+password login can never
 * succeed for them and the backend only says "密码错误". Detect the likely
 * case and point the user at the page where they can set one.
 */
const PASSWORD_SETUP_URL = "https://linggan10s.shop/profile";

function looksLikePhone(u: string): boolean {
  return /^1[3-9]\d{9}$/.test(u.trim());
}

function showPasswordSetupHint(el: HTMLElement | null): void {
  if (!el) return;
  el.textContent = "";
  const p = document.createElement("p");
  p.className = "hint pwd-hint";
  const b = document.createElement("b");
  b.textContent = "手机验证码";
  const a = document.createElement("a");
  a.href = PASSWORD_SETUP_URL;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = PASSWORD_SETUP_URL;
  p.append(
    "如果你是",
    b,
    "注册 / 登录的用户，账号默认没有密码，请先到 ",
    a,
    " 点击「账户设置」→「设置密码」，设置完成后再回来登录。",
  );
  el.appendChild(p);
  el.classList.remove("hidden");
}

function hidePasswordSetupHint(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.add("hidden");
  el.textContent = "";
}

/** Forget the session token. `statusId` picks where to show the confirmation. */
async function doLogout(statusId: string): Promise<void> {
  settings = { ...settings, loginToken: "", loginUser: "", loginExp: 0 };
  saveSettings(settings);
  passwordInput.value = "";
  homePasswordInput.value = "";
  await syncGatewayConfig();
  renderAuthUi();
  hidePasswordSetupHint(homePwdHintEl);
  hidePasswordSetupHint(setPwdHintEl);
  setStatus(statusId, "已退出登录 ✓", "ok");
}

/** Switch login mode. Switching away from password keeps the token so the
 *  user can switch back without logging in again. */
function setAuthMode(mode: AuthMode): void {
  settings = { ...settings, authMode: mode };
  saveSettings(settings);
  renderAuthUi();
}

btnAuthApiKey.addEventListener("click", () => setAuthMode("apikey"));
btnAuthPassword.addEventListener("click", () => setAuthMode("password"));

/** Accept either key spelling — Tauri may camelCase command return values. */
interface LoginResult {
  access_token?: string;
  accessToken?: string;
  username?: string;
  expires_at?: number;
  expiresAt?: number;
}

/**
 * Shared login used by both the home page and the settings page.
 * `report` pushes progress / errors into whichever panel triggered it.
 */
async function doLogin(
  username: string,
  password: string,
  report: (msg: string, kind: "info" | "error" | "ok") => void,
  hintEl: HTMLElement | null = null,
): Promise<boolean> {
  const user = username.trim();
  if (!user) {
    report("请输入用户名。", "error");
    return false;
  }
  // 密码不做 trim，末尾空格是合法的
  if (!password) {
    report("请输入密码。", "error");
    return false;
  }

  report("登录中…", "info");
  try {
    // 请求地址留空就用默认地址，不阻塞登录
    const base = (baseInput.value.trim() || settings.baseUrl || DEFAULT_BASE).trim();
    const r = await invoke<LoginResult>("platform_login", { base, username: user, password });
    const token = r.access_token ?? r.accessToken ?? "";
    const name = r.username ?? user;
    if (!token) {
      report("登录响应里没有 access_token，请重试。", "error");
      return false;
    }
    settings = {
      ...settings,
      baseUrl: settings.baseUrl || DEFAULT_BASE,
      authMode: "password",
      loginUser: name,
      loginToken: token,
      loginExp: r.expires_at ?? r.expiresAt ?? 0,
    };
    saveSettings(settings);
    // 密码只在内存里用一次，两个输入框都清空
    passwordInput.value = "";
    homePasswordInput.value = "";
    homeUsernameInput.value = name;
    await syncGatewayConfig();
    renderAuthUi();
    hidePasswordSetupHint(hintEl);
    report(`已登录：${name} ✓`, "ok");
    return true;
  } catch (e) {
    const msg = String(e);
    report(`登录失败：${msg}`, "error");
    // 手机号用户名，或报错提到密码 —— 都可能是「手机注册未设密码」
    if (looksLikePhone(username) || /密码|password/i.test(msg)) {
      showPasswordSetupHint(hintEl);
    } else {
      hidePasswordSetupHint(hintEl);
    }
    return false;
  }
}

btnLogin.addEventListener("click", async () => {
  btnLogin.disabled = true;
  try {
    await doLogin(
      usernameInput.value,
      passwordInput.value,
      setLoginMsg,
      setPwdHintEl,
    );
  } finally {
    btnLogin.disabled = false;
  }
});

btnLogout.addEventListener("click", () => doLogout("set-status"));

// ---- home page wiring ----
byId<HTMLButtonElement>("home-use-apikey").addEventListener("click", async () => {
  // 切到 API Key 模式，把请求地址填成默认值，然后直接跳到设置页
  if (!baseInput.value.trim()) baseInput.value = DEFAULT_BASE;
  if (!settings.baseUrl) settings = { ...settings, baseUrl: DEFAULT_BASE };
  await setAuthMode("apikey");
  saveSettings(settings);
  await syncGatewayConfig();
  switchTab("settings");
  setStatus("set-status", "已切换到 API Key 模式，填写 Key 后保存即可使用 ✓", "info");
  keyInput.focus();
});

homeLoginBtn.addEventListener("click", async () => {
  homeLoginBtn.disabled = true;
  try {
    const ok = await doLogin(
      homeUsernameInput.value,
      homePasswordInput.value,
      (msg, kind) => setStatus("home-status", msg, kind),
      homePwdHintEl,
    );
    if (ok) {
      setStatus("home-status", "", "info");
      switchTab("t2i");
    }
  } finally {
    homeLoginBtn.disabled = false;
  }
});

// 用户名填的是手机号 → 提前提示：手机验证码注册的账号默认没有密码
function watchPhoneUsername(input: HTMLInputElement, hintEl: HTMLElement | null): void {
  input.addEventListener("input", () => {
    if (looksLikePhone(input.value)) showPasswordSetupHint(hintEl);
    else hidePasswordSetupHint(hintEl);
  });
}
watchPhoneUsername(homeUsernameInput, homePwdHintEl);
watchPhoneUsername(usernameInput, setPwdHintEl);

// 退出后「账户卡」会被隐藏，所以提示要打到登录卡的 status 上。
byId<HTMLButtonElement>("home-logout").addEventListener("click", () => doLogout("home-status"));
byId<HTMLButtonElement>("home-go-generate").addEventListener("click", () => switchTab("t2i"));
byId<HTMLButtonElement>("home-go-settings").addEventListener("click", () => switchTab("settings"));

function setLoginMsg(msg: string, kind: "info" | "error" | "ok"): void {
  loginState.textContent = msg;
  loginState.style.color =
    kind === "error" ? "var(--err, #f85149)" : kind === "ok" ? "var(--ok, #3fb950)" : "var(--muted)";
}

baseInput.value = settings.baseUrl;
keyInput.value = settings.apiKey;
usernameInput.value = settings.loginUser;
timeoutInput.value = String(settings.timeoutSec);
concurrencyInput.value = String(settings.maxConcurrent);
tierSelect.value = settings.accountTier;
debugTokenInput.value = settings.debugToken;
uploadInput.value = settings.uploadUrl;
pic2apiBaseInput.value = settings.pic2apiBase;
pic2apiKeyInput.value = settings.pic2apiKey;
pic2apiModelInput.value = settings.pic2apiModel;
dashscopeKeyInput.value = settings.dashscopeKey;
dashscopeDesignInput.value = settings.dashscopeDesignModel;
dashscopeTtsInput.value = settings.dashscopeTtsModel;
ffmpegPathInput.value = settings.ffmpegPath;
// Paint the login panel last — it touches the element refs declared above.
renderAuthUi();

// Push settings to the embedded gateway (image gen + chat upstream keys).
async function syncGatewayConfig() {
  try {
    await invoke("configure_gateway", {
      cfg: {
        imgBase: settings.baseUrl || DEFAULT_BASE,
        imgKey: settings.apiKey,
        imgToken: settings.loginToken,
        imgModel: settings.model,
        imgUploadUrl: settings.uploadUrl || "",
        imgTimeout: settings.timeoutSec,
        pic2apiBase: settings.pic2apiBase || DEFAULT_PIC2API_BASE,
        pic2apiKey: settings.pic2apiKey,
        pic2apiModel: settings.pic2apiModel || DEFAULT_PIC2API_MODEL,
        dashscopeKey: settings.dashscopeKey,
        dashscopeDesignModel: settings.dashscopeDesignModel || DEFAULT_DASHSCOPE_DESIGN,
        dashscopeTtsModel: settings.dashscopeTtsModel || DEFAULT_DASHSCOPE_TTS,
        ffmpegPath: settings.ffmpegPath,
      },
    });
  } catch (e) {
    // gateway sync is best-effort; ignore if not ready yet
  }
}

byId<HTMLButtonElement>("btn-save").addEventListener("click", async () => {
  const t = parseInt(timeoutInput.value, 10);
  const c = parseInt(concurrencyInput.value, 10);
  settings = {
    ...settings,
    baseUrl: baseInput.value.trim() || DEFAULT_BASE,
    // Keep the current mode; the ①/② buttons are what switch it.
    authMode: settings.authMode,
    apiKey: keyInput.value.trim(),
    loginUser: usernameInput.value.trim(),
    // Token / expiry are only changed by login & logout.
    loginToken: settings.loginToken,
    loginExp: settings.loginExp,
    timeoutSec: Number.isFinite(t) ? Math.min(1800, Math.max(10, t)) : 600,
    maxConcurrent: Number.isFinite(c) ? Math.min(16, Math.max(1, c)) : 3,
    accountTier: tierSelect.value,
    debugToken: debugTokenInput.value.trim(),
    uploadUrl: uploadInput.value.trim() || DEFAULT_UPLOAD,
    pic2apiBase: pic2apiBaseInput.value.trim() || DEFAULT_PIC2API_BASE,
    pic2apiKey: pic2apiKeyInput.value.trim(),
    pic2apiModel: pic2apiModelInput.value.trim() || DEFAULT_PIC2API_MODEL,
    dashscopeKey: dashscopeKeyInput.value.trim(),
    dashscopeDesignModel: dashscopeDesignInput.value.trim() || DEFAULT_DASHSCOPE_DESIGN,
    dashscopeTtsModel: dashscopeTtsInput.value.trim() || DEFAULT_DASHSCOPE_TTS,
    ffmpegPath: ffmpegPathInput.value.trim(),
  };
  timeoutInput.value = String(settings.timeoutSec);
  concurrencyInput.value = String(settings.maxConcurrent);
  saveSettings(settings);
  await syncGatewayConfig();
  setStatus("set-status", "已保存 ✓", "ok");
  pump(); // a higher limit may let queued tasks start now
});

// ---------- 文生图 ----------
const t2iSize = wireSize("t2i");
byId<HTMLButtonElement>("t2i-go").addEventListener("click", () => {
  const prompt = byId<HTMLTextAreaElement>("t2i-prompt").value.trim();
  if (!prompt) return setStatus("t2i-status", "请输入提示词。", "error");
  if (!ensureConfigured("t2i-status")) return;
  const size = t2iSize();
  if (size === INVALID_SIZE) return setStatus("t2i-status", "自定义尺寸格式不对，应为「宽x高」，如 1024x1024。", "error");
  const model = byId<HTMLSelectElement>("t2i-model").value;
  settings = { ...settings, model, size: size ?? settings.size };
  saveSettings(settings);
  const count = readCount("t2i-count");
  const finalPrompt = appendSizeToPrompt(prompt, size);
  for (let i = 0; i < count; i++) enqueue("t2i", model, size, finalPrompt, []);
  setStatus("t2i-status", submittedNote(count), "ok");
});

// ---------- 图生图 ----------
const i2iSize = wireSize("i2i");
let refImgs: RefImg[] = [];

function renderRefs(): void {
  const box = byId<HTMLDivElement>("i2i-refs");
  box.innerHTML = "";
  refImgs.forEach((r, i) => {
    const chip = document.createElement("div");
    chip.className = "ref";
    const img = document.createElement("img");
    img.src = r.value;
    img.style.cursor = "pointer";
    img.title = "点击放大查看";
    img.addEventListener("click", () => openLightbox(r.value));
    chip.appendChild(img);
    const rm = document.createElement("button");
    rm.className = "ref-rm";
    rm.textContent = "×";
    rm.title = r.label;
    rm.addEventListener("click", () => {
      refImgs.splice(i, 1);
      renderRefs();
    });
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

/** Read a Blob/File into a data: URI and add it as a reference image. */
function addRefFromBlob(blob: Blob, label: string): void {
  const reader = new FileReader();
  reader.onload = () => {
    refImgs.push({ value: String(reader.result), label });
    renderRefs();
  };
  reader.readAsDataURL(blob);
}

/** A friendly file extension for an image MIME type, e.g. "image/png" -> "png". */
function imageExt(mime: string): string {
  return (mime.split("/")[1] || "png").split(/[;+]/)[0] || "png";
}

byId<HTMLInputElement>("i2i-file").addEventListener("change", (ev) => {
  const files = (ev.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of Array.from(files)) addRefFromBlob(file, file.name);
  (ev.target as HTMLInputElement).value = "";
});

byId<HTMLButtonElement>("i2i-add-url").addEventListener("click", () => {
  const input = byId<HTMLInputElement>("i2i-url");
  const url = input.value.trim();
  if (!url) return;
  refImgs.push({ value: url, label: url });
  input.value = "";
  renderRefs();
});

// ----- paste clipboard images straight into the reference list -----

/** Add every image carried by a paste/drop transfer; returns how many landed. */
function addRefsFromTransfer(dt: DataTransfer | null): number {
  if (!dt) return 0;
  let n = 0;
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        addRefFromBlob(file, file.name || `剪贴板图片.${imageExt(file.type)}`);
        n++;
      }
    }
  }
  return n;
}

// Ctrl/⌘+V anywhere on the 图生图 tab pastes clipboard images in. Plain-text
// pastes carry no image items, so the URL / prompt fields keep working normally.
document.addEventListener("paste", (ev) => {
  const panel = document.getElementById("panel-i2i");
  if (!panel || panel.classList.contains("hidden")) return;
  const n = addRefsFromTransfer(ev.clipboardData);
  if (n > 0) {
    ev.preventDefault();
    setStatus("i2i-status", `已从剪贴板粘贴 ${n} 张参考图 ✓`, "ok");
  }
});

// The button reads the clipboard on click via the async API, falling back to the
// keyboard hint on webviews that don't allow programmatic clipboard reads.
byId<HTMLButtonElement>("i2i-paste").addEventListener("click", async () => {
  const read = navigator.clipboard?.read?.bind(navigator.clipboard);
  if (read) {
    try {
      let n = 0;
      for (const item of await read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          addRefFromBlob(await item.getType(type), `剪贴板图片.${imageExt(type)}`);
          n++;
        }
      }
      setStatus(
        "i2i-status",
        n > 0
          ? `已从剪贴板粘贴 ${n} 张参考图 ✓`
          : "剪贴板里没有图片；复制一张图后再点，或直接按 Ctrl/⌘+V。",
        n > 0 ? "ok" : "info",
      );
      return;
    } catch {
      /* not permitted in this webview — fall through to the hint */
    }
  }
  setStatus("i2i-status", "此环境不支持按钮读取剪贴板，请直接按 Ctrl/⌘+V 粘贴图片。", "info");
});

byId<HTMLButtonElement>("i2i-go").addEventListener("click", () => {
  if (refImgs.length === 0) return setStatus("i2i-status", "请先添加至少一张参考图。", "error");
  const prompt = byId<HTMLTextAreaElement>("i2i-prompt").value.trim();
  if (!prompt) return setStatus("i2i-status", "请输入提示词。", "error");
  if (!ensureConfigured("i2i-status")) return;
  const size = i2iSize();
  if (size === INVALID_SIZE) return setStatus("i2i-status", "自定义尺寸格式不对，应为「宽x高」，如 1024x1024。", "error");
  const model = byId<HTMLSelectElement>("i2i-model").value;
  settings = { ...settings, model, size: size ?? settings.size };
  saveSettings(settings);
  const count = readCount("i2i-count");
  const refs = refImgs.map((r) => r.value);
  const finalPrompt = appendSizeToPrompt(prompt, size);
  for (let i = 0; i < count; i++) enqueue("i2i", model, size, finalPrompt, refs);
  setStatus("i2i-status", submittedNote(count), "ok");
});

// ---------- 视频按帧预览 / 截图 ----------
const videoFileInput = byId<HTMLInputElement>("video-frame-file");
const videoPlayer = byId<HTMLVideoElement>("video-frame-player");
const videoSeek = byId<HTMLInputElement>("video-frame-seek");
const videoTime = byId<HTMLSpanElement>("video-frame-time");
const videoName = byId<HTMLSpanElement>("video-frame-name");
const videoEmpty = byId<HTMLDivElement>("video-frame-empty");
const videoPrev = byId<HTMLButtonElement>("video-frame-prev");
const videoNext = byId<HTMLButtonElement>("video-frame-next");
const videoCopy = byId<HTMLButtonElement>("video-frame-copy");
const videoDownload = byId<HTMLButtonElement>("video-frame-download");
const videoStep = byId<HTMLInputElement>("video-frame-step");
let videoObjectUrl = "";

function formatVideoTime(sec: number): string {
  if (!Number.isFinite(sec)) return "00:00.000";
  const mins = Math.floor(sec / 60);
  const seconds = sec - mins * 60;
  return `${String(mins).padStart(2, "0")}:${seconds.toFixed(3).padStart(6, "0")}`;
}
function updateVideoFrameUi(): void {
  const duration = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
  videoSeek.max = String(duration);
  videoSeek.value = String(videoPlayer.currentTime || 0);
  videoTime.textContent = `${formatVideoTime(videoPlayer.currentTime)} / ${formatVideoTime(duration)}`;
  const enabled = !!videoObjectUrl && duration > 0;
  videoSeek.disabled = !enabled;
  videoPrev.disabled = !enabled;
  videoNext.disabled = !enabled;
  videoCopy.disabled = !enabled;
  videoDownload.disabled = !enabled;
}
function seekVideo(delta: number): void {
  if (!videoObjectUrl) return;
  const step = Math.max(0.001, Number(videoStep.value) || 0.033);
  videoPlayer.currentTime = Math.max(0, Math.min(videoPlayer.duration || 0, videoPlayer.currentTime + delta * step));
}
function frameBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!videoPlayer.videoWidth || !videoPlayer.videoHeight) return reject(new Error("视频画面尚未加载完成"));
    const canvas = document.createElement("canvas");
    canvas.width = videoPlayer.videoWidth;
    canvas.height = videoPlayer.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return reject(new Error("无法创建画布"));
    ctx.drawImage(videoPlayer, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("截图生成失败")), "image/png");
  });
}
function frameFilename(): string {
  const base = (videoName.textContent || "video").replace(/\.[^.]+$/, "").replace(/[^\w\-\u4e00-\u9fff]+/g, "_");
  return `${base || "video"}-frame-${Math.round(videoPlayer.currentTime * 1000)}ms.png`;
}
videoFileInput.addEventListener("change", () => {
  const file = videoFileInput.files?.[0];
  if (!file) return;
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
  videoObjectUrl = URL.createObjectURL(file);
  videoPlayer.src = videoObjectUrl;
  videoPlayer.load();
  videoName.textContent = file.name;
  videoEmpty.classList.add("hidden");
  setStatus("video-frame-status", "视频已加载，正在读取时长…", "info");
  videoFileInput.value = "";
});
videoPlayer.addEventListener("loadedmetadata", () => { updateVideoFrameUi(); setStatus("video-frame-status", "可以按帧预览并截图。", "ok"); });
videoPlayer.addEventListener("timeupdate", updateVideoFrameUi);
videoSeek.addEventListener("input", () => { videoPlayer.currentTime = Number(videoSeek.value); updateVideoFrameUi(); });
videoPrev.addEventListener("click", () => seekVideo(-1));
videoNext.addEventListener("click", () => seekVideo(1));
videoCopy.addEventListener("click", async () => {
  try {
    const blob = await frameBlob();
    const ClipboardItemCtor = (window as any).ClipboardItem;
    if (!navigator.clipboard?.write || !ClipboardItemCtor) throw new Error("当前环境不支持图片剪贴板");
    await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
    setStatus("video-frame-status", "当前帧已复制到剪贴板 ✓", "ok");
  } catch (e) { setStatus("video-frame-status", `复制失败：${e instanceof Error ? e.message : String(e)}`, "error"); }
});
videoDownload.addEventListener("click", async () => {
  try {
    const blob = await frameBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = frameFilename(); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("video-frame-status", "截图已下载 ✓", "ok");
  } catch (e) { setStatus("video-frame-status", `下载失败：${e instanceof Error ? e.message : String(e)}`, "error"); }
});
