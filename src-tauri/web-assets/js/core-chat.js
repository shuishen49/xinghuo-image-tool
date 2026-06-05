const STRICT_RULE = '分镜图，必须9:16竖版。严格遵循 script 内的当前段场景地点、时间、动作与情绪，不得替换成其他地点。人物必须与参考图一致且必须出镜，画面要体现人物关系与动作叙事。禁止纯人物立绘、禁止白底棚拍、禁止与 script 冲突的背景。镜头语言电影写实，构图清晰，叙事明确。 Framing constraint: output composition must strictly use 9:16 (vertical portrait). Do not use any aspect ratio other than 9:16. Do not produce square framing.';
const VIDEO_STYLE_RULE = '黑白线条为主的 meme 漫画风 / 萌系手绘表情包风，少量青蓝点缀，夸张表情，清晰动作节奏，统一角色画风与镜头风格。';

let currentLightboxUrl = '';
let currentLightboxList = [];
let currentLightboxIndex = 0;
let currentVideoUrl = '';
let vbTimeSyncTimer = null;

const CHAT_STORAGE_KEY = 'grok_storyboard_chat_history_v1';
const CHAT_CONFIG_KEY = 'grok_storyboard_chat_config_v2';
const CHAT_PANE_COLLAPSED_KEY = 'grok_storyboard_chat_pane_collapsed_v1';
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
let chatAbortController = null;
let outlineAutoApplyEnabled = true;
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
  // Chat now goes through the embedded gateway (origin) which forwards to
  // the configured sub2api upstream. No external bridge needed.
  try { return location.origin.replace(/\/$/, ''); } catch { return 'http://127.0.0.1:12733'; }
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
  let normalizedModel = String(model || '').trim() || 'gpt-5.5';

  // Gateway forwards to the configured sub2api upstream; the Rust-side
  // chatBackend settings override the model. No lobster/provider remapping.

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
    if(btn && !chatSending) btn.textContent = '发送';
    return;
  }

  if(title) title.textContent = '大纲修改助手（已接本地 bridge）';
  if(sub) sub.textContent = outlineAutoApplyEnabled
    ? '这里专门用于“修改故事大纲”。你提要求，我来改左侧大纲并自动写入。'
    : '当前是聊天模式：不会写入左侧大纲，只进行对话。';
  if(input) input.placeholder = outlineAutoApplyEnabled
    ? '输入大纲修改要求，按 Enter 提交（Shift+Enter 换行）'
    : '输入聊天内容（仅对话，不写入大纲）';
  if(btn && !chatSending) btn.textContent = '发送';
}

function switchToOutlineMode(){
  editMode = 'outline';
  outlineAutoApplyEnabled = true;
  refreshEditModeUi();
  setStatus('已切换到：修改大纲');
}

function switchToCharacterMode(){
  editMode = 'character';
  refreshEditModeUi();
  setStatus('已切换到：修改角色');
  openAddGlobalCharacterMenu();
}

function skipOutlineEdit(){
  const input = q('chatInput');
  if(input) input.value = '';
  outlineAutoApplyEnabled = false;
  if(chatAbortController){
    try { chatAbortController.abort('user-cancel-outline-edit'); } catch {}
  }
  refreshEditModeUi();
  setChatStatus('已切换为聊天模式：后续发送都不会写入左侧大纲。', true);
  setStatus('已切换为纯聊天模式（不改大纲）');
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
  const box = q('chatMessages');
  if(btn){
    btn.disabled = chatSending;
    if(chatSending){
      btn.textContent = '思考中…';
    } else {
      btn.textContent = '发送';
    }
  }
  if(input) input.disabled = chatSending;
  // Thinking animation: insert/remove a loading indicator in the chat area
  if(box){
    let thinkEl = box.querySelector('.msg.thinking');
    if(chatSending){
      if(!thinkEl){
        thinkEl = document.createElement('div');
        thinkEl.className = 'msg bot thinking';
        thinkEl.innerHTML = '<div class="md-content"><div class="think-dots"><span></span><span></span><span></span></div><p style="color:var(--muted);font-size:13px;">思考中…</p></div>';
        box.appendChild(thinkEl);
      }
    } else {
      if(thinkEl) thinkEl.remove();
    }
  }
  if(box) box.scrollTop = box.scrollHeight;
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

  const chatOnlyMode = isChatOnlyMode();
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
    : (chatOnlyMode
      ? [
          '你是对话助手。',
          `当前项目：${project}。`,
          '当前处于纯聊天模式：禁止输出 [OUTLINE_UPDATE]，也不要改写/重写故事大纲。',
          '用户发什么，你就正常对话回答。',
          '若用户想恢复大纲修改，请提示点击“修改大纲”按钮。',
          '当前左侧故事大纲如下（仅供参考，不要改写）：',
          currentOutline,
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
        ].join('\n'));

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

function isChatOnlyMode(){
  return editMode === 'outline' && !outlineAutoApplyEnabled;
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

async function doChatRequest(url, body, headers, signal){
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
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

async function requestChatCompletion(userText, options = {}){
  const cfg = getChatConfig();
  const primaryUrl = buildChatApiUrl();
  if(!primaryUrl) throw new Error('未找到聊天接口 URL。');

  const preferredModel = String(options?.preferredModel || '').trim();
  const fallbackModel = String(options?.fallbackModel || cfg.model || 'custom-154-12-46-107/gpt-5.4').trim();
  const primaryModel = preferredModel || fallbackModel;
  const messages = Array.isArray(options?.messages) ? options.messages : buildChatMessages(userText);
  const body = {
    model: primaryModel,
    messages,
    temperature: Number.isFinite(options?.temperature) ? options.temperature : 0.7,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  if(cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const signal = options?.signal;

  try {
    return await doChatRequest(primaryUrl, body, headers, signal);
  } catch (err) {
    if(signal?.aborted || String(err?.name || '').toLowerCase() === 'aborterror') throw err;
    const base = normalizeBaseUrl(cfg.base || getDefaultChatBase());
    const currentPath = normalizeApiPath(cfg.path || DEFAULT_CHAT_PATH);
    const isDefaultBase = base === getDefaultChatBase();
    const hasAbsolutePath = /^https?:\/\//i.test(currentPath);
    const errMsg = String(err?.message || '');
    const shouldFallbackModel = !!preferredModel && (
      isLikelyServiceUnavailable(errMsg) ||
      isLikelyNotFoundError(errMsg) ||
      /model/i.test(errMsg)
    );

    // Fallback 1: model not available — retry with fallback model.
    if(shouldFallbackModel && fallbackModel && fallbackModel !== primaryModel){
      const reply = await doChatRequest(primaryUrl, { ...body, model: fallbackModel }, headers, signal);
      setChatStatus(`model ${primaryModel} unavailable, fell back to ${fallbackModel}`, true);
      return reply;
    }

    // Fallback 2: path error — retry with default /v1/chat/completions.
    const needFallback = isDefaultBase && !hasAbsolutePath && currentPath !== DEFAULT_CHAT_PATH && isLikelyNotFoundError(errMsg);
    if(!needFallback) throw err;

    const fallbackUrl = `${base}${DEFAULT_CHAT_PATH}`;
    const retryBody = shouldFallbackModel && fallbackModel && fallbackModel !== primaryModel
      ? { ...body, model: fallbackModel }
      : body;
    const reply = await doChatRequest(fallbackUrl, retryBody, headers, signal);
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

function readChatPaneCollapsed(){
  try {
    const raw = localStorage.getItem(CHAT_PANE_COLLAPSED_KEY);
    // 默认优先展开，避免历史缓存把布局误打成折叠态
    return raw === '1';
  } catch {
    return false;
  }
}

function writeChatPaneCollapsed(collapsed){
  try { localStorage.setItem(CHAT_PANE_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
}

function applyChatPaneCollapsedState(collapsed){
  const pane = q('chatPane');
  const dock = q('chatPaneDockBtn');
  const toggle = q('chatPaneToggleBtn');
  if(pane) pane.classList.toggle('chat-pane-hidden', !!collapsed);
  document.body.classList.toggle('chat-pane-collapsed', !!collapsed);
  if(toggle){
    toggle.textContent = collapsed ? '显示' : '隐藏';
    toggle.setAttribute('aria-label', collapsed ? '显示修改助手面板' : '隐藏修改助手面板');
  }
  if(dock) dock.style.display = collapsed ? 'inline-flex' : 'none';
}

function toggleChatPane(force){
  const next = typeof force === 'boolean' ? force : !readChatPaneCollapsed();
  writeChatPaneCollapsed(next);
  applyChatPaneCollapsedState(next);
}

function renderChat(){
  const box = q('chatMessages');
  if(!box) return;
  if(!chatHistory.length){
    box.innerHTML = '<div class="msg bot"><div class="md-content"><p>已就绪。点发送会真的请求聊天接口。</p></div></div>';
    return;
  }
  box.innerHTML = chatHistory.map((m, idx) => {
    const isUser = m.role === 'user';
    const body = isUser ? escapeHtml(m.text) : markdownToHtml(m.text);
    const isLast = idx === chatHistory.length - 1;
    let extra = '';
    if (!isUser && m.isError && isLast) {
      extra = `<div class="chat-retry-row"><button class="chat-retry-btn" onclick="window.__chatRetryLast()">🔄 重新发送</button></div>`;
    }
    return `<div class="msg ${isUser ? 'user' : 'bot'}">${isUser ? body : `<div class="md-content">${body}</div>`}${extra}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

window.__chatRetryLast = function(){
  // Find last user message and re-send it
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].role === 'user') {
      const txt = chatHistory[i].text;
      // Remove the failed bot reply
      if (chatHistory[chatHistory.length - 1].isError) chatHistory.pop();
      saveChat();
      // Trigger re-send
      const input = q('chatInput');
      if (input) {
        input.value = txt;
        // Use setTimeout to let the DOM settle
        setTimeout(() => {
          if (typeof sendChat === 'function') sendChat();
        }, 50);
      }
      return;
    }
  }
};

function addChat(role, text, opts = {}){
  const t = String(text || '').trim();
  if(!t) return;
  chatHistory.push({ role, text: t, ts: Date.now(), isError: !!opts.isError });
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
  const controller = new AbortController();
  chatAbortController = controller;
  try {
    const reply = await requestChatCompletion(text, { signal: controller.signal });
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
      const parsed = splitReplyForOutline(replyText, outlineAutoApplyEnabled);
      addChat('bot', parsed.chatText || replyText);
      if(!outlineAutoApplyEnabled){
        setChatStatus('聊天模式：本次回复未写入左侧大纲。', true);
      } else if(parsed.outlineText){
        const ok = writeLastBotToOutline('replace', parsed.outlineText);
        if(ok) setChatStatus('修改成功，左侧故事大纲已更新。', true);
        else setChatStatus('修改完成，但写入失败。', false);
      } else {
        setChatStatus('修改完成，但未解析到大纲内容。', false);
      }
    }
  } catch (err) {
    const aborted = controller.signal.aborted || String(err?.name || '').toLowerCase() === 'aborterror';
    if(aborted){
      setChatStatus('已取消本次请求。', true);
    } else {
      const msg = `${editMode === 'character' ? '角色修改' : '大纲修改'}失败：${err?.message || err}`;
      addChat('bot', msg, { isError: true });
      setChatStatus(msg, false);
    }
  } finally {
    if(chatAbortController === controller) chatAbortController = null;
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

function formatVideoTime(sec){
  const t = Number.isFinite(sec) && sec >= 0 ? sec : 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function syncVideoSeekUI(){
  const v = q('vbVideo');
  const seek = q('vbSeek');
  const timeEl = q('vbTime');
  if(!v || !seek || !timeEl) return;
  const dur = Number.isFinite(v.duration) ? v.duration : 0;
  const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
  if(dur > 0){
    seek.max = String(dur);
    seek.value = String(Math.min(dur, cur));
  } else {
    seek.max = '1000';
    seek.value = '0';
  }
  timeEl.textContent = `${formatVideoTime(cur)} / ${formatVideoTime(dur)}`;
}

function bindVideoFrameTools(){
  const v = q('vbVideo');
  if(!v) return;
  ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'seeked'].forEach(evt => {
    v.addEventListener(evt, syncVideoSeekUI);
  });
  if(vbTimeSyncTimer) clearInterval(vbTimeSyncTimer);
  vbTimeSyncTimer = setInterval(syncVideoSeekUI, 250);
  syncVideoSeekUI();
}

function scrubVideo(e){
  e?.stopPropagation?.();
  const v = q('vbVideo');
  const seek = q('vbSeek');
  if(!v || !seek) return;
  const target = Number(seek.value || 0);
  if(Number.isFinite(target) && target >= 0){
    v.currentTime = target;
  }
  syncVideoSeekUI();
}

async function captureVideoFrame(e){
  e?.stopPropagation?.();
  const v = q('vbVideo');
  if(!v) return;
  if(!v.videoWidth || !v.videoHeight){
    alert('视频尚未就绪，请稍后重试');
    return;
  }

  const stamp = Date.now();
  const cap = (q('vbCap')?.textContent || 'video-frame').replace(/[^\w\-]+/g, '_').slice(0, 48);
  const filename = `${cap}-${Math.round(v.currentTime * 1000)}ms-${stamp}.png`;

  const downloadBlob = (blob) => {
    if(!blob) return false;
    const a = document.createElement('a');
    const blobUrl = URL.createObjectURL(blob);
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(blobUrl), 1500);
    return true;
  };

  // 1) 优先本地 canvas 截帧（同源视频可直接成功；远程视频如果浏览器缓存允许，也能直接成功）
  const tryCanvasCapture = () => new Promise((resolve, reject) => {
    try{
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((blob)=>{
        if(!blob){
          reject(new Error('canvas_toBlob_empty'));
          return;
        }
        downloadBlob(blob);
        resolve(true);
      }, 'image/png');
    }catch(err){
      reject(err);
    }
  });

  try{
    await tryCanvasCapture();
    return;
  }catch(err){
    console.warn('captureVideoFrame canvas blocked, fallback to server:', err);
  }

  // 2) 不再走后端远程下载兜底：避免用户本地已能播放时，截帧又触发远程下载超时。
  //    现在截帧只使用当前浏览器 <video> 画面进 canvas。若远程视频无 CORS，浏览器会禁止导出像素，这是浏览器安全限制。
  const srcUrl = String(currentVideoUrl || v.currentSrc || v.getAttribute('src') || '').trim();
  const isRemote = /^https?:\/\//i.test(srcUrl) && !srcUrl.startsWith(window.location.origin);
  if(isRemote){
    alert('截帧失败：当前视频是远程跨域地址，浏览器允许播放但禁止把画面导出到 canvas。已停止后端远程下载兜底；请先点“下载到本地/本地预览”，或重新生成时确保视频保存到本地 generated 后再截帧。');
  } else {
    alert('截帧失败：当前视频画面无法写入 canvas，请确认视频已加载完成后再试。');
  }
}

function openVideoBox(url, caption=''){
  if(!url) return;
  currentVideoUrl = url;
  const v = q('vbVideo');
  v.src = url;
  q('vbCap').textContent = caption || url;
  q('videobox').classList.add('show');
  bindVideoFrameTools();
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
    if(vbTimeSyncTimer){
      clearInterval(vbTimeSyncTimer);
      vbTimeSyncTimer = null;
    }
    syncVideoSeekUI();
    currentVideoUrl = '';
  }
}

window.toggleChatPane = toggleChatPane;
window.skipOutlineEdit = skipOutlineEdit;

(function initChatPaneCollapse(){
  applyChatPaneCollapsedState(readChatPaneCollapsed());
})();

