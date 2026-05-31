import "./style.css";
import { invoke } from "@tauri-apps/api/core";

// ---------- types ----------
interface ImageOut {
  b64: string;
  mime: string;
  saved_path: string;
}
interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ---------- settings persistence ----------
const STORE_KEY = "xinghuo_settings";
const DEFAULT_BASE = "https://uuerqapsftez.sealosgzg.site";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      return {
        baseUrl: s.baseUrl ?? DEFAULT_BASE,
        apiKey: s.apiKey ?? "",
        model: s.model ?? "",
      };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { baseUrl: DEFAULT_BASE, apiKey: "", model: "" };
}

function saveSettings(s: Settings): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}

let settings = loadSettings();

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
          <span>尺寸</span>
          <select id="t2i-size">
            <option value="">默认</option>
            <option value="1024x1024">1024 × 1024</option>
            <option value="512x512">512 × 512</option>
            <option value="256x256">256 × 256</option>
            <option value="1792x1024">1792 × 1024 (横)</option>
            <option value="1024x1792">1024 × 1792 (竖)</option>
          </select>
        </label>
        <label class="field small">
          <span>数量</span>
          <input id="t2i-n" type="number" min="1" max="4" value="1" />
        </label>
        <button class="primary" id="t2i-go">生成</button>
      </div>
      <div class="status" id="t2i-status"></div>
      <div class="results" id="t2i-results"></div>
    </section>

    <!-- 图生图 -->
    <section class="panel hidden" id="panel-i2i">
      <label class="field">
        <span>原图</span>
        <input id="i2i-file" type="file" accept="image/*" />
      </label>
      <img id="i2i-preview" class="preview hidden" alt="预览" />
      <label class="field">
        <span>修改要求 (Prompt)</span>
        <textarea id="i2i-prompt" rows="3" placeholder="例如：把背景换成雪山，整体改成水彩画风格"></textarea>
      </label>
      <div class="row">
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
        <span>API Key</span>
        <input id="set-key" type="password" placeholder="sk-..." />
      </label>
      <label class="field">
        <span>模型 (Model)</span>
        <input id="set-model" type="text" placeholder="先点右侧按钮拉取，或手动填写" />
      </label>
      <div class="row">
        <button id="btn-models">测试连接 / 拉取模型</button>
        <button class="primary" id="btn-save">保存设置</button>
      </div>
      <div class="status" id="set-status"></div>
      <div class="chips" id="models-list"></div>
      <p class="hint">生成的图片会自动保存到「图片 / Pictures」目录下的 <code>xinghuo-image-tool</code> 文件夹。设置仅保存在本机。</p>
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

function renderResults(id: string, outs: ImageOut[]): void {
  const box = byId<HTMLDivElement>(id);
  box.innerHTML = "";
  for (const out of outs) {
    const card = document.createElement("div");
    card.className = "card";
    const img = document.createElement("img");
    img.src = `data:${out.mime};base64,${out.b64}`;
    const path = document.createElement("div");
    path.className = "path";
    path.textContent = `已保存：${out.saved_path}`;
    card.appendChild(img);
    card.appendChild(path);
    box.appendChild(card);
  }
}

function ensureConfigured(statusId: string): boolean {
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    setStatus(statusId, "请先在「设置」里填写 Base URL、API Key 和模型。", "error");
    switchTab("settings");
    return false;
  }
  return true;
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
const modelInput = byId<HTMLInputElement>("set-model");
baseInput.value = settings.baseUrl;
keyInput.value = settings.apiKey;
modelInput.value = settings.model;

byId<HTMLButtonElement>("btn-save").addEventListener("click", () => {
  settings = {
    baseUrl: baseInput.value.trim() || DEFAULT_BASE,
    apiKey: keyInput.value.trim(),
    model: modelInput.value.trim(),
  };
  saveSettings(settings);
  setStatus("set-status", "已保存 ✓", "ok");
});

byId<HTMLButtonElement>("btn-models").addEventListener("click", async () => {
  const baseUrl = baseInput.value.trim() || DEFAULT_BASE;
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    setStatus("set-status", "请先填写 API Key。", "error");
    return;
  }
  setStatus("set-status", "正在连接…", "busy");
  try {
    const models = await invoke<string[]>("list_models", { req: { baseUrl, apiKey } });
    const list = byId<HTMLDivElement>("models-list");
    list.innerHTML = "";
    if (models.length === 0) {
      setStatus("set-status", "连接成功，但接口没有返回模型列表。可手动填写模型名。", "ok");
      return;
    }
    for (const m of models) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = m;
      chip.addEventListener("click", () => {
        modelInput.value = m;
      });
      list.appendChild(chip);
    }
    setStatus("set-status", `连接成功，共 ${models.length} 个模型。点一个填入上方。`, "ok");
  } catch (err) {
    setStatus("set-status", `失败：${String(err)}`, "error");
  }
});

// ---------- 文生图 ----------
byId<HTMLButtonElement>("t2i-go").addEventListener("click", async () => {
  const prompt = byId<HTMLTextAreaElement>("t2i-prompt").value.trim();
  if (!prompt) {
    setStatus("t2i-status", "请输入提示词。", "error");
    return;
  }
  if (!ensureConfigured("t2i-status")) return;

  const size = byId<HTMLSelectElement>("t2i-size").value;
  const n = parseInt(byId<HTMLInputElement>("t2i-n").value, 10) || 1;
  const btn = byId<HTMLButtonElement>("t2i-go");
  btn.disabled = true;
  setStatus("t2i-status", "生成中，请稍候…", "busy");
  try {
    const outs = await invoke<ImageOut[]>("generate_image", {
      req: { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, prompt, size, n },
    });
    renderResults("t2i-results", outs);
    setStatus("t2i-status", `完成，生成 ${outs.length} 张。`, "ok");
  } catch (err) {
    setStatus("t2i-status", `失败：${String(err)}`, "error");
  } finally {
    btn.disabled = false;
  }
});

// ---------- 图生图 ----------
let pickedImage = "";
byId<HTMLInputElement>("i2i-file").addEventListener("change", (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pickedImage = String(reader.result);
    const preview = byId<HTMLImageElement>("i2i-preview");
    preview.src = pickedImage;
    preview.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});

byId<HTMLButtonElement>("i2i-go").addEventListener("click", async () => {
  if (!pickedImage) {
    setStatus("i2i-status", "请先选择一张原图。", "error");
    return;
  }
  const prompt = byId<HTMLTextAreaElement>("i2i-prompt").value.trim();
  if (!prompt) {
    setStatus("i2i-status", "请输入修改要求。", "error");
    return;
  }
  if (!ensureConfigured("i2i-status")) return;

  const btn = byId<HTMLButtonElement>("i2i-go");
  btn.disabled = true;
  setStatus("i2i-status", "生成中，请稍候…", "busy");
  try {
    const outs = await invoke<ImageOut[]>("edit_image", {
      req: { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, prompt, image: pickedImage },
    });
    renderResults("i2i-results", outs);
    setStatus("i2i-status", `完成，生成 ${outs.length} 张。`, "ok");
  } catch (err) {
    setStatus("i2i-status", `失败：${String(err)}`, "error");
  } finally {
    btn.disabled = false;
  }
});
