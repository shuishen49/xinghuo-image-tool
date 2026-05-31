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
}
interface RefImg {
  value: string; // http(s) URL or data: URI
  label: string;
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

function loadSettings(): Settings {
  const d: Settings = {
    baseUrl: DEFAULT_BASE,
    apiKey: "",
    model: MODELS[0].value,
    size: SIZES[0].value,
    timeoutSec: 300,
    accountTier: "",
    debugToken: "",
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      return {
        baseUrl: s.baseUrl ?? d.baseUrl,
        apiKey: s.apiKey ?? d.apiKey,
        model: s.model ?? d.model,
        size: s.size ?? d.size,
        timeoutSec: s.timeoutSec ?? d.timeoutSec,
        accountTier: s.accountTier ?? d.accountTier,
        debugToken: s.debugToken ?? d.debugToken,
      };
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
        <button class="primary" id="t2i-go">生成</button>
      </div>
      <div class="status" id="t2i-status"></div>
      <div class="results" id="t2i-results"></div>
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
          <input id="i2i-url" type="text" placeholder="或粘贴图片链接 https://…" />
          <button id="i2i-add-url">添加链接</button>
        </div>
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
        <button class="primary" id="i2i-go">生成</button>
      </div>
      <div class="status" id="i2i-status"></div>
      <div class="results" id="i2i-results"></div>
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
      <div class="row">
        <label class="field small-2">
          <span>等待超时（秒）</span>
          <input id="set-timeout" type="number" min="10" max="1800" />
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
        生成会消耗星火币，余额不足时接口会提示所需数量。
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

function renderResults(id: string, outs: ImageOut[]): void {
  const box = byId<HTMLDivElement>(id);
  box.innerHTML = "";
  for (const out of outs) {
    const dataUri = `data:${out.mime};base64,${out.b64}`;
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.src = dataUri;
    img.title = "点击在浏览器中打开原图";
    if (out.source_url) {
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

    box.appendChild(card);
  }
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

// ---------- settings wiring ----------
const baseInput = byId<HTMLInputElement>("set-base");
const keyInput = byId<HTMLInputElement>("set-key");
const timeoutInput = byId<HTMLInputElement>("set-timeout");
const tierSelect = byId<HTMLSelectElement>("set-tier");
const debugTokenInput = byId<HTMLInputElement>("set-debug-token");
baseInput.value = settings.baseUrl;
keyInput.value = settings.apiKey;
timeoutInput.value = String(settings.timeoutSec);
tierSelect.value = settings.accountTier;
debugTokenInput.value = settings.debugToken;

byId<HTMLButtonElement>("btn-save").addEventListener("click", () => {
  const t = parseInt(timeoutInput.value, 10);
  settings = {
    ...settings,
    baseUrl: baseInput.value.trim() || DEFAULT_BASE,
    apiKey: keyInput.value.trim(),
    timeoutSec: Number.isFinite(t) ? Math.min(1800, Math.max(10, t)) : 300,
    accountTier: tierSelect.value,
    debugToken: debugTokenInput.value.trim(),
  };
  timeoutInput.value = String(settings.timeoutSec);
  saveSettings(settings);
  setStatus("set-status", "已保存 ✓", "ok");
});

// ---------- shared generate ----------
interface GenArgs {
  prompt: string;
  model: string;
  size: string | null;
  image: string[];
}
async function generate(statusId: string, resultsId: string, btn: HTMLButtonElement, a: GenArgs) {
  // remember last-used model/size as defaults
  settings = { ...settings, model: a.model, size: a.size ?? settings.size };
  saveSettings(settings);

  btn.disabled = true;
  setStatus(statusId, `生成中，请稍候…（最长约 ${settings.timeoutSec} 秒）`, "busy");
  try {
    const outs = await invoke<ImageOut[]>("generate_images", {
      req: {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: a.model,
        prompt: a.prompt,
        size: a.size ?? undefined,
        image: a.image,
        timeoutSec: settings.timeoutSec,
        accountTier: settings.accountTier || undefined,
        debugToken: settings.debugToken || undefined,
      },
    });
    renderResults(resultsId, outs);
    setStatus(statusId, `完成，生成 ${outs.length} 张。`, "ok");
  } catch (err) {
    setStatus(statusId, String(err), "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------- 文生图 ----------
const t2iSize = wireSize("t2i");
byId<HTMLButtonElement>("t2i-go").addEventListener("click", () => {
  const prompt = byId<HTMLTextAreaElement>("t2i-prompt").value.trim();
  if (!prompt) return setStatus("t2i-status", "请输入提示词。", "error");
  if (!ensureConfigured("t2i-status")) return;
  const size = t2iSize();
  if (size === null) return setStatus("t2i-status", "自定义尺寸格式不对，应为「宽x高」，如 1024x1024。", "error");
  void generate("t2i-status", "t2i-results", byId<HTMLButtonElement>("t2i-go"), {
    prompt,
    model: byId<HTMLSelectElement>("t2i-model").value,
    size,
    image: [],
  });
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

byId<HTMLInputElement>("i2i-file").addEventListener("change", (ev) => {
  const files = (ev.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of Array.from(files)) {
    const reader = new FileReader();
    reader.onload = () => {
      refImgs.push({ value: String(reader.result), label: file.name });
      renderRefs();
    };
    reader.readAsDataURL(file);
  }
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

byId<HTMLButtonElement>("i2i-go").addEventListener("click", () => {
  if (refImgs.length === 0) return setStatus("i2i-status", "请先添加至少一张参考图。", "error");
  const prompt = byId<HTMLTextAreaElement>("i2i-prompt").value.trim();
  if (!prompt) return setStatus("i2i-status", "请输入提示词。", "error");
  if (!ensureConfigured("i2i-status")) return;
  const size = i2iSize();
  if (size === null) return setStatus("i2i-status", "自定义尺寸格式不对，应为「宽x高」，如 1024x1024。", "error");
  void generate("i2i-status", "i2i-results", byId<HTMLButtonElement>("i2i-go"), {
    prompt,
    model: byId<HTMLSelectElement>("i2i-model").value,
    size,
    image: refImgs.map((r) => r.value),
  });
});
