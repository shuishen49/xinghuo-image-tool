const STRICT_RULE = '分镜图，必须9:16竖版。严格遵循 script 内的当前段场景地点、时间、动作与情绪，不得替换成其他地点。人物必须与参考图一致且必须出镜，画面要体现人物关系与动作叙事。禁止纯人物立绘、禁止白底棚拍、禁止与 script 冲突的背景。镜头语言电影写实，构图清晰，叙事明确。 Framing constraint: output composition must strictly use 9:16 (vertical portrait). Do not use any aspect ratio other than 9:16. Do not produce square framing.';
const VIDEO_STYLE_RULE = '黑白线条为主的 meme 漫画风 / 萌系手绘表情包风，少量青蓝点缀，夸张表情，清晰动作节奏，统一角色画风与镜头风格。';

let currentLightboxUrl = '';
let currentLightboxList = [];
let currentLightboxIndex = 0;
let currentVideoUrl = '';

const CHAT_STORAGE_KEY = 'grok_storyboard_chat_history_v1';
const CHAT_CONFIG_KEY = 'grok_storyboard_chat_config_v2';
const DEFAULT_CHAT_PATH = '/v1/chat/completions';
const STORY_OUTLINE_DRAFT_KEY = 'grok_storyboard_story_outline_draft_v1';
const PROJECT_CHARACTERS_DRAFT_KEY = 'grok_storyboard_project_characters_draft_v1';
const PROJECT_CHARACTER_IMAGE_OVERRIDES_KEY = 'grok_storyboard_project_character_images_v1';
const PROJECT_INDEX_STORAGE_KEY = 'grok_storyboard_project_index_v1';
const CHARACTER_LIBRARY_STORAGE_KEY = 'grok_storyboard_global_character_library_v1';
const PROJECT_CHARACTER_OVERRIDE_KEY = 'grok_storyboard_project_character_overrides_v1';
const DEFAULT_PROJECT_FALLBACK = 'episode-1-20260320-113900';
let currentProjectName = '';
let currentProjectCharacters = [];
let globalCharacterLibrary = [];
let renderedGlobalCharacters = [];
let selectedGlobalCharacterKeys = new Set();
let characterPickerCandidates = [];
let pendingCharacterChanges = [];
let pendingCharacterPlan = [];
let chatHistory = [];
let chatSending = false;
let editMode = 'outline'; // outline | character

function q(id){ return document.getElementById(id); }
function setStatus(text, ok=true){ q('status').textContent=text; q('status').className = ok ? 'meta ok' : 'meta err'; }
function getProject(){ return (q('projectInput').value || q('projectSelect').value || '').trim(); }

function escapeHtml(str=''){
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseInlineMarkdown(text=''){
  let html = escapeHtml(String(text || ''));
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return html;
}

function sanitizeRenderedMarkdown(html=''){
  const wrap = document.createElement('div');
  wrap.innerHTML = String(html || '');
  wrap.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(n => n.remove());
  wrap.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      const name = String(attr.name || '').toLowerCase();
      const value = String(attr.value || '');
      if(name.startsWith('on')){
        el.removeAttribute(attr.name);
        return;
      }
      if((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)){
        el.removeAttribute(attr.name);
        return;
      }
      if(name === 'target'){
        el.setAttribute('target', '_blank');
        if(!el.getAttribute('rel')) el.setAttribute('rel', 'noopener noreferrer');
      }
    });
  });
  return wrap.innerHTML;
}

function markdownToHtml(md=''){
  const src = String(md || '').replace(/\r\n/g, '\n');

  if(window.marked && typeof window.marked.parse === 'function'){
    try {
      if(typeof window.marked.setOptions === 'function'){
        window.marked.setOptions({ gfm: true, breaks: true, mangle: false, headerIds: false });
      }
      const rendered = window.marked.parse(src);
      return sanitizeRenderedMarkdown(rendered);
    } catch {}
  }

  const lines = src.split('\n');
  const out = [];
  let inCode = false;
  let code = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if(inUl){ out.push('</ul>'); inUl = false; }
    if(inOl){ out.push('</ol>'); inOl = false; }
  };

  for(const raw of lines){
    const line = String(raw || '');

    if(/^```/.test(line.trim())){
      closeLists();
      if(!inCode){ inCode = true; code = []; }
      else { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); inCode = false; code = []; }
      continue;
    }

    if(inCode){ code.push(line); continue; }

    if(/^\s*---\s*$/.test(line) || /^\s*\*\*\*\s*$/.test(line)){
      closeLists();
      out.push('<hr>');
      continue;
    }

    const h = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if(h){
      closeLists();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${parseInlineMarkdown(h[2])}</h${lvl}>`);
      continue;
    }

    const bq = line.match(/^\s*>\s?(.*)$/);
    if(bq){ closeLists(); out.push(`<blockquote>${parseInlineMarkdown(bq[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if(ul){ if(inOl){ out.push('</ol>'); inOl = false; } if(!inUl){ out.push('<ul>'); inUl = true; } out.push(`<li>${parseInlineMarkdown(ul[1])}</li>`); continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if(ol){ if(inUl){ out.push('</ul>'); inUl = false; } if(!inOl){ out.push('<ol>'); inOl = true; } out.push(`<li>${parseInlineMarkdown(ol[1])}</li>`); continue; }

    if(!line.trim()){ closeLists(); continue; }

    closeLists();
    out.push(`<p>${parseInlineMarkdown(line)}</p>`);
  }

  if(inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  closeLists();
  return out.join('');
}

function saveChat(){
  try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory)); } catch {}
}

function getQueryParam(name){
  try { return new URLSearchParams(location.search).get(name) || ''; } catch { return ''; }
}

function getDefaultChatBase(){
  return 'http://127.0.0.1:12732';
}

function isLikelyNotFoundError(message=''){
  const msg = String(message || '').toLowerCase();
  return msg.includes('not found') || msg.includes('404') || msg.includes('not_found');
}

function isLikelyServiceUnavailable(message=''){
  const msg = String(message || '').toLowerCase();
  return msg.includes('503') || msg.includes('service temporarily unavailable') || msg.includes('service unavailable');
}

function normalizeBaseUrl(url=''){
  return String(url || '').trim().replace(/\^/g, '').replace(/\/$/, '');
}

function normalizeApiPath(path=''){
  const v = String(path || '').trim().replace(/\^/g, '');
  if(!v) return DEFAULT_CHAT_PATH;
  if(/^https?:\/\//i.test(v)) return v;
  return v.startsWith('/') ? v : `/${v}`;
}

function getChatConfig(){
  let stored = {};
  try {
    const raw = localStorage.getItem(CHAT_CONFIG_KEY);
    stored = raw ? JSON.parse(raw) : {};
  } catch {}
  const base = getQueryParam('chatBase') || stored.base || getDefaultChatBase();
  const path = getQueryParam('chatPath') || stored.path || DEFAULT_CHAT_PATH;
  const model = getQueryParam('chatModel') || stored.model || '';
  const apiKey = getQueryParam('chatKey') || stored.apiKey || '';

  const normalizedBase = normalizeBaseUrl(base);
  const normalizedPath = normalizeApiPath(path);
  let normalizedModel = String(model || '').trim() || 'custom-154-12-46-107/gpt-5.4';

  // 历史默认值兼容：本地 bridge 默认模型自动切到稳定可用模型
  if (
    ['lobster-chat', 'openclaw/default', 'openclaw', 'openclaw/main'].includes(normalizedModel.toLowerCase()) &&
    normalizedBase === getDefaultChatBase() &&
    normalizedPath === DEFAULT_CHAT_PATH
  ) {
    normalizedModel = 'custom-154-12-46-107/gpt-5.4';
  }

  return {
    base: normalizedBase,
    path: normalizedPath,
    model: normalizedModel,
    apiKey: String(apiKey || '').trim(),
  };
}

function saveChatConfig(){
  const cfg = {
    base: normalizeBaseUrl(q('chatApiBase')?.value || ''),
    path: normalizeApiPath(q('chatApiPath')?.value || ''),
    model: String(q('chatModel')?.value || '').trim(),
    apiKey: String(q('chatApiKey')?.value || '').trim(),
  };
  try { localStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify(cfg)); } catch {}
  fillChatConfigUi();
  setChatStatus('聊天接口配置已保存。', true);
}

function resetChatConfig(){
  try { localStorage.removeItem(CHAT_CONFIG_KEY); } catch {}
  fillChatConfigUi();
  setChatStatus('已恢复默认配置。', true);
}

function fillChatConfigUi(){
  const cfg = getChatConfig();
  if(q('chatApiBase')) q('chatApiBase').value = cfg.base;
  if(q('chatApiPath')) q('chatApiPath').value = cfg.path;
  if(q('chatModel')) q('chatModel').value = cfg.model;
  if(q('chatApiKey')) q('chatApiKey').value = cfg.apiKey;
}

function setChatStatus(text='', ok=null){
  const el = q('chatStatus');
  if(!el) return;
  el.textContent = text;
  el.className = 'chat-status' + (ok === true ? ' ok' : ok === false ? ' err' : '');
}

function refreshEditModeUi(){
  const title = q('chatPanelTitle');
  const sub = q('chatPanelSub');
  const input = q('chatInput');
  const btn = q('chatSendBtn');

  if(editMode === 'character'){
    if(title) title.textContent = '角色修改助手（已接本地 bridge）';
    if(sub) sub.textContent = '这里专门用于“修改角色设定”。你提要求，我来给出角色修改结果，并同步到角色编辑区。';
    if(input) input.placeholder = '输入角色修改要求，按 Enter 提交（Shift+Enter 换行）';
    if(btn && !chatSending) btn.textContent = '修改角色';
    return;
  }

  if(title) title.textContent = '大纲修改助手（已接本地 bridge）';
  if(sub) sub.textContent = '这里专门用于“修改故事大纲”。你提要求，我来改左侧大纲并自动写入。';
  if(input) input.placeholder = '输入大纲修改要求，按 Enter 提交（Shift+Enter 换行）';
  if(btn && !chatSending) btn.textContent = '修改大纲';
}

function switchToOutlineMode(){
  editMode = 'outline';
  refreshEditModeUi();
  setStatus('已切换到：修改大纲');
}

function switchToCharacterMode(){
  editMode = 'character';
  refreshEditModeUi();
  setStatus('已切换到：修改角色');
  openAddGlobalCharacterMenu();
}

function analyzeCharactersFromOutline(){
  const outline = String(q('storyOutline')?.value || '').trim();
  if(!outline){
    setStatus('当前故事大纲为空，先补充大纲再分析角色', false);
    return;
  }
  switchToCharacterMode();
  const input = q('chatInput');
  if(!input || chatSending) return;
  input.value = '请基于当前故事大纲，先分析并确认角色数量与角色名单（只做第一步，输出 step=plan）。';
  sendChat();
}

function setChatSendingState(sending){
  chatSending = !!sending;
  const btn = q('chatSendBtn');
  const input = q('chatInput');
  if(btn){
    btn.disabled = chatSending;
    if(chatSending){
      btn.textContent = '修改中…';
    } else {
      btn.textContent = editMode === 'character' ? '修改角色' : '修改大纲';
    }
  }
  if(input) input.disabled = chatSending;
}


function buildChatApiUrl(){
  const cfg = getChatConfig();
  if(/^https?:\/\//i.test(cfg.path)) return cfg.path;
  return `${cfg.base || getDefaultChatBase()}${cfg.path}`;
}

function buildChatMessages(userText){
  const project = getProject() || '未选择项目';
  const currentOutline = String(q('storyOutline')?.value || '').trim() || '（当前为空）';
  const currentChars = (Array.isArray(currentProjectCharacters) ? currentProjectCharacters : []).map(ch => ({
    id: ch.id || '',
    name: ch.name || '',
    role: ch.role || '',
    imageUrl: ch.imageUrl || '',
    prompt: ch.prompt || '',
    designNotes: ch.designNotes || '',
    status: ch.status || 'active',
  }));
  const history = chatHistory.slice(-12).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.text || ''),
  }));

  const systemContent = editMode === 'character'
    ? [
        '你是角色修改助手。',
        `当前项目：${project}。`,
        '采用“两阶段流程”：先确认角色清单，再生成每个角色的提示词。',
        '必须只输出一个 JSON 代码块，不要输出任何额外解释。',
        'JSON 格式固定为：',
        '{"step":"plan|apply","message":"","roles":[{"name":"","role":""}],"characters":[{"id":"","name":"","role":"","imageUrl":"","prompt":"","designNotes":"","status":"active"}]}',
        '规则：',
        '1) 若用户还在讨论“角色数量/角色名单”，输出 step=plan，只填 roles，不填 characters。',
        '2) 只有当用户明确确认“按这些角色生成/写入提示词”时，输出 step=apply，并完整填充 characters。',
        '3) characters 每项必须包含 name、role、prompt、designNotes。',
        '4) 若是更新已有角色，name 必须与已有角色同名用于覆盖。',
        '当前角色JSON如下：',
        JSON.stringify({ characters: currentChars }, null, 2),
      ].join('\n')
    : [
        '你是故事大纲修改助手。',
        `当前项目：${project}。`,
        '你只做一件事：根据用户要求修改“故事大纲”。不要聊无关话题。',
        '每次都必须输出完整新大纲，并包含以下结构化区块（用于自动写回左侧）：',
        '[OUTLINE_UPDATE]',
        '这里放完整新大纲正文（纯文本，可分行）',
        '[/OUTLINE_UPDATE]',
        '区块外可补充 1-2 句简短说明。',
        '当前左侧故事大纲如下：',
        currentOutline,
      ].join('\n');

  return [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: String(userText || '').trim() }
  ];
}

function detectOutlineEditIntent(text=''){
  const t = String(text || '').trim();
  if(!t) return false;
  return /(修改|重写|优化|调整|改写|补充|完善).{0,8}(故事大纲|大纲)|(故事大纲|大纲).{0,8}(修改|重写|优化|调整|改写|补充|完善)/.test(t);
}

function splitReplyForOutline(replyText='', outlineIntent=false){
  const raw = String(replyText || '').trim();
  if(!raw) return { chatText: '', outlineText: '' };

  const m = raw.match(/\[OUTLINE_UPDATE\]([\s\S]*?)\[\/OUTLINE_UPDATE\]/i);
  if(m){
    const outlineText = String(m[1] || '').trim();
    const chatText = raw.replace(m[0], '').trim() || '已根据你的要求生成并更新故事大纲。';
    return { chatText, outlineText };
  }

  if(outlineIntent && raw.length >= 20){
    return {
      chatText: '已按你的要求改写故事大纲（已同步到左侧）。',
      outlineText: raw,
    };
  }

  return { chatText: raw, outlineText: '' };
}

function parseCharactersFromJsonText(text=''){
  const raw = String(text || '').trim();
  if(!raw) return [];

  const codeJson = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate = codeJson ? String(codeJson[1] || '').trim() : raw;

  let parsed = null;
  try { parsed = JSON.parse(candidate); } catch {
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if(objMatch){
      try { parsed = JSON.parse(objMatch[0]); } catch {}
    }
  }

  const arr = Array.isArray(parsed?.characters) ? parsed.characters : [];
  return arr.map((it, idx) => ({
    id: String(it.id || `char-${Date.now()}-${idx+1}`).trim(),
    name: String(it.name || '').trim(),
    role: String(it.role || '未设定').trim(),
    imageUrl: String(it.imageUrl || '').trim(),
    prompt: String(it.prompt || '').trim(),
    designNotes: String(it.designNotes || '').trim(),
    status: String(it.status || 'active').trim() || 'active',
  })).filter(ch => ch.name && ch.designNotes);
}

function splitReplyForCharacter(replyText=''){
  const raw = String(replyText || '').trim();
  if(!raw) return { step: 'plan', chatText: '', roles: [], characters: [] };

  let parsed = null;
  try {
    const m = raw.match(/```json\s*([\s\S]*?)```/i);
    parsed = JSON.parse(m ? m[1] : raw);
  } catch {
    const obj = raw.match(/\{[\s\S]*\}/);
    if(obj){
      try { parsed = JSON.parse(obj[0]); } catch {}
    }
  }

  if(parsed && typeof parsed === 'object'){
    const step = String(parsed.step || '').trim().toLowerCase() === 'apply' ? 'apply' : 'plan';
    const roles = Array.isArray(parsed.roles)
      ? parsed.roles.map(r => ({
          name: String(r?.name || '').trim(),
          role: String(r?.role || '').trim(),
        })).filter(r => r.name)
      : [];

    const chars = Array.isArray(parsed.characters)
      ? parseCharactersFromJsonText(JSON.stringify({ characters: parsed.characters }))
      : [];

    const msg = String(parsed.message || '').trim();
    return {
      step,
      chatText: msg || (step === 'apply' ? '已生成角色 JSON，待你确认写入。' : '已生成角色清单，请先确认角色数量与名单。'),
      roles,
      characters: chars,
    };
  }

  const chars = parseCharactersFromJsonText(raw);
  if(chars.length){
    return { step: 'apply', chatText: '已生成角色 JSON，待你确认写入。', roles: [], characters: chars };
  }

  return { step: 'plan', chatText: raw, roles: [], characters: [] };
}

function formatRolePlanText(roles = []){
  const arr = Array.isArray(roles) ? roles : [];
  if(!arr.length) return '已生成角色清单，请确认角色数量与名单。';
  const lines = arr.map((r, i) => `${i+1}. ${r.name}${r.role ? `（${r.role}）` : ''}`);
  return ['角色清单（请先确认）：', ...lines, '请回复：确认角色，并生成每个角色提示词。'].join('\n');
}

function buildCharacterChangePreview(nextChars = []){
  const existing = Array.isArray(currentProjectCharacters) ? currentProjectCharacters : [];
  const findExisting = (ch) => {
    const nameKey = normalizeCharacterNameKey(ch.name || ch.id);
    return existing.find(x => normalizeCharacterNameKey(x.name || x.id) === nameKey);
  };

  return (nextChars || []).map((ch, idx) => {
    const old = findExisting(ch);
    return {
      index: idx,
      action: old ? 'overwrite' : 'add',
      old,
      next: ch,
    };
  });
}

function renderCharacterApplyPreview(items = []){
  const listEl = q('characterApplyList');
  const subEl = q('characterApplySub');
  const countEl = q('characterApplyCount');
  if(!listEl) return;

  const addCount = items.filter(x => x.action === 'add').length;
  const overwriteCount = items.filter(x => x.action === 'overwrite').length;
  if(subEl) subEl.textContent = `将新增 ${addCount} 个，覆盖 ${overwriteCount} 个角色。`;
  if(countEl) countEl.textContent = `共 ${items.length} 项`;

  listEl.innerHTML = items.map(it => {
    const ch = it.next || {};
    const actionText = it.action === 'overwrite' ? '覆盖' : '新增';
    const actionClass = it.action === 'overwrite' ? 'overwrite' : 'add';
    const safeName = escapeHtml(ch.name || ch.id || `角色${it.index + 1}`);
    const safeRole = escapeHtml(ch.role || '未设定');
    const oldName = escapeHtml(it.old?.name || it.old?.id || '无');
    const note = String(ch.designNotes || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    return `
      <div class="character-apply-item">
        <div class="character-apply-item-top">
          <div class="character-apply-name">${safeName}</div>
          <div class="character-apply-action ${actionClass}">${actionText}</div>
        </div>
        <div class="character-apply-meta">角色类型：${safeRole}</div>
        ${it.action === 'overwrite' ? `<div class="character-apply-meta">将覆盖现有角色：${oldName}</div>` : ''}
        ${note ? `<div class="character-apply-meta">设定摘要：${escapeHtml(note)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function openCharacterApplyPreview(items = []){
  pendingCharacterChanges = Array.isArray(items) ? items : [];
  renderCharacterApplyPreview(pendingCharacterChanges);
  q('characterApplyModal')?.classList.add('show');
}

function closeCharacterApplyPreview(event, force=false){
  if(force || event?.target?.id === 'characterApplyModal'){
    q('characterApplyModal')?.classList.remove('show');
  }
}

function applyCharacterPreviewChanges(){
  const project = currentProjectName || getProject();
  if(!pendingCharacterChanges.length){
    closeCharacterApplyPreview(null, true);
    return;
  }

  const existing = Array.isArray(currentProjectCharacters) ? currentProjectCharacters.slice() : [];
  for(const item of pendingCharacterChanges){
    const ch = item.next;
    const key = normalizeCharacterNameKey(ch.name || ch.id);
    const idx = existing.findIndex(x => normalizeCharacterNameKey(x.name || x.id) === key);
    if(idx >= 0) existing[idx] = { ...existing[idx], ...ch };
    else existing.push(ch);
  }

  currentProjectCharacters = normalizeCharacters({ characters: existing }, 'project', project);
  saveProjectCharactersDraft(project, currentProjectCharacters);
  renderCharacters(currentProjectCharacters, project);
  closeCharacterApplyPreview(null, true);
  setChatStatus(`角色写入成功：已应用 ${pendingCharacterChanges.length} 项。`, true);
  pendingCharacterChanges = [];
}

function normalizeAssistantContent(content){
  if(typeof content === 'string') return content;
  if(Array.isArray(content)){
    return content.map(part => {
      if(typeof part === 'string') return part;
      if(!part || typeof part !== 'object') return '';
      return String(part.text || part.content || part.output_text || '').trim();
    }).filter(Boolean).join('\n\n');
  }
  if(content && typeof content === 'object'){
    return String(content.text || content.content || content.output_text || '').trim();
  }
  return '';
}

async function doChatRequest(url, body, headers){
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawText = await resp.text();
  let data = null;
  try { data = rawText ? JSON.parse(rawText) : null; } catch {}
  if(!resp.ok){
    const detail = data?.error?.message || data?.message || rawText || `HTTP ${resp.status}`;
    throw new Error(detail);
  }

  const c0 = data?.choices?.[0]?.message?.content;
  const c1 = data?.choices?.[0]?.delta?.content;
  const c2 = data?.output?.[0]?.content;
  const c3 = data?.output_text;
  const c4 = data?.data?.text;
  const c5 = data?.message;

  const text =
    normalizeAssistantContent(c0) ||
    normalizeAssistantContent(c1) ||
    normalizeAssistantContent(c2) ||
    normalizeAssistantContent(c3) ||
    normalizeAssistantContent(c4) ||
    normalizeAssistantContent(c5) ||
    String(rawText || '').trim();

  const out = String(text || '').trim();
  if(isLikelyServiceUnavailable(out)){
    throw new Error(out);
  }
  return out;
}

async function requestChatCompletion(userText){
  const cfg = getChatConfig();
  const primaryUrl = buildChatApiUrl();
  if(!primaryUrl) throw new Error('未找到聊天接口 URL。');
  const body = {
    model: cfg.model || 'custom-154-12-46-107/gpt-5.4',
    messages: buildChatMessages(userText),
    temperature: 0.7,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  if(cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  try {
    return await doChatRequest(primaryUrl, body, headers);
  } catch (err) {
    const base = normalizeBaseUrl(cfg.base || getDefaultChatBase());
    const currentPath = normalizeApiPath(cfg.path || DEFAULT_CHAT_PATH);
    const isDefaultBase = base === getDefaultChatBase();
    const hasAbsolutePath = /^https?:\/\//i.test(currentPath);
    const errMsg = String(err?.message || '');

    // 兜底1：本地 bridge 默认模型不可用时，自动切到稳定 provider/model
    if (isDefaultBase && isLikelyServiceUnavailable(errMsg)) {
      const stableModel = 'custom-154-12-46-107/gpt-5.4';
      const reply = await doChatRequest(primaryUrl, { ...body, model: stableModel }, headers);
      try {
        const nextCfg = { ...cfg, model: stableModel };
        localStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify(nextCfg));
        fillChatConfigUi();
      } catch {}
      setChatStatus(`检测到默认模型不可用，已自动切到 ${stableModel}`, true);
      return reply;
    }

    // 兜底2：路径错误自动回退到默认路径
    const needFallback = isDefaultBase && !hasAbsolutePath && currentPath !== DEFAULT_CHAT_PATH && isLikelyNotFoundError(errMsg);
    if(!needFallback) throw err;

    const fallbackUrl = `${base}${DEFAULT_CHAT_PATH}`;
    const reply = await doChatRequest(fallbackUrl, body, headers);
    try {
      const nextCfg = { ...cfg, path: DEFAULT_CHAT_PATH };
      localStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify(nextCfg));
      fillChatConfigUi();
    } catch {}
    setChatStatus(`检测到聊天路径无效，已自动切回默认 ${DEFAULT_CHAT_PATH}`, true);
    return reply;
  }
}

async function testChatConfig(){
  try {
    setChatStatus('正在测试连接…');
    const reply = await requestChatCompletion('请只回复：连接正常');
    setChatStatus(`连接成功：${reply || '已返回空文本'}`, true);
  } catch (err) {
    setChatStatus(`连接失败：${err?.message || err}`, false);
  }
}

function updateProjectCharacterFields(seed = {}, patch = {}){
  const project = currentProjectName || getProject();
  const nameKey = normalizeCharacterNameKey(seed?.name || '');
  if(!project || !nameKey) return;

  const list = Array.isArray(currentProjectCharacters) ? currentProjectCharacters.slice() : [];
  const idx = list.findIndex(ch => normalizeCharacterNameKey(ch?.name || ch?.id) === nameKey);
  if(idx >= 0){
    list[idx] = { ...list[idx], ...patch };
  }
  currentProjectCharacters = list;

  if(Object.prototype.hasOwnProperty.call(patch || {}, 'imageUrl')){
    setProjectCharacterImageOverride(project, seed?.name || seed?.id || '', String(patch?.imageUrl || ''));
  }

  saveProjectCharactersDraft(project, currentProjectCharacters);
}

async function requestThreeViewImageFromBridge(seed = {}){
  const cfg = getChatConfig();
  const bridgeBase = normalizeBaseUrl(cfg.base || getDefaultChatBase()) || getDefaultChatBase();
  const url = `${bridgeBase}/api/character/threeview`;
  const body = {
    characterName: String(seed?.name || '角色').trim(),
    role: String(seed?.role || '').trim(),
    designNotes: String(seed?.designNotes || '').trim(),
    prompt: String(seed?.prompt || '').trim(),
    size: '9:16',
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rawText = await resp.text();
  let data = null;
  try { data = rawText ? JSON.parse(rawText) : null; } catch {}
  if(!resp.ok){
    const detail = data?.error?.message || data?.error?.type || data?.message || rawText || `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  return data || {};
}

async function generateThreeViewPromptForCard(btn, payloadEnc){
  if(chatSending) return;
  let seed = {};
  try { seed = JSON.parse(decodeURIComponent(String(payloadEnc || ''))); } catch {}

  const card = btn?.closest?.('.character-card');
  if(!card){
    setStatus('未找到角色卡片', false);
    return;
  }

  const textarea = card.querySelector('.character-prompt textarea');
  if(!textarea){
    setStatus('未找到角色提示词输入框', false);
    return;
  }

  const mergedSeed = { ...seed, prompt: String(textarea.value || seed?.prompt || '') };
  const oldBtnText = btn.textContent;

  try {
    btn.disabled = true;
    btn.textContent = '生成中…';
    setChatStatus('正在通过 linggan 脚本生成角色三视图…');
    const result = await requestThreeViewImageFromBridge(mergedSeed);

    const imageUrl = String(result?.imageUrl || '').trim();
    if(!imageUrl){
      throw new Error('接口已返回，但未拿到图片链接（请检查 linggan 服务返回结构）');
    }

    updateProjectCharacterFields(mergedSeed, {
      imageUrl,
      prompt: String(mergedSeed.prompt || ''),
    });
    renderCharacters(currentProjectCharacters, currentProjectName || getProject());
    setStatus(`已为角色「${seed?.name || '未命名'}」生成三视图并回填图片`);
    setChatStatus('角色三视图生成成功。', true);
  } catch (err) {
    setChatStatus(`生成三视图失败：${err?.message || err}`, false);
  } finally {
    btn.disabled = false;
    btn.textContent = oldBtnText || '生成3视图';
  }
}

function loadChat(){
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    chatHistory = Array.isArray(arr) ? arr.slice(-200) : [];
  } catch {
    chatHistory = [];
  }
}

function renderChat(){
  const box = q('chatMessages');
  if(!box) return;
  if(!chatHistory.length){
    box.innerHTML = '<div class="msg bot"><div class="md-content"><p>已就绪。现在不是假回复了，点发送会真的请求聊天接口。</p></div></div>';
    return;
  }
  box.innerHTML = chatHistory.map(m => {
    const isUser = m.role === 'user';
    const body = isUser ? escapeHtml(m.text) : markdownToHtml(m.text);
    return `<div class="msg ${isUser ? 'user' : 'bot'}">${isUser ? body : `<div class="md-content">${body}</div>`}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function addChat(role, text){
  const t = String(text || '').trim();
  if(!t) return;
  chatHistory.push({ role, text: t, ts: Date.now() });
  if(chatHistory.length > 200) chatHistory = chatHistory.slice(-200);
  saveChat();
  renderChat();
}

async function sendChat(){
  const input = q('chatInput');
  if(!input || chatSending) return;
  const text = input.value.trim();
  if(!text) return;
  addChat('user', text);
  input.value = '';
  setChatSendingState(true);
  setChatStatus(editMode === 'character' ? '正在生成角色修改建议…' : '正在生成修改后的大纲…');
  try {
    const reply = await requestChatCompletion(text);
    const replyText = reply || '接口返回空内容。';

    if(editMode === 'character'){
      const parsed = splitReplyForCharacter(replyText);

      if(parsed.step === 'plan'){
        pendingCharacterPlan = Array.isArray(parsed.roles) ? parsed.roles : [];
        renderCharacters(currentProjectCharacters, currentProjectName || getProject());
        setChatStatus('已生成角色清单，请在左侧角色区确认后再生成提示词。', true);
      } else {
        addChat('bot', parsed.chatText || replyText);
        if(parsed.characters.length){
          const project = currentProjectName || getProject();
          const normalizedNext = normalizeCharacters({ characters: parsed.characters }, 'project', project);
          const preview = buildCharacterChangePreview(normalizedNext);
          if(preview.length){
            openCharacterApplyPreview(preview);
            setChatStatus(`已生成角色写入预览：${preview.length} 项，请确认后应用。`, true);
          } else {
            setChatStatus('角色修改建议已生成（未识别到可写入角色结构）。', false);
          }
        } else {
          setChatStatus('角色修改建议已生成（未识别到可写入角色结构）。', false);
        }
      }
    } else {
      const parsed = splitReplyForOutline(replyText, true);
      addChat('bot', parsed.chatText || replyText);
      if(parsed.outlineText){
        const ok = writeLastBotToOutline('replace', parsed.outlineText);
        if(ok) setChatStatus('修改成功，左侧故事大纲已更新。', true);
        else setChatStatus('修改完成，但写入失败。', false);
      } else {
        setChatStatus('修改完成，但未解析到大纲内容。', false);
      }
    }
  } catch (err) {
    const msg = `${editMode === 'character' ? '角色修改' : '大纲修改'}失败：${err?.message || err}`;
    addChat('bot', msg);
    setChatStatus(msg, false);
  } finally {
    setChatSendingState(false);
    input.focus();
  }
}

function clearChat(){
  chatHistory = [];
  saveChat();
  renderChat();
}

function getLastBotMessageText(){
  for(let i = chatHistory.length - 1; i >= 0; i--){
    const item = chatHistory[i];
    if(item && item.role === 'bot'){
      const t = String(item.text || '').trim();
      if(t) return t;
    }
  }
  return '';
}

function writeLastBotToOutline(mode = 'append', textOverride = ''){
  const box = q('storyOutline');
  if(!box){
    setStatus('未找到故事大纲输入框', false);
    return false;
  }

  const botText = String(textOverride || '').trim() || getLastBotMessageText();
  if(!botText){
    setStatus('暂无可写入的大纲内容（请先让右侧聊天产出回复）', false);
    return false;
  }

  const clean = String(botText || '').trim();
  if(!clean){
    setStatus('聊天回复为空，无法写入大纲', false);
    return false;
  }

  const p = latestOutlineProject || getProject();

  if(mode === 'replace'){
    box.value = clean;
    saveStoryOutlineDraft(p, box.value || '');
    setStatus('已用右侧聊天最新回复覆盖故事大纲');
    return true;
  }

  const old = String(box.value || '').trim();
  box.value = old ? `${old}\n\n---\n\n${clean}` : clean;
  saveStoryOutlineDraft(p, box.value || '');
  setStatus('已将右侧聊天最新回复追加到故事大纲');
  return true;
}

function renderLbThumbs(){
  const box = q('lbThumbs');
  if(!box) return;
  if(!Array.isArray(currentLightboxList) || !currentLightboxList.length){
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';
  box.innerHTML = currentLightboxList.map((it, idx) => `
    <div class="lb-thumb ${idx===currentLightboxIndex ? 'active' : ''}" data-i="${idx}">
      <img src="${it.url}" alt="${it.caption || ('#'+(idx+1))}" />
    </div>
  `).join('');
  [...box.querySelectorAll('.lb-thumb')].forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      const i = Number(el.getAttribute('data-i') || '0');
      currentLightboxIndex = i;
      const item = currentLightboxList[currentLightboxIndex] || {};
      openLightbox(item.url, item.caption || item.url || '');
    });
  });
}

function openLightbox(url, caption=''){
  if(!url) return;
  currentLightboxUrl = url;
  q('lbImg').src = url;
  q('lbCap').textContent = caption || url;
  q('lightbox').classList.add('show');
  const hasMulti = Array.isArray(currentLightboxList) && currentLightboxList.length > 1;
  q('lbPrev').style.display = hasMulti ? 'block' : 'none';
  q('lbNext').style.display = hasMulti ? 'block' : 'none';
  renderLbThumbs();
}

function openLightboxAt(list, index){
  if(!Array.isArray(list) || !list.length) return;
  currentLightboxList = list;
  currentLightboxIndex = Math.max(0, Math.min(index, list.length - 1));
  const item = currentLightboxList[currentLightboxIndex] || {};
  openLightbox(item.url, item.caption || item.url || '');
}

function lightboxPrev(e){
  e?.stopPropagation?.();
  if(!currentLightboxList.length) return;
  currentLightboxIndex = (currentLightboxIndex - 1 + currentLightboxList.length) % currentLightboxList.length;
  const item = currentLightboxList[currentLightboxIndex] || {};
  openLightbox(item.url, item.caption || item.url || '');
}

function lightboxNext(e){
  e?.stopPropagation?.();
  if(!currentLightboxList.length) return;
  currentLightboxIndex = (currentLightboxIndex + 1) % currentLightboxList.length;
  const item = currentLightboxList[currentLightboxIndex] || {};
  openLightbox(item.url, item.caption || item.url || '');
}

function openLightboxRaw(e){
  e?.stopPropagation?.();
  if(currentLightboxUrl) window.open(currentLightboxUrl, '_blank');
}

function closeLightbox(e, force=false){
  if(force || e.target.id === 'lightbox'){
    q('lightbox').classList.remove('show');
    q('lbImg').src = '';
    q('lbThumbs').innerHTML = '';
    currentLightboxUrl = '';
    currentLightboxList = [];
    currentLightboxIndex = 0;
  }
}

function openVideoBox(url, caption=''){
  if(!url) return;
  currentVideoUrl = url;
  q('vbVideo').src = url;
  q('vbCap').textContent = caption || url;
  q('videobox').classList.add('show');
}

function openVideoRaw(e){
  e?.stopPropagation?.();
  if(currentVideoUrl) window.open(currentVideoUrl, '_blank');
}

function closeVideoBox(e, force=false){
  if(force || e.target.id === 'videobox'){
    q('videobox').classList.remove('show');
    const v = q('vbVideo');
    v.pause();
    v.removeAttribute('src');
    v.load();
    currentVideoUrl = '';
  }
}

function normalizeSegments(raw){
  if(Array.isArray(raw)) return raw;
  if(raw && Array.isArray(raw.segments)) return raw.segments;
  if(raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

function normalizePromptMap(raw){
  const map = {};
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  for(const it of items){
    const sid = String(it.segmentId || it.id || '').trim();
    if(!sid) continue;
    map[sid] = String(it.prompt || it.promptOverride || it.imagePrompt || '').trim();
  }
  return map;
}

function normalizeBindingMap(raw){
  const map = {};
  const items = Array.isArray(raw) ? raw : (raw?.bindings || raw?.items || []);
  for(const it of items){
    const sid = String(it.segmentId || it.id || '').trim();
    if(!sid) continue;
    map[sid] = String(it.sceneImageUrl || it.imageUrl || '').trim();
  }
  return map;
}

function normalizeImageBindingMapFromRows(rows){
  const map = {};
  for(const r of rows){
    const sid = String(r.segmentId || r.id || '').trim();
    if(!sid) continue;
    const imageUrl = String(
      r.sceneImageUrl ||
      r.imageUrl ||
      r.url ||
      r.oss_url ||
      r.ossUrl ||
      r?.response?.data?.url ||
      r?.response?.data?.oss_url ||
      ''
    ).trim();
    if(!imageUrl) continue;
    const ok = r.ok !== false && Number(r.statusCode || r?.response?.code || 200) === 200;
    if(!ok) continue;
    map[sid] = imageUrl;
  }
  return map;
}

function normalizeDetailShotMapFromRows(rows){
  const map = {};
  for(const r of rows){
    const sid = String(r.segmentId || r.id || '').trim();
    if(!sid) continue;
    const imageUrl = String(
      r.sceneImageUrl ||
      r.imageUrl ||
      r.url ||
      r.oss_url ||
      r.ossUrl ||
      r?.response?.data?.url ||
      ''
    ).trim();
    if(!imageUrl) continue;
    const ok = r.ok !== false && Number(r.statusCode || r?.response?.code || 200) === 200;
    if(!ok) continue;
    if(!map[sid]) map[sid] = [];
    map[sid].push({
      shotId: String(r.shotId || '').trim(),
      url: imageUrl,
      taskId: String(r?.response?.data?.task_id || r.taskId || '').trim()
    });
  }
  return map;
}

function normalizeCharacters(raw, source='project', project=''){
  const items = Array.isArray(raw?.characters) ? raw.characters : (Array.isArray(raw) ? raw : []);
  return items.map(it => {
    const id = String(it.id || '').trim();
    const name = String(it.name || it.characterName || '').trim();
    return {
      id,
      name,
      role: String(it.role || '').trim(),
      imageUrl: String(it.imageUrl || '').trim(),
      prompt: String(it.prompt || it.imagePrompt || '').trim(),
      designNotes: String(it.designNotes || it.notes || '').trim(),
      status: String(it.status || '').trim(),
      source,
      project,
      key: `${source}:${project || '_'}:${id || name || 'unnamed'}`
    };
  }).filter(it => it.id || it.name);
}

function readProjectCharactersDraftMap(){
  try {
    const raw = localStorage.getItem(PROJECT_CHARACTERS_DRAFT_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveProjectCharactersDraft(project='', chars=[]){
  const key = String(project || '').trim();
  if(!key) return;
  const map = readProjectCharactersDraftMap();
  map[key] = Array.isArray(chars) ? chars : [];
  try { localStorage.setItem(PROJECT_CHARACTERS_DRAFT_KEY, JSON.stringify(map)); } catch {}
}

function getProjectCharactersDraft(project=''){
  const key = String(project || '').trim();
  if(!key) return { exists: false, chars: [] };
  const map = readProjectCharactersDraftMap();
  if(Object.prototype.hasOwnProperty.call(map, key)){
    return {
      exists: true,
      chars: normalizeCharacters(map[key], 'project', key),
    };
  }
  return { exists: false, chars: [] };
}

function readProjectCharacterImageOverrides(){
  try {
    const raw = localStorage.getItem(PROJECT_CHARACTER_IMAGE_OVERRIDES_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveProjectCharacterImageOverrides(map = {}){
  try { localStorage.setItem(PROJECT_CHARACTER_IMAGE_OVERRIDES_KEY, JSON.stringify(map || {})); } catch {}
}

function setProjectCharacterImageOverride(project='', characterName='', imageUrl=''){
  const p = String(project || '').trim();
  const n = normalizeCharacterNameKey(characterName || '');
  if(!p || !n) return;
  const map = readProjectCharacterImageOverrides();
  if(!map[p] || typeof map[p] !== 'object') map[p] = {};
  if(String(imageUrl || '').trim()) map[p][n] = String(imageUrl || '').trim();
  else delete map[p][n];
  saveProjectCharacterImageOverrides(map);
}

function applyProjectCharacterImageOverrides(chars = [], project=''){
  const p = String(project || '').trim();
  if(!p) return Array.isArray(chars) ? chars : [];
  const map = readProjectCharacterImageOverrides();
  const row = map[p] && typeof map[p] === 'object' ? map[p] : {};
  return (Array.isArray(chars) ? chars : []).map(ch => {
    const key = normalizeCharacterNameKey(ch?.name || ch?.id || '');
    const img = String(row[key] || '').trim();
    return img ? { ...ch, imageUrl: img } : ch;
  });
}

function normalizeCharacterLibrary(raw){
  return normalizeCharacters(raw, 'global', '').map(it => ({ ...it, source: 'global', project: '' }));
}

function normalizeCharacterNameKey(v=''){
  return String(v || '').trim().toLowerCase();
}

function mergeCharacterLists(projectChars, globalChars){
  const out = [];
  const seen = new Set();
  for(const ch of (projectChars || [])){
    const key = `p:${normalizeCharacterNameKey(ch.id || ch.name)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ch, source: 'project' });
  }
  for(const ch of (globalChars || [])){
    const key = `p:${normalizeCharacterNameKey(ch.id || ch.name)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ch, source: 'global' });
  }
  return out;
}

function setCharacterLibraryStatus(text=''){
  const el = q('characterLibStatus');
  if(el) el.textContent = text || '全局角色库：未加载';
}

function setCharacterProjectStatus(project=''){
  const el = q('characterProjectStatus');
  if(el) el.textContent = `当前项目：${project || '未选择'}`;
}

function readProjectCharacterOverrides(){
  try{
    const raw = localStorage.getItem(PROJECT_CHARACTER_OVERRIDE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveProjectCharacterOverrides(data){
  try { localStorage.setItem(PROJECT_CHARACTER_OVERRIDE_KEY, JSON.stringify(data || {})); } catch {}
}

function getProjectCharacterOverrides(project){
  const map = readProjectCharacterOverrides();
  const arr = Array.isArray(map?.[project]) ? map[project] : [];
  return arr.map(x => String(x || '').trim()).filter(Boolean);
}

function setProjectCharacterOverride(project, globalKey, enabled){
  if(!project || !globalKey) return;
  const map = readProjectCharacterOverrides();
  const current = new Set(Array.isArray(map?.[project]) ? map[project].map(x => String(x || '').trim()).filter(Boolean) : []);
  if(enabled) current.add(globalKey);
  else current.delete(globalKey);
  map[project] = [...current];
  saveProjectCharacterOverrides(map);
}

function toggleGlobalCharacterForCurrentProject(globalKey){
  if(!currentProjectName || !globalKey) return;
  const selected = new Set(getProjectCharacterOverrides(currentProjectName));
  const willEnable = !selected.has(globalKey);
  setProjectCharacterOverride(currentProjectName, globalKey, willEnable);
  renderCharacters(currentProjectCharacters, currentProjectName);
}

function renderGlobalLibraryShowcase(project=''){
  const list = Array.isArray(globalCharacterLibrary) ? globalCharacterLibrary : [];
  const selected = new Set(getProjectCharacterOverrides(project));
  if(!list.length){
    return `
      <div class="character-library-showcase">
        <div class="character-library-head">
          <div>
            <div class="character-library-title">全局角色库</div>
            <div class="character-library-sub">当前暂无角色。可点击“+ 添加全局角色”创建后再加入项目。</div>
          </div>
        </div>
      </div>
    `;
  }

  const cards = list.map(ch => {
    const key = String(ch.key || '');
    const inProject = selected.has(key);
    const safeName = escapeHtml(ch.name || ch.id || '未命名角色');
    const safeRole = escapeHtml(ch.role || '未设置身份');
    const safeNotes = escapeHtml(ch.designNotes || '暂无设定').replace(/\n/g,' ');
    const safeImg = escapeHtml(ch.imageUrl || '');
    const keyEnc = encodeURIComponent(key);
    const btnText = inProject ? '已加入 · 点击移除' : '+ 加入当前项目';
    return `
      <div class="library-card ${inProject ? 'in-project' : ''}">
        <div class="library-card-top">
          ${safeImg ? `<a href="javascript:void(0)" data-img="${safeImg}" data-sid="${safeName}" class="thumb-link"><img src="${safeImg}" alt="${safeName}" /></a>` : '<img alt="no-image" src="data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"46\" height=\"62\" viewBox=\"0 0 46 62\"%3E%3Crect width=\"46\" height=\"62\" fill=\"%23121924\"/%3E%3Ctext x=\"50%25\" y=\"50%25\" dominant-baseline=\"middle\" text-anchor=\"middle\" fill=\"%239aa4b2\" font-size=\"9\"%3ENo%3C/text%3E%3C/svg%3E" />'}
          <div>
            <div class="library-card-name">${safeName}</div>
            <div class="library-card-role">${safeRole}</div>
          </div>
        </div>
        <div class="library-card-notes">${safeNotes}</div>
        <div class="library-card-actions">
          <button class="${inProject ? 'btn-ghost' : 'btn-primary'}" onclick="toggleGlobalCharacterForCurrentProjectEncoded('${keyEnc}')">${btnText}</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="character-library-showcase">
      <div class="character-library-head">
        <div>
          <div class="character-library-title">全局角色库快捷添加</div>
          <div class="character-library-sub">共 ${list.length} 个角色，当前项目已加入 ${selected.size} 个。可直接卡片操作，不用弹窗。</div>
        </div>
        <button class="btn-ghost" onclick="openAddGlobalCharacterMenu()">高级批量选择</button>
      </div>
      <div class="character-library-grid">${cards}</div>
    </div>
  `;
}

function toggleGlobalCharacterForCurrentProjectEncoded(globalKeyEnc){
  const globalKey = decodeURIComponent(String(globalKeyEnc || ''));
  toggleGlobalCharacterForCurrentProject(globalKey);
}

async function loadGlobalCharacterLibrary(forceRefresh=false){
  if(!forceRefresh && Array.isArray(globalCharacterLibrary) && globalCharacterLibrary.length){
    setCharacterLibraryStatus(`全局角色库：${globalCharacterLibrary.length} 个`);
    return globalCharacterLibrary;
  }

  try {
    const rawLocal = localStorage.getItem(CHARACTER_LIBRARY_STORAGE_KEY);
    const parsedLocal = rawLocal ? JSON.parse(rawLocal) : null;
    const localItems = normalizeCharacterLibrary(parsedLocal || []);
    if(localItems.length){
      globalCharacterLibrary = localItems;
      setCharacterLibraryStatus(`全局角色库：${globalCharacterLibrary.length} 个（本地缓存）`);
    }
  } catch {}

  const candidates = [
    './character-library.json',
    './assets/character-library.json',
    './global-character-library.json',
    './assets/global-character-library.json'
  ];

  for(const url of candidates){
    try {
      const raw = await fetchJson(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now());
      const items = normalizeCharacterLibrary(raw);
      if(items.length){
        globalCharacterLibrary = items;
        try { localStorage.setItem(CHARACTER_LIBRARY_STORAGE_KEY, JSON.stringify({ characters: items })); } catch {}
        setCharacterLibraryStatus(`全局角色库：${globalCharacterLibrary.length} 个（${url}）`);
        return globalCharacterLibrary;
      }
    } catch {}
  }

  if(globalCharacterLibrary.length){
    setCharacterLibraryStatus(`全局角色库：${globalCharacterLibrary.length} 个（缓存）`);
  } else {
    setCharacterLibraryStatus('全局角色库：0 个（未找到 character-library.json）');
  }
  return globalCharacterLibrary;
}

async function reloadGlobalCharacterLibrary(){
  await loadGlobalCharacterLibrary(true);
  renderCharacters(currentProjectCharacters, currentProjectName);
}

async function fetchCharacters(project){
  const charsUrl = `./${project}/planning/characters-confirmed.json`;
  const promptsUrl = `./${project}/prompts/character-image-prompts.json`;
  let chars = [];
  let promptItems = [];
  try {
    const raw = await fetchJson(charsUrl);
    chars = normalizeCharacters(raw, 'project', project);
  } catch {}
  try {
    const raw = await fetchJson(promptsUrl);
    promptItems = Array.isArray(raw?.items) ? raw.items : [];
  } catch {}
  const promptMap = {};
  for(const it of promptItems){
    const key1 = String(it.characterId || '').trim();
    const key2 = String(it.characterName || '').trim();
    const val = String(it.prompt || '').trim();
    if(key1 && val) promptMap[key1] = val;
    if(key2 && val) promptMap[key2] = val;
  }
  return chars.map(ch => ({ ...ch, prompt: ch.prompt || promptMap[ch.id] || promptMap[ch.name] || '' }));
}

function renderCharacterPlanPanel(){
  if(!Array.isArray(pendingCharacterPlan) || !pendingCharacterPlan.length) return '';
  const items = pendingCharacterPlan.map((r, i) => `<li>${escapeHtml(r.name || `角色${i+1}`)}${r.role ? `（${escapeHtml(r.role)}）` : ''}</li>`).join('');
  return `
    <div class="character-plan-card">
      <div class="character-plan-title">角色清单（请先确认）</div>
      <ol class="character-plan-list">${items}</ol>
      <div class="character-plan-actions">
        <button class="btn-primary" onclick="confirmCharacterPlanAndGenerate()">确认角色并生成每个角色提示词</button>
        <button class="btn-ghost" onclick="clearCharacterPlan()">清空清单</button>
      </div>
    </div>
  `;
}

function clearCharacterPlan(){
  pendingCharacterPlan = [];
  renderCharacters(currentProjectCharacters, currentProjectName);
  setStatus('已清空角色待确认清单');
}

function confirmCharacterPlanAndGenerate(){
  if(!pendingCharacterPlan.length){
    setStatus('当前没有待确认的角色清单', false);
    return;
  }
  switchToCharacterMode();
  const input = q('chatInput');
  if(!input || chatSending) return;
  const listText = pendingCharacterPlan.map((r, i) => `${i+1}. ${r.name}${r.role ? `（${r.role}）` : ''}`).join('\n');
  input.value = `确认角色，并生成每个角色提示词。\n请严格按以下角色清单输出 step=apply JSON：\n${listText}`;
  sendChat();
}

function renderCharacters(chars, project=''){
  const wrap = q('characterSection');
  if(!wrap) return;

  currentProjectName = String(project || currentProjectName || '').trim();
  currentProjectCharacters = applyProjectCharacterImageOverrides(Array.isArray(chars) ? chars : [], currentProjectName);
  setCharacterProjectStatus(currentProjectName);

  const selectedGlobalKeys = new Set(getProjectCharacterOverrides(currentProjectName));
  const selectedGlobal = (globalCharacterLibrary || []).filter(ch => selectedGlobalKeys.has(ch.key));
  renderedGlobalCharacters = selectedGlobal;

  const merged = mergeCharacterLists(currentProjectCharacters, selectedGlobal);
  const showcaseHtml = renderGlobalLibraryShowcase(currentProjectName);
  const planHtml = renderCharacterPlanPanel();

  if(!merged.length){
    const canAdd = Array.isArray(globalCharacterLibrary) && globalCharacterLibrary.length;
    wrap.innerHTML = `
      ${planHtml}
      ${showcaseHtml}
      <div class="character-empty">
        <div class="character-empty-title">暂无人物设定</div>
        <div class="character-empty-sub">这个项目还没有角色。你可以先从上方全局角色卡片直接一键添加，也可以使用批量选择。</div>
        <div class="character-card-actions">
          <button class="btn-primary" onclick="openAddGlobalCharacterMenu()" ${canAdd ? '' : 'disabled'}>批量从全局角色库添加</button>
          <button class="btn-ghost" onclick="reloadGlobalCharacterLibrary()">刷新角色库</button>
        </div>
      </div>
    `;
    bindCharacterThumbPreview();
    return;
  }

  wrap.innerHTML = planHtml + showcaseHtml + merged.map(ch => {
    const sourceTag = ch.source === 'global' ? '<span class="character-source global">全局角色库</span>' : '<span class="character-source project">当前项目</span>';
    const projectEnc = encodeURIComponent(currentProjectName || '');
    const keyEnc = encodeURIComponent(ch.key || '');
    const payloadEnc = encodeURIComponent(JSON.stringify({
      name: ch.name || ch.id || '',
      role: ch.role || '',
      designNotes: ch.designNotes || '',
      prompt: ch.prompt || '',
      source: ch.source || '',
      key: ch.key || ''
    }));

    const sourceAction = ch.source === 'global'
      ? `<div class="character-card-actions"><button class="btn-ghost" onclick="removeGlobalCharacterFromProjectEncoded(\"${projectEnc}\",\"${keyEnc}\")">从当前项目移除</button><button class="btn-ghost" onclick="generateThreeViewPromptForCard(this, '${payloadEnc}')">生成3视图</button><button class="btn-primary" onclick="openAddGlobalCharacterMenu()">继续添加角色</button></div>`
      : `<div class="character-card-actions"><button class="btn-ghost" onclick="generateThreeViewPromptForCard(this, '${payloadEnc}')">生成3视图</button><button class="btn-primary" onclick="openAddGlobalCharacterMenu()">添加全局角色到当前项目</button></div>`;
    const safeName = escapeHtml(ch.name || ch.id || '未命名角色');
    const safeRole = escapeHtml(ch.role || '-');
    const safeStatus = ch.status ? `｜${escapeHtml(ch.status)}` : '';
    const safeImg = escapeHtml(ch.imageUrl || '');
    const safeCaption = escapeHtml(ch.name || ch.id || '角色');
    const safeNotes = escapeHtml(ch.designNotes || '暂无设定说明').replace(/\n/g,'<br/>');
    const safePrompt = escapeHtml(ch.prompt || '暂无提示词');
    return `
      <div class="character-card">
        <div class="character-name">${safeName}${sourceTag}</div>
        <div class="character-role">${safeRole}${safeStatus}</div>
        <div class="character-row">
          <div class="character-preview">
            ${safeImg ? `<a href="javascript:void(0)" data-img="${safeImg}" data-sid="${safeCaption}" class="thumb-link"><img src="${safeImg}" alt="${safeCaption}" /></a>` : '<div class="meta">暂无图片</div>'}
          </div>
          <div>
            <div class="meta">人物设定</div>
            <div class="character-notes">${safeNotes}</div>
          </div>
          <div class="character-prompt">
            <div class="meta">人物设定提示词</div>
            <textarea>${safePrompt}</textarea>
            ${sourceAction}
          </div>
        </div>
      </div>
    `;
  }).join('');

  bindCharacterThumbPreview();
}

function bindCharacterThumbPreview(){
  const links = [...document.querySelectorAll('#characterSection a.thumb-link')];
  if(!links.length) return;

  const list = links.map((lnk, idx) => ({
    idx,
    url: String(lnk.getAttribute('data-img') || '').trim(),
    caption: String(lnk.getAttribute('data-sid') || `角色${idx+1}`).trim(),
  })).filter(x => x.url);

  links.forEach((a, idx) => {
    a.onclick = (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      const url = String(a.getAttribute('data-img') || '').trim();
      if(!url) return;
      const listIndex = list.findIndex(it => it.url === url && it.idx === idx);
      if(listIndex >= 0) openLightboxAt(list, listIndex);
      else openLightbox(url, String(a.getAttribute('data-sid') || url));
    };
  });
}

function getCharacterPickerCandidates(){
  const selected = new Set(getProjectCharacterOverrides(currentProjectName));
  return (globalCharacterLibrary || []).filter(ch => !selected.has(ch.key));
}

function updateCharacterPickerCounter(totalVisible = null){
  const countEl = q('characterPickerCount');
  const summaryEl = q('characterPickerSummary');
  const total = Number.isFinite(totalVisible) ? totalVisible : characterPickerCandidates.length;
  const selected = selectedGlobalCharacterKeys.size;
  if(countEl){
    countEl.textContent = selected
      ? `已选择 ${selected} 个角色，将添加到当前项目`
      : '未选择角色';
  }
  if(summaryEl){
    summaryEl.textContent = `${selected} / ${total} 已选择`;
  }
}

function renderCharacterPickerList(list = characterPickerCandidates){
  const box = q('characterPickerList');
  if(!box) return;
  const arr = Array.isArray(list) ? list : [];
  if(!arr.length){
    box.innerHTML = '<div class="character-picker-empty">没有匹配的角色，可尝试清空搜索词或刷新全局角色库。</div>';
    updateCharacterPickerCounter(0);
    return;
  }
  box.innerHTML = arr.map(ch => {
    const key = String(ch.key || '');
    const active = selectedGlobalCharacterKeys.has(key);
    const safeName = escapeHtml(ch.name || ch.id || '未命名角色');
    const safeRole = escapeHtml(ch.role || '未设置身份');
    const safeNotes = escapeHtml(ch.designNotes || '暂无设定').replace(/\n/g,' ');
    const safeImg = escapeHtml(ch.imageUrl || '');
    const check = active ? '✓' : '';
    return `
      <div class="character-picker-item ${active ? 'active' : ''}" data-key="${key}">
        <div class="character-picker-check">${check}</div>
        ${safeImg ? `<img src="${safeImg}" alt="${safeName}" />` : '<img alt="no-image" src="data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"58\" height=\"76\" viewBox=\"0 0 58 76\"%3E%3Crect width=\"58\" height=\"76\" fill=\"%23121924\"/%3E%3Ctext x=\"50%25\" y=\"50%25\" dominant-baseline=\"middle\" text-anchor=\"middle\" fill=\"%239aa4b2\" font-size=\"10\"%3ENo Image%3C/text%3E%3C/svg%3E" />'}
        <div class="character-picker-main">
          <div class="character-picker-name">${safeName}</div>
          <div class="character-picker-role">${safeRole}</div>
          <div class="character-picker-notes">${safeNotes}</div>
        </div>
      </div>
    `;
  }).join('');

  [...box.querySelectorAll('.character-picker-item')].forEach(item => {
    item.addEventListener('click', () => {
      const key = String(item.getAttribute('data-key') || '');
      if(!key) return;
      if(selectedGlobalCharacterKeys.has(key)) selectedGlobalCharacterKeys.delete(key);
      else selectedGlobalCharacterKeys.add(key);
      filterCharacterPickerList();
    });
  });

  updateCharacterPickerCounter(arr.length);
}

function filterCharacterPickerList(){
  const keyword = String(q('characterPickerSearch')?.value || '').trim().toLowerCase();
  let list = characterPickerCandidates;
  if(keyword){
    list = characterPickerCandidates.filter(ch => {
      const text = `${ch.name || ''} ${ch.id || ''} ${ch.role || ''} ${ch.designNotes || ''}`.toLowerCase();
      return text.includes(keyword);
    });
  }
  renderCharacterPickerList(list);
}

function refreshCharacterPicker(){
  characterPickerCandidates = getCharacterPickerCandidates();
  selectedGlobalCharacterKeys = new Set(
    [...selectedGlobalCharacterKeys].filter(key => characterPickerCandidates.some(ch => ch.key === key))
  );
  if(q('characterPickerProjectHint')) q('characterPickerProjectHint').textContent = `当前项目：${currentProjectName || '-'}`;
  if(q('characterPickerSearch')) q('characterPickerSearch').value = '';
  renderCharacterPickerList(characterPickerCandidates);
}

function toggleCharacterPickerSelectAll(){
  if(!characterPickerCandidates.length) return;
  const allSelected = characterPickerCandidates.every(ch => selectedGlobalCharacterKeys.has(ch.key));
  if(allSelected){
    characterPickerCandidates.forEach(ch => selectedGlobalCharacterKeys.delete(ch.key));
  } else {
    characterPickerCandidates.forEach(ch => selectedGlobalCharacterKeys.add(ch.key));
  }
  filterCharacterPickerList();
}

function closeCharacterPicker(event, force=false){
  if(force || event?.target?.id === 'characterPickerModal'){
    q('characterPickerModal')?.classList.remove('show');
  }
}

function confirmCharacterPicker(){
  if(!currentProjectName) return;
  if(!selectedGlobalCharacterKeys.size){
    alert('请至少选择 1 个角色');
    return;
  }
  [...selectedGlobalCharacterKeys].forEach(key => setProjectCharacterOverride(currentProjectName, key, true));
  closeCharacterPicker(null, true);
  renderCharacters(currentProjectCharacters, currentProjectName);
}

function openAddGlobalCharacterMenu(){
  if(!currentProjectName){
    alert('请先选择并加载项目');
    return;
  }
  if(!globalCharacterLibrary.length){
    alert('全局角色库为空，请先点击“刷新全局角色库”');
    return;
  }
  characterPickerCandidates = getCharacterPickerCandidates();
  if(!characterPickerCandidates.length){
    setStatus('全局角色都已加入当前项目');
    return;
  }
  selectedGlobalCharacterKeys = new Set();
  q('characterPickerModal')?.classList.add('show');
  refreshCharacterPicker();
}

function removeGlobalCharacterFromProject(project, globalKey){
  setProjectCharacterOverride(project, globalKey, false);
  renderCharacters(currentProjectCharacters, currentProjectName);
}

function removeGlobalCharacterFromProjectEncoded(projectEnc, keyEnc){
  const project = decodeURIComponent(String(projectEnc || ''));
  const globalKey = decodeURIComponent(String(keyEnc || ''));
  removeGlobalCharacterFromProject(project, globalKey);
}

async function fetchMultiShotMap(project, segments){
  const map = {};
  const tasks = segments.map(async(seg)=>{
    const sid = String(seg.segmentId || seg.id || '').trim();
    if(!sid) return;
    const path = `./${project}/planning/${sid.toLowerCase()}-multishot-images.json`;
    try{
      const raw = await fetchJson(path);
      const shots = Array.isArray(raw?.shots) ? raw.shots : [];
      const okShots = shots
        .filter(s => s && s.ok && typeof s.sceneImageUrl === 'string' && s.sceneImageUrl.startsWith('http'))
        .map(s => ({
          shotId: s.shotId || '',
          url: s.sceneImageUrl,
          taskId: s?.response?.data?.task_id || s?.taskId || ''
        }));
      if(okShots.length) map[sid] = okShots;
    }catch{}
  });
  await Promise.all(tasks);
  return map;
}

async function fetchGrid4ImageMap(project, segments){
  const map = {};
  const tasks = segments.map(async(seg)=>{
    const sid = String(seg.segmentId || seg.id || '').trim();
    if(!sid) return;
    const path = `./${project}/planning/${sid.toLowerCase()}-grid4-images.json`;
    try{
      const raw = await fetchJson(path);
      const url = String(raw?.sceneImageUrl || raw?.response?.data?.url || '').trim();
      if(!url || !url.startsWith('http')) return;
      map[sid] = {
        url,
        taskId: String(raw?.response?.data?.task_id || raw?.taskId || '').trim(),
        mode: String(raw?.mode || 'grid4')
      };
    }catch{}
  });
  await Promise.all(tasks);
  return map;
}

async function fetchExtraPreviewRows(project){
  try{
    const raw = await fetchJson(`./${project}/planning/extra-preview-rows.json`);
    const items = Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw) ? raw : []);
    return items.map((it, idx) => ({
      id: String(it.id || it.segmentId || `extra-${idx+1}`).trim(),
      segmentId: String(it.segmentId || it.id || `extra-${idx+1}`).trim(),
      scene: String(it.scene || '').trim(),
      visual: String(it.visual || '').trim(),
      dialogue: String(it.dialogue || '').trim(),
      text: String(it.text || '').trim(),
      durationSec: it.durationSec ?? null,
      imagePrompt: String(it.imagePrompt || '').trim(),
      imageUrl: String(it.imageUrl || '').trim(),
      videoPrompt: String(it.videoPrompt || '').trim(),
      videoUrl: String(it.videoUrl || '').trim(),
      videoMeta: it.videoMeta || null,
      isExtraPreviewRow: true,
    })).filter(it => it.segmentId);
  }catch{
    return [];
  }
}

function parseJsonl(text){
  return String(text || '')
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function normalizeVideoMap(rows){
  const map = {};
  for(const r of rows){
    const sidRaw = String(r.segmentId || r.id || '').trim();
    if(!sidRaw) continue;

    const videoUrl = r.videoUrl || r.video_url || r.url || r.playUrl || r.play_url ||
      r.local_url || r.hdVideoUrl ||
      (r.response && r.response.data && (r.response.data.video_url || r.response.data.url || r.response.data.play_url || r.response.data.local_url)) || '';

    const item = {
      ok: !!r.ok,
      statusCode: r.statusCode ?? null,
      status: r.status || '',
      videoId: r.videoId ?? (r.response && r.response.data && r.response.data.video_id) ?? null,
      taskId: r.taskId ?? (r.response && r.response.data && r.response.data.task_id) ?? '',
      soraDraftId: r.soraDraftId || r.sora_draft_id || r.draftId || (r.response && r.response.data && r.response.data.sora_draft_id) || '',
      videoUrl: String(videoUrl || ''),
      mediaUrl: String(r.mediaUrl || r.media_url || ''),
      hdVideoUrl: String(r.hdVideoUrl || r.hd_media_url || ''),
      thumbnailUrl: String(r.thumbnailUrl || r.thumbnail_url || ''),
      createdAt: r.createdAt || r.testedAt || '',
      variant: r.variant || ''
    };

    const sidTargets = [sidRaw];

    for(const sid of sidTargets){
      if(!map[sid]) map[sid] = { latest: null, variants: [] };
      map[sid].latest = item;
      if(item.variant){
        map[sid].variants.push(item);
      }
    }
  }
  return map;
}

function normalizeVideoPromptMapFromRows(rows){
  const map = {};
  for(const r of rows){
    const sid = String(r.segmentId || r.id || '').trim();
    if(!sid) continue;

    const prompt = String(
      r?.payload?.prompt ||
      r?.prompt ||
      r?.videoPrompt ||
      r?.video_prompt ||
      ''
    ).trim();
    if(!prompt) continue;

    if(!map[sid]) map[sid] = { latest: '', variants: [] };
    map[sid].latest = prompt;
    map[sid].variants.push({
      variant: String(r.variant || ''),
      durationSec: r.durationSec ?? null,
      createdAt: r.createdAt || '',
      prompt
    });
  }
  return map;
}

function mergeVideoPromptMap(base = {}, extra = {}){
  const out = { ...base };
  for(const sid of Object.keys(extra || {})){
    const src = extra[sid] || { latest: '', variants: [] };
    if(!out[sid]) out[sid] = { latest: '', variants: [] };

    if(src.latest) out[sid].latest = src.latest;
    if(Array.isArray(src.variants) && src.variants.length){
      out[sid].variants.push(...src.variants);
    }

    // 同提示词去重，保持后写入的在后（更“新”）
    const seen = new Set();
    out[sid].variants = out[sid].variants.filter(v => {
      const key = `${v.variant || ''}|${v.durationSec ?? ''}|${v.prompt || ''}`;
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return out;
}

function pushVideoPrompt(map, sid, rec){
  if(!sid) return;
  const prompt = String(rec?.prompt || '').trim();
  if(!prompt) return;

  if(!map[sid]) map[sid] = { latest: '', variants: [] };
  map[sid].latest = prompt;
  map[sid].variants.push({
    variant: String(rec?.variant || ''),
    durationSec: rec?.durationSec ?? null,
    createdAt: rec?.createdAt || '',
    sourceFile: String(rec?.sourceFile || ''),
    prompt
  });
}

async function fetchPlanningVideoPromptMap(project, segments){
  const map = {};

  // 1) 批量文件（S04~S08 等）
  try{
    const raw = await fetchJson(`./${project}/planning/remaining-s04-s08-batch-video-jobs.json`);
    const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
    for(const j of jobs){
      const sid = String(j.segmentId || j.id || '').trim();
      pushVideoPrompt(map, sid, {
        variant: j.variant || '',
        durationSec: j.durationSec ?? null,
        createdAt: j.createdAt || raw.updatedAt || '',
        sourceFile: 'remaining-s04-s08-batch-video-jobs.json',
        prompt: j?.payload?.prompt || j?.prompt || ''
      });
    }
  }catch{}

  // 2) 分段文件（multishot / grid4 / grid9 / sc9）
  const tasks = segments.map(async(seg)=>{
    const sid = String(seg.segmentId || seg.id || '').trim();
    if(!sid) return;

    const base = sid.toLowerCase();
    const candidates = [
      `${base}-multishot-video-jobs.json`,
      `${base}-multishot-video-jobs-rerun-v2.json`,
      `${base}-grid4-video-job.json`,
      `${base}-grid9-video-job.json`,
      `${base}-sc9-video-job.json`
    ];

    for(const name of candidates){
      const path = `./${project}/planning/${name}`;
      try{
        const raw = await fetchJson(path);

        if(Array.isArray(raw?.jobs)){
          for(const j of raw.jobs){
            pushVideoPrompt(map, sid, {
              variant: j.variant || '',
              durationSec: j.durationSec ?? null,
              createdAt: j.createdAt || raw.updatedAt || '',
              sourceFile: name,
              prompt: j?.payload?.prompt || j?.prompt || ''
            });
          }
        }else{
          const singleSid = String(raw?.segmentId || sid).trim();
          pushVideoPrompt(map, singleSid, {
            variant: raw?.variant || '',
            durationSec: raw?.durationSec ?? null,
            createdAt: raw?.createdAt || raw?.updatedAt || '',
            sourceFile: name,
            prompt: raw?.payload?.prompt || raw?.prompt || ''
          });
        }
      }catch{}
    }
  });

  await Promise.all(tasks);
  return map;
}

function videoPromptVariantRank(v){
  const tag = `${v?.variant || ''} ${v?.sourceFile || ''}`.toLowerCase();
  if(tag.includes('grid9') || tag.includes('九宫')) return 100;
  if(tag.includes('grid4') || tag.includes('四宫')) return 90;
  if(tag.includes('sc9')) return 85;
  if(tag.includes('multishot')) return 70;
  if(tag.includes('batch')) return 60;
  return 10;
}

function ensureVideoStyle(text=''){
  const raw = String(text || '').trim();
  if(!raw) return VIDEO_STYLE_RULE;
  if(raw.includes('meme漫画风') || raw.includes('meme 漫画风') || raw.includes('漫画风') || raw.toLowerCase().includes('style:')) return raw;
  return `${VIDEO_STYLE_RULE}\n${raw}`;
}

function resolveVideoPrompt(sid, seg, videoPromptMap){
  const rec = videoPromptMap?.[sid];
  if(!rec) return defaultVideoPrompt(seg);

  const latest = String(rec.latest || '').trim();
  const variants = Array.isArray(rec.variants) ? rec.variants : [];

  if(!latest && !variants.length) return defaultVideoPrompt(seg);

  const sidNum = Number((String(sid || '').match(/\d+/) || [0])[0]);
  let preferred = latest;
  let preferredMeta = null;

  if(variants.length){
    // S05+ 优先四/九宫格；其余段优先最新
    if(sidNum >= 5){
      const sorted = [...variants].sort((a,b)=> videoPromptVariantRank(b) - videoPromptVariantRank(a));
      preferredMeta = sorted[0] || null;
    }else{
      preferredMeta = variants[variants.length - 1] || null;
    }

    if(preferredMeta?.prompt) preferred = preferredMeta.prompt;
  }

  // 弹窗里只显示单一主提示词，不拼接“推荐标题/候选提示词”区块。
  return ensureVideoStyle(preferred || latest || defaultVideoPrompt(seg));
}

function composeScript(seg){
  const scene = String(seg.scene || '').trim();
  const visual = String(seg.visual || '').trim();
  const dialogue = String(seg.dialogue || '').trim();
  const text = String(seg.text || seg.script || seg.content || '').trim();
  const composed = [scene, visual, dialogue].filter(Boolean).join('，');
  return composed || text;
}

function defaultImagePrompt(seg){
  const script = composeScript(seg);
  return `当前段 script：${script}\n${STRICT_RULE}`;
}

function defaultVideoPrompt(seg){
  const sid = String(seg.segmentId || seg.id || 'SXX');
  const scene = String(seg.scene || '').trim();
  const visual = String(seg.visual || '').trim();
  const dialogue = String(seg.dialogue || '').trim();
  const dur = Number(seg.durationSec || 6);
  return `${VIDEO_STYLE_RULE}\n${dur}秒短视频，9:16，meme漫画风。${sid}：${scene}，${visual}。台词/情绪：${dialogue}。镜头要求：动作连贯、人物关系清晰、禁止无关背景。`;
}

function durationLabel(seg){
  if(seg.durationSec) return `${seg.durationSec}s`;
  if(seg.duration) return String(seg.duration);
  return '-';
}

let latestOutlineProject = '';
let latestOutlineSegments = [];

function storyTextPreview(seg, maxLen = 46){
  const text = String(composeScript(seg) || '').replace(/\s+/g, ' ').trim();
  if(!text) return '（该段暂无文本）';
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function collectOutlineCharacters(segments = []){
  const fromProject = (currentProjectCharacters || [])
    .map(ch => String(ch?.name || ch?.id || '').trim())
    .filter(Boolean);
  if(fromProject.length) return [...new Set(fromProject)].slice(0, 6);

  const text = (segments || []).map(seg => `${seg?.scene || ''} ${seg?.dialogue || ''}`).join(' ');
  const names = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  const deny = new Set(['镜头', '画面', '分镜', '剧情', '人物', '场景', '动作', '台词', '情绪', '当前', '必须', '禁止']);
  return [...new Set(names.filter(n => !deny.has(n)))].slice(0, 6);
}

function readStoryOutlineDraftMap(){
  try {
    const raw = localStorage.getItem(STORY_OUTLINE_DRAFT_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function normalizeStoryOutlineDraftKey(project=''){
  const k = String(project || '').trim();
  return k || '__default__';
}

function getStoryOutlineDraft(project=''){
  const key = normalizeStoryOutlineDraftKey(project);
  const map = readStoryOutlineDraftMap();
  if(Object.prototype.hasOwnProperty.call(map, key)){
    return { exists: true, text: String(map[key] ?? '') };
  }
  return { exists: false, text: '' };
}

function saveStoryOutlineDraft(project='', text=''){
  const key = normalizeStoryOutlineDraftKey(project);
  const map = readStoryOutlineDraftMap();
  map[key] = String(text ?? '');
  try { localStorage.setItem(STORY_OUTLINE_DRAFT_KEY, JSON.stringify(map)); } catch {}
}

function buildStoryOutline(project, segments = []){
  const list = Array.isArray(segments) ? segments : [];
  const count = list.length;
  const totalDuration = list.reduce((sum, seg) => sum + (Number(seg?.durationSec) || 0), 0);
  const chars = collectOutlineCharacters(list);

  if(!count){
    return {
      text: `【项目】${project || '-'}\n【故事大纲】暂无可用分段数据。`,
      meta: { count: 0, totalDuration: 0, chars: [] }
    };
  }

  const first = list[0];
  const middle = list[Math.floor((count - 1) / 2)];
  const ending = list[count - 1];

  const mainline = [
    `开场：${storyTextPreview(first, 64)}`,
    `推进：${storyTextPreview(middle, 64)}`,
    `收束：${storyTextPreview(ending, 64)}`
  ].join('；');

  const topSegments = list.slice(0, Math.min(8, count)).map((seg, i) => {
    const sid = String(seg?.segmentId || seg?.id || `S${String(i+1).padStart(2,'0')}`);
    return `${i+1}. ${sid}｜${storyTextPreview(seg, 56)}`;
  });

  const roleLine = chars.length ? chars.join('、') : '待补充';
  const durLine = totalDuration > 0 ? `${totalDuration} 秒（约 ${(totalDuration/60).toFixed(1)} 分钟）` : '未标注';

  const text = [
    `【项目】${project || '-'}`,
    `【故事主线】${mainline}`,
    `【主要角色】${roleLine}`,
    `【预计总时长】${durLine}`,
    '【分段推进】',
    ...topSegments,
    count > 8 ? `…其余 ${count - 8} 段见下方分镜表` : ''
  ].filter(Boolean).join('\n');

  return { text, meta: { count, totalDuration, chars } };
}

function renderStoryOutline(project, segments = [], forceGenerated = false){
  latestOutlineProject = String(project || '').trim();
  latestOutlineSegments = Array.isArray(segments) ? segments.slice() : [];

  const { text, meta } = buildStoryOutline(latestOutlineProject, latestOutlineSegments);
  const draft = getStoryOutlineDraft(latestOutlineProject);
  const finalText = (!forceGenerated && draft.exists) ? draft.text : text;

  const box = q('storyOutline');
  if(box) box.value = finalText;

  if(forceGenerated){
    saveStoryOutlineDraft(latestOutlineProject, finalText);
  }

  const metaWrap = q('outlineMeta');
  if(metaWrap){
    const chips = [
      `<span class="outline-chip">分段：${meta.count} 段</span>`,
      `<span class="outline-chip">总时长：${meta.totalDuration > 0 ? `${meta.totalDuration}s` : '未标注'}</span>`,
      `<span class="outline-chip">角色：${meta.chars.length || 0}</span>`
    ];
    metaWrap.innerHTML = chips.join('');
  }
}

function regenerateStoryOutline(){
  renderStoryOutline(latestOutlineProject || getProject(), latestOutlineSegments || [], true);
  setStatus('故事大纲已重新生成');
}

function focusOutlineEditor(){
  const box = q('storyOutline');
  if(!box) return;
  box.focus();
  try {
    const len = String(box.value || '').length;
    box.setSelectionRange(len, len);
  } catch {}
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setStatus('已定位到故事大纲编辑区');
}

async function copyStoryOutline(){
  const box = q('storyOutline');
  if(!box) return;
  const text = String(box.value || '').trim();
  if(!text){
    setStatus('当前没有可复制的故事大纲', false);
    return;
  }

  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(text);
    } else {
      box.focus();
      box.select();
      document.execCommand('copy');
    }
    setStatus('故事大纲已复制到剪贴板');
  } catch (err) {
    setStatus(`复制失败：${err.message}`, false);
  }
}

function openOutlineZoom(){
  const src = q('storyOutline');
  const zoom = q('outlineZoom');
  const text = q('outlineZoomText');
  if(!src || !zoom || !text) return;
  text.value = String(src.value || '');
  zoom.classList.add('show');
}

function closeOutlineZoom(event, force=false){
  if(force || event?.target?.id === 'outlineZoom'){
    q('outlineZoom')?.classList.remove('show');
  }
}

async function copyOutlineZoomText(){
  const text = q('outlineZoomText');
  if(!text) return;
  const val = String(text.value || '').trim();
  if(!val){
    setStatus('当前没有可复制的故事大纲', false);
    return;
  }
  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(val);
    } else {
      text.focus();
      text.select();
      document.execCommand('copy');
    }
    setStatus('故事大纲已复制到剪贴板');
  } catch (err) {
    setStatus(`复制失败：${err.message}`, false);
  }
}

function hit(text, kws){
  const t = String(text || '');
  return kws.filter(k => t.includes(k)).length;
}

function scoreVideoRelevance(seg, videoMeta){
  // 启发式评分：先用剧情文本做规则打分（0-100）
  // 维度：场景一致(30) + 动作语义(45) + 人物关系(15) + 技术状态(10)
  const s = composeScript(seg);
  const sceneText = `${seg.scene || ''} ${seg.visual || ''}`;
  const dialogueText = `${seg.dialogue || ''}`;

  const sceneKw = ['码头','夜','雨','海','闪电'];
  const actionKw = ['举刀','受伤','血','瞳孔','看见','对峙','追','跌','拎起','挑起','转身'];
  const relationKw = ['苏甜','赫连城'];

  const sceneHits = Math.min(5, hit(sceneText, sceneKw));
  const actionHits = Math.min(6, hit(`${sceneText} ${dialogueText}`, actionKw));
  const relationHits = Math.min(2, hit(`${sceneText} ${dialogueText}`, relationKw));

  let score = 0;
  score += Math.round((sceneHits / 5) * 30);
  score += Math.round((actionHits / 6) * 45);
  score += Math.round((relationHits / 2) * 15);

  if(videoMeta && (videoMeta.videoUrl || (videoMeta.status || '').toLowerCase() === 'succeeded')) score += 10;
  else if(videoMeta && String(videoMeta.statusCode || '') === '200') score += 6;

  score = Math.max(0, Math.min(100, score));

  let level = '低';
  if(score >= 80) level = '高';
  else if(score >= 60) level = '中';

  const reasons = [
    `场景命中 ${sceneHits}/5`,
    `动作命中 ${actionHits}/6`,
    `人物命中 ${relationHits}/2`,
    `任务状态 ${videoMeta?.status || (videoMeta?.videoUrl ? 'ready' : 'unknown')}`
  ];

  return { score, level, reasons, script: s };
}

function projectPaths(project){
  return {
    segments: [
      `./${project}/planning/segments-flashback-s05-s07-6s-v2.json`,
      `./${project}/planning/segments-10s.json`,
      `./${project}/planning/segments-6s.json`
    ],
    prompts: [
      `./${project}/prompts/scene-image-prompts-6s.json`,
      `./${project}/prompts/scene-image-prompts-10s.json`
    ],
    bindings: [
      `./${project}/planning/scene-image-bindings-6s.json`,
      `./${project}/planning/scene-image-bindings-10s.json`
    ],
    images: [
      `./${project}/runs/image-jobs.jsonl`,
      `./${project}/runs/detail-image-jobs.jsonl`
    ],
    videos: [
      `./${project}/runs/video-jobs.jsonl`,
      `./${project}/runs/sora-batch-s02-s04-results.json`,
      `./${project}/runs/sora-batch-s02-s04-v2-results.json`,
      `./${project}/runs/sora-local-rerun-results.json`
    ]
  };
}

async function fetchFirstJson(urls){
  let lastErr = null;
  for(const url of urls || []){
    try {
      const data = await fetchJson(url);
      return { data, url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No JSON candidate found');
}

async function fetchFirstText(urls){
  let lastErr = null;
  for(const url of urls || []){
    try {
      const data = await fetchText(url);
      return { data, url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No text candidate found');
}

async function fetchJson(url){
  const r = await fetch(url + `?t=${Date.now()}`);
  if(!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
  return r.json();
}

async function fetchText(url){
  const r = await fetch(url + `?t=${Date.now()}`);
  if(!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
  return r.text();
}

function isUuidLike(v){
  const s = String(v || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function render(project, segments, promptMap, bindingMap, videoMap, multiShotMap = {}, videoPromptMap = {}, grid4ImageMap = {}){
  q('pageTitle').textContent = `${project}｜剧情分段与提示词预览`;
  const tbody = q('tbody');
  tbody.innerHTML = '';

  segments.forEach((seg, idx)=>{
    const sid = String(seg.segmentId || seg.id || `S${String(idx+1).padStart(2,'0')}`);
    const script = composeScript(seg);
    const imagePrompt = promptMap[sid] || defaultImagePrompt(seg);
    const videoPrompt = resolveVideoPrompt(sid, seg, videoPromptMap);
    const img = bindingMap[sid] || '';
    const multiShots = Array.isArray(multiShotMap[sid]) ? multiShotMap[sid] : [];
    const grid4 = grid4ImageMap[sid] || null;
    const vWrap = videoMap[sid] || { latest: {}, variants: [] };
    const v = vWrap.latest || {};

    let videoCell = '<span class="meta">暂无</span>';
    if(v.videoUrl){
      videoCell = `<a href="javascript:void(0)" data-video="${v.videoUrl}" data-sid="${sid}" class="video-link">在线预览</a><div class="meta">status: ${v.status || '-'} ｜ videoDraftId(UUID): ${isUuidLike(v.soraDraftId) ? v.soraDraftId : '-'}</div>`;
    }else if(v.videoId || v.taskId || v.status || v.statusCode || v.soraDraftId){
      videoCell = `<div class="meta">status: ${v.status || '-'} ｜ code: ${v.statusCode ?? '-'}</div><div class="meta">videoDraftId(UUID): ${isUuidLike(v.soraDraftId) ? v.soraDraftId : '-'}</div>`;
    }

    if(Array.isArray(vWrap.variants) && vWrap.variants.length){
      const rows = vWrap.variants.slice().reverse().slice(0, 8).map(x => {
        const links = [];
        if(x.videoUrl) links.push(`<a href="javascript:void(0)" data-video="${x.videoUrl}" data-sid="${sid}-${x.variant || 'video'}" class="video-link">本地</a>`);
        if(x.mediaUrl) links.push(`<a href="${x.mediaUrl}" target="_blank">Grok</a>`);
        if(x.hdVideoUrl) links.push(`<a href="${x.hdVideoUrl}" target="_blank">HD</a>`);
        if(x.thumbnailUrl) links.push(`<a href="${x.thumbnailUrl}" target="_blank">封面</a>`);
        return `<div class="meta" style="margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.12)"><div><b>${x.variant || 'variant'}</b> ｜ ${x.createdAt || '-'} ｜ ${x.status || 'unknown'}</div><div>${links.join(' ｜ ') || '无链接'}</div></div>`;
      }).join('');
      videoCell += `<div class="meta" style="margin-top:6px"><b>视频历史</b></div>${rows}`;
    }

    const qa = scoreVideoRelevance(seg, v);
    const scoreColor = qa.score >= 80 ? '#34d399' : (qa.score >= 60 ? '#fbbf24' : '#f87171');
    const qaCell = `<div style="font-weight:700;color:${scoreColor}">${qa.score} / 100（${qa.level}）</div><div class="meta">${qa.reasons.join('｜')}</div>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>
        <div class="meta">${sid}</div>
        <textarea>${script}</textarea>
      </td>
      <td>
        <div class="img-rule">强约束：9:16 竖版 + 严格遵循当前段 script + 禁止白底棚拍/纯人像/冲突背景。</div>
        <textarea>${imagePrompt}</textarea>
      </td>
      <td>${(() => {
        if(grid4 && grid4.url){
          return `
            <a href="javascript:void(0)" data-img="${grid4.url}" data-sid="${sid}-grid4" class="thumb-link"><img class="thumb" src="${grid4.url}" alt="${sid}-grid4"/></a>
            <div class="meta" style="margin-top:6px">模式：${grid4.mode || 'grid4'}</div>
          `;
        }
        if(multiShots.length){
          const shotHtml = multiShots.map(ms => `
            <div class="shot-item">
              <a href="javascript:void(0)" data-img="${ms.url}" data-sid="${ms.shotId || sid}" class="thumb-link shot-btn">
                <img class="shot-img" src="${ms.url}" alt="${ms.shotId || sid}" title="${ms.shotId || sid}"/>
              </a>
              <div class="shot-label">${ms.shotId || sid}</div>
            </div>
          `).join('');
          return `<div class="shot-grid">${shotHtml}</div><div class="meta" style="margin-top:6px">多分镜：${multiShots.length} 张</div>`;
        }
        if(img){
          return `<a href="javascript:void(0)" data-img="${img}" data-sid="${sid}" class="thumb-link"><img class="thumb" src="${img}" alt="${sid}"/></a>`;
        }
        return '<span class="meta">暂无</span>';
      })()}</td>
      <td><textarea>${videoPrompt}</textarea></td>
      <td>${durationLabel(seg)}</td>
      <td>${videoCell}</td>
      <td>${qaCell}</td>
    `;
    tbody.appendChild(tr);
  });

  // 绑定顶部人物设定图点击放大
  const characterLinks = [...document.querySelectorAll('#characterSection a.thumb-link')];
  if(characterLinks.length){
    const list = characterLinks.map((lnk, idx) => ({
      idx,
      url: String(lnk.getAttribute('data-img') || '').trim(),
      caption: String(lnk.getAttribute('data-sid') || `角色${idx+1}`).trim(),
    })).filter(x => x.url);
    characterLinks.forEach((a, idx) => {
      a.addEventListener('click', (e)=>{
        e?.preventDefault?.();
        e?.stopPropagation?.();
        const url = String(a.getAttribute('data-img') || '').trim();
        if(!url) return;
        const listIndex = list.findIndex(it => it.url === url && it.idx === idx);
        if(listIndex >= 0) openLightboxAt(list, listIndex);
        else openLightbox(url, String(a.getAttribute('data-sid') || url));
      });
    });
  }

  // 绑定缩略图点击放大（支持同一行左右切换）
  tbody.querySelectorAll('tr').forEach(tr => {
    const links = [...tr.querySelectorAll('a.thumb-link')];
    if(!links.length) return;
    const list = links.map((lnk, idx) => ({
      url: lnk.getAttribute('data-img') || '',
      caption: lnk.getAttribute('data-sid') || `#${idx+1}`,
    })).filter(x => x.url);

    links.forEach((a, idx) => {
      a.addEventListener('click', ()=>{
        openLightboxAt(list, idx);
      });
    });
  });

  // 绑定视频在线预览
  tbody.querySelectorAll('a.video-link').forEach(a=>{
    a.addEventListener('click', ()=>{
      const url = a.getAttribute('data-video') || '';
      const sid = a.getAttribute('data-sid') || '';
      openVideoBox(url, sid);
    });
  });

  setStatus(`已加载 ${project} ｜ segments: ${segments.length}`);
}

async function loadProject(project){
  if(!project) return setStatus('请先选择/输入项目目录', false);
  currentProjectName = String(project || '').trim();
  await loadGlobalCharacterLibrary(false);
  const p = projectPaths(project);

  try{
    const segRes = await fetchFirstJson(p.segments);
    const segments = normalizeSegments(segRes.data);
    const extraPreviewRows = await fetchExtraPreviewRows(project);
    const allSegments = [...segments, ...extraPreviewRows];

    let promptMap = {};
    try{
      const promptRes = await fetchFirstJson(p.prompts);
      promptMap = normalizePromptMap(promptRes.data);
    }catch{}

    let bindingMap = {};
    let detailShotMap = {};
    try{
      const bindRes = await fetchFirstJson(p.bindings);
      bindingMap = normalizeBindingMap(bindRes.data);
    }catch{}

    for(const candidate of (p.images || [])){
      try{
        if(candidate.endsWith('.jsonl')){
          const imageText = await fetchText(candidate);
          const rows = parseJsonl(imageText);
          bindingMap = { ...bindingMap, ...normalizeImageBindingMapFromRows(rows) };
          const detailMapPart = normalizeDetailShotMapFromRows(rows);
          for(const sid of Object.keys(detailMapPart)){
            if(!detailShotMap[sid]) detailShotMap[sid] = [];
            detailShotMap[sid].push(...detailMapPart[sid]);
          }
        } else {
          const raw = await fetchJson(candidate);
          const rows = Array.isArray(raw?.results) ? raw.results : (Array.isArray(raw) ? raw : []);
          if(rows.length){
            bindingMap = { ...bindingMap, ...normalizeImageBindingMapFromRows(rows) };
            const detailMapPart = normalizeDetailShotMapFromRows(rows);
            for(const sid of Object.keys(detailMapPart)){
              if(!detailShotMap[sid]) detailShotMap[sid] = [];
              detailShotMap[sid].push(...detailMapPart[sid]);
            }
          }
        }
      }catch{}
    }

    let videoMap = {};
    let videoPromptMap = {};
    for(const candidate of p.videos || []){
      try{
        if(candidate.endsWith('.jsonl')){
          const videoText = await fetchText(candidate);
          const rows = parseJsonl(videoText);
          videoMap = normalizeVideoMap(rows);
          videoPromptMap = mergeVideoPromptMap(videoPromptMap, normalizeVideoPromptMapFromRows(rows));
        } else {
          const raw = await fetchJson(candidate);
          const rows = Array.isArray(raw?.results) ? raw.results : (Array.isArray(raw) ? raw : []);
          if(rows.length){
            const normalized = normalizeVideoMap(rows);
            for(const sid of Object.keys(normalized)) videoMap[sid] = normalized[sid];
            videoPromptMap = mergeVideoPromptMap(videoPromptMap, normalizeVideoPromptMapFromRows(rows));
          }
        }
      }catch{}
    }

    const [multiShotMap, grid4ImageMap, planningVideoPromptMap, characters] = await Promise.all([
      fetchMultiShotMap(project, allSegments),
      fetchGrid4ImageMap(project, allSegments),
      fetchPlanningVideoPromptMap(project, allSegments),
      fetchCharacters(project)
    ]);
    videoPromptMap = mergeVideoPromptMap(videoPromptMap, planningVideoPromptMap);

    if(!allSegments.length) return setStatus(`项目 ${project} 的 segments 为空`, false);
    for(const sid of Object.keys(detailShotMap)){
      const seen = new Set();
      detailShotMap[sid] = detailShotMap[sid].filter(it => {
        const key = `${it.shotId}|${it.url}`;
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if(detailShotMap[sid].length){
        multiShotMap[sid] = detailShotMap[sid];
      }
    }

    for(const row of extraPreviewRows){
      const sid = row.segmentId;
      if(row.imagePrompt) {
        promptMap[sid] = row.imagePrompt;
      }
      if(row.imageUrl) {
        bindingMap[sid] = row.imageUrl;
      }
      if(row.videoPrompt) {
        videoPromptMap[sid] = { latest: row.videoPrompt, variants: [{ variant: 'extra-preview-row', durationSec: row.durationSec ?? null, createdAt: '', sourceFile: 'extra-preview-rows.json', prompt: row.videoPrompt }] };
      }
      if(row.videoUrl) {
        videoMap[sid] = {
          latest: {
            ok: true,
            statusCode: 200,
            status: 'completed',
            videoId: row.videoMeta?.videoId || '',
            taskId: row.videoMeta?.taskId || '',
            soraDraftId: '',
            videoUrl: row.videoUrl,
            mediaUrl: row.videoMeta?.mediaUrl || '',
            hdVideoUrl: row.videoMeta?.hdVideoUrl || '',
            thumbnailUrl: row.videoMeta?.thumbnailUrl || '',
            createdAt: row.videoMeta?.createdAt || '',
            variant: row.videoMeta?.variant || 'extra-preview-row'
          },
          variants: [{
            ok: true,
            statusCode: 200,
            status: 'completed',
            videoId: row.videoMeta?.videoId || '',
            taskId: row.videoMeta?.taskId || '',
            soraDraftId: '',
            videoUrl: row.videoUrl,
            mediaUrl: row.videoMeta?.mediaUrl || '',
            hdVideoUrl: row.videoMeta?.hdVideoUrl || '',
            thumbnailUrl: row.videoMeta?.thumbnailUrl || '',
            createdAt: row.videoMeta?.createdAt || '',
            variant: row.videoMeta?.variant || 'extra-preview-row'
          }]
        };
      }
    }

    const charDraft = getProjectCharactersDraft(project);
    const finalCharacters = charDraft.exists ? charDraft.chars : characters;

    renderCharacters(finalCharacters, project);
    renderStoryOutline(project, allSegments);
    render(project, allSegments, promptMap, bindingMap, videoMap, multiShotMap, videoPromptMap, grid4ImageMap);

    q('projectInput').value = project;
    q('projectSelect').value = project;

    const u = new URL(window.location.href);
    u.searchParams.set('project', project);
    history.replaceState(null, '', u.toString());
  }catch(err){
    // 即使项目资源加载失败，也要回填该项目已保存的大纲草稿
    renderStoryOutline(project, []);
    setStatus(`加载失败：${err.message}`, false);
  }
}

function getBridgeBase(){
  const cfg = getChatConfig();
  const base = String(cfg.base || 'http://127.0.0.1:12732').trim();
  return base.replace(/\/$/, '');
}

function saveProjectIndexLocal(names = []){
  try{
    const uniq = [...new Set((names || []).map(x => String(x || '').trim()).filter(Boolean))].sort();
    localStorage.setItem(PROJECT_INDEX_STORAGE_KEY, JSON.stringify({
      updatedAt: new Date().toISOString(),
      projects: uniq
    }));
    return uniq;
  } catch {
    return [];
  }
}

function readProjectIndexLocal(){
  try{
    const raw = localStorage.getItem(PROJECT_INDEX_STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : null;
    const arr = Array.isArray(data?.projects) ? data.projects : (Array.isArray(data) ? data : []);
    return [...new Set(arr.map(x => String(x || '').trim()).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

function fillProjectSelect(names = []){
  const sel = q('projectSelect');
  const current = getProject();
  sel.innerHTML = '';
  const uniq = [...new Set((names || []).map(x => String(x || '').trim()).filter(Boolean))].sort();
  if(!uniq.length) uniq.push(DEFAULT_PROJECT_FALLBACK);
  uniq.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  if(current && uniq.includes(current)) sel.value = current;
  return uniq;
}

function createProject(){
  const raw = String(q('projectInput')?.value || '').trim();
  if(!raw){
    setStatus('请先输入项目名，例如 episode-2-20260415-140000', false);
    return;
  }

  const project = raw.replace(/\s+/g, '-');
  const local = readProjectIndexLocal();
  const next = [...new Set([project, ...local])].sort();
  saveProjectIndexLocal(next);
  fillProjectSelect(next);
  q('projectInput').value = project;
  q('projectSelect').value = project;

  // 新建后先渲染空态大纲，允许用户直接编辑并自动保存
  currentProjectName = project;
  latestOutlineProject = project;
  latestOutlineSegments = [];
  renderStoryOutline(project, []);
  setStatus(`已新建项目：${project}（本地）`);
}

async function discoverProjects(options = {}){
  const forceRefresh = !!options.forceRefresh;
  const bridgeBase = getBridgeBase();

  try{
    const route = forceRefresh ? '/api/projects?refresh=1' : '/api/projects';
    const data = await fetchJson(`${bridgeBase}${route}`);
    const names = Array.isArray(data?.projects) ? data.projects : [];
    const uniq = fillProjectSelect(names);
    saveProjectIndexLocal(uniq);
    setStatus(`已从本地项目索引加载：${uniq.length} 个（${data?.source || 'api'}）`);
    return uniq;
  } catch (err) {
    const local = readProjectIndexLocal();
    if(local.length){
      const uniq = fillProjectSelect(local);
      setStatus(`项目索引接口不可用，已使用本地缓存：${uniq.length} 个（${err.message}）`, false);
      return uniq;
    }

    try{
      const html = await (await fetch('./?t=' + Date.now())).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const names = [...doc.querySelectorAll('a')]
        .map(a => (a.getAttribute('href') || '').replace(/\/$/, ''))
        .filter(h => !h.startsWith('.') && !h.includes('/') && /^(episode-|cat-|trenchcoat-|opc-|auto-selection-)/i.test(h));
      const uniq = fillProjectSelect(names);
      saveProjectIndexLocal(uniq);
      setStatus(`项目索引接口不可用，已回退目录解析：${uniq.length} 个`, false);
      return uniq;
    } catch (err2) {
      const uniq = fillProjectSelect([DEFAULT_PROJECT_FALLBACK]);
      setStatus(`项目发现失败，已回退默认值：${err2.message}`, false);
      return uniq;
    }
  }
}

async function rebuildProjectIndex(){
  const bridgeBase = getBridgeBase();
  try{
    setStatus('正在重建项目索引...');
    await fetchJson(`${bridgeBase}/api/projects/rebuild?t=${Date.now()}`);
    await discoverProjects({ forceRefresh: true });
  } catch (err) {
    setStatus(`重建项目索引失败：${err.message}`, false);
  }
}

function loadCurrentProject(){ loadProject(getProject()); }

function openJson(kind){
  const project = getProject();
  if(!project) return;
  const p = projectPaths(project);
  const url = p[kind];
  if(url) window.open(url, '_blank');
}

document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){
    closeOutlineZoom({target:{id:'outlineZoom'}}, true);
    closeLightbox({target:{id:'lightbox'}}, true);
    closeVideoBox({target:{id:'videobox'}}, true);
  }
  if(q('lightbox').classList.contains('show')){
    if(e.key === 'ArrowLeft') lightboxPrev(e);
    if(e.key === 'ArrowRight') lightboxNext(e);
  }
});

(function init(){
  fillChatConfigUi();
  loadChat();
  renderChat();
  refreshEditModeUi();

  const outlineBox = q('storyOutline');
  if(outlineBox){
    const persistOutlineDraft = ()=>{
      const p = latestOutlineProject || getProject();
      saveStoryOutlineDraft(p, outlineBox.value || '');
    };
    outlineBox.addEventListener('input', persistOutlineDraft);
    outlineBox.addEventListener('change', persistOutlineDraft);
    window.addEventListener('beforeunload', persistOutlineDraft);
  }

  const chatInput = q('chatInput');
  if(chatInput){
    chatInput.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter' && !e.shiftKey){
        e.preventDefault();
        sendChat();
      }
    });
  }

  discoverProjects().then(()=>{
    const fromQuery = new URL(window.location.href).searchParams.get('project');
    const pick = fromQuery || q('projectSelect').value || 'episode-1-20260320-113900';
    q('projectInput').value = pick;
    loadProject(pick);
  });
})();
