import "./style.css";
import { invoke } from "@tauri-apps/api/core";

// ---------- types ----------
interface ImageOut {
  b64: string;
  mime: string;
  saved_path: string;
  source_url: string | null;
}
interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
  timeoutSec: number;
  accountTier: string;
  debugToken: string;
  maxConcurrent: number;
  uploadUrl: string;
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

// ---------- catalog (fixed by the API spec) ----------
const MODELS = [
  { value: "gpt-5-3", label: "GPT-Image（标准）" },
  { value: "gpt-5-4-thinking", label: "GPT-Image2（Plus 专属）" },
];
const SIZES = [
  { value: "1024x1024", label: "1024 × 1024（方形）" },
  { value: "1536x864", label: "1536 × 864（横版）" },
  { value: "864x1536", label: "864 × 1536（竖版）" },
];
const SIZE_PATTERN = /^[0-9]{2,5}x[0-9]{2,5}$/;

// ---------- settings persistence ----------
const STORE_KEY = "xinghuo_settings";
const DEFAULT_BASE = "https://uuerqapsftez.sealosgzg.site";
// Empty = use the platform's own OSS endpoint ({base}/api/v1/uploads/upload).
const DEFAULT_UPLOAD = "";

function loadSettings(): Settings {
  const d: Settings = {
    baseUrl: DEFAULT_BASE,
    apiKey: "",
    model: MODELS[0].value,
    size: SIZES[0].value,
    timeoutSec: 600,
    accountTier: "",
    debugToken: "",
    maxConcurrent: 3,
    uploadUrl: DEFAULT_UPLOAD,
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      const loaded: Settings = {
        baseUrl: s.baseUrl ?? d.baseUrl,
        apiKey: s.apiKey ?? d.apiKey,
        model: s.model ?? d.model,
        size: s.size ?? d.size,
        timeoutSec: s.timeoutSec ?? d.timeoutSec,
        accountTier: s.accountTier ?? d.accountTier,
        debugToken: s.debugToken ?? d.debugToken,
        maxConcurrent: s.maxConcurrent ?? d.maxConcurrent,
        uploadUrl: s.uploadUrl ?? d.uploadUrl,
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
  const known = SIZES.some((s) => s.value === selected);
  const std = SIZES.map(
    (s) =>
      `<option value="${s.value}" ${s.value === selected ? "selected" : ""}>${s.label}</option>`,
  ).join("");
  return `${std}<option value="__custom__" ${!known ? "selected" : ""}>自定义…</option>`;
}

// ---------- markup ----------
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="topbar">
    <div class="brand">🎨 星火图片工具</div>
    <nav class="tabs">
      <button class="tab" data-tab="t2i">文生图</button>
      <button class="tab" data-tab="i2i">图生图</button>
      <button class="tab" data-tab="tasks">任务<span id="task-badge" class="tab-badge hidden"></span></button>
      <button class="tab" data-tab="settings">设置</button>
    </nav>
  </header>

  <main>
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

    <!-- 任务 -->
    <section class="panel hidden" id="panel-tasks">
      <div class="tasks-bar">
        <div class="status" id="task-counts"></div>
        <button class="mini" id="btn-clear-done">清空已完成</button>
      </div>
      <div class="tasklist" id="task-list"></div>
    </section>

    <!-- 设置 -->
    <section class="panel hidden" id="panel-settings">
      <label class="field">
        <span>请求地址 (Base URL)</span>
        <input id="set-base" type="text" placeholder="${DEFAULT_BASE}" />
      </label>
      <label class="field">
        <span>API Key（Bearer Token）</span>
        <input id="set-key" type="password" placeholder="sk-..." />
      </label>
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
        <button class="primary" id="btn-save">保存设置</button>
      </div>
      <div class="status" id="set-status"></div>
      <p class="hint">
        生成的图片会自动保存到「图片 / Pictures」目录下的 <code>xinghuo-image-tool</code> 文件夹。设置仅保存在本机。<br />
        模型：<code>gpt-5-3</code> = GPT-Image（标准）；<code>gpt-5-4-thinking</code> = GPT-Image2（仅 Plus 账户可用）。<br />
        点「生成」会把任务加入队列并立刻返回，可连续提交；同时进行的数量由「最大同时任务数」控制，多出的会排队。
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

/** One result image as a card with preview + actions. */
function buildImageCard(out: ImageOut): HTMLDivElement {
  const dataUri = `data:${out.mime};base64,${out.b64}`;
  const card = document.createElement("div");
  card.className = "card";

  const img = document.createElement("img");
  img.src = dataUri;
  if (out.source_url) {
    img.title = "点击在浏览器中打开原图";
    img.style.cursor = "pointer";
    img.addEventListener("click", () => window.open(out.source_url!, "_blank"));
  }
  card.appendChild(img);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const dl = document.createElement("a");
  dl.className = "mini";
  dl.textContent = "另存为";
  dl.href = dataUri;
  dl.download = out.saved_path.split(/[\\/]/).pop() || "image.png";
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

function ensureConfigured(statusId: string): boolean {
  if (!settings.baseUrl || !settings.apiKey) {
    setStatus(statusId, "请先在「设置」里填写 Base URL 和 API Key。", "error");
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
    if (sel.value !== "__custom__") return sel.value;
    const v = custom.value.trim();
    if (!SIZE_PATTERN.test(v)) return null;
    return v;
  };
}

// ---------- tabs ----------
function switchTab(name: string): void {
  for (const t of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    t.classList.toggle("active", t.dataset.tab === name);
  }
  for (const p of document.querySelectorAll<HTMLElement>(".panel")) {
    p.classList.toggle("hidden", p.id !== `panel-${name}`);
  }
}
for (const t of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  t.addEventListener("click", () => switchTab(t.dataset.tab!));
}
switchTab("t2i");

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
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
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
  pump();
}

function removeTask(id: number): void {
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0 || tasks[i].status === "running") return;
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  tasks.splice(i, 1);
  renderTasks();
}

byId<HTMLButtonElement>("btn-clear-done").addEventListener("click", () => {
  tasks = tasks.filter((t) => t.status === "running" || t.status === "queued");
  renderTasks();
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

renderTasks();

// ---------- settings wiring ----------
const baseInput = byId<HTMLInputElement>("set-base");
const keyInput = byId<HTMLInputElement>("set-key");
const timeoutInput = byId<HTMLInputElement>("set-timeout");
const concurrencyInput = byId<HTMLInputElement>("set-concurrency");
const tierSelect = byId<HTMLSelectElement>("set-tier");
const debugTokenInput = byId<HTMLInputElement>("set-debug-token");
const uploadInput = byId<HTMLInputElement>("set-upload");
baseInput.value = settings.baseUrl;
keyInput.value = settings.apiKey;
timeoutInput.value = String(settings.timeoutSec);
concurrencyInput.value = String(settings.maxConcurrent);
tierSelect.value = settings.accountTier;
debugTokenInput.value = settings.debugToken;
uploadInput.value = settings.uploadUrl;

byId<HTMLButtonElement>("btn-save").addEventListener("click", () => {
  const t = parseInt(timeoutInput.value, 10);
  const c = parseInt(concurrencyInput.value, 10);
  settings = {
    ...settings,
    baseUrl: baseInput.value.trim() || DEFAULT_BASE,
    apiKey: keyInput.value.trim(),
    timeoutSec: Number.isFinite(t) ? Math.min(1800, Math.max(10, t)) : 600,
    maxConcurrent: Number.isFinite(c) ? Math.min(16, Math.max(1, c)) : 3,
    accountTier: tierSelect.value,
    debugToken: debugTokenInput.value.trim(),
    uploadUrl: uploadInput.value.trim() || DEFAULT_UPLOAD,
  };
  timeoutInput.value = String(settings.timeoutSec);
  concurrencyInput.value = String(settings.maxConcurrent);
  saveSettings(settings);
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
  if (size === null) return setStatus("t2i-status", "自定义尺寸格式不对，应为「宽x高」，如 1024x1024。", "error");
  const model = byId<HTMLSelectElement>("t2i-model").value;
  settings = { ...settings, model, size: size ?? settings.size };
  saveSettings(settings);
  const count = readCount("t2i-count");
  for (let i = 0; i < count; i++) enqueue("t2i", model, size, prompt, []);
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
  if (size === null) return setStatus("i2i-status", "自定义尺寸格式不对，应为「宽x高」，如 1024x1024。", "error");
  const model = byId<HTMLSelectElement>("i2i-model").value;
  settings = { ...settings, model, size: size ?? settings.size };
  saveSettings(settings);
  const count = readCount("i2i-count");
  const refs = refImgs.map((r) => r.value);
  for (let i = 0; i < count; i++) enqueue("i2i", model, size, prompt, refs);
  setStatus("i2i-status", submittedNote(count), "ok");
});
