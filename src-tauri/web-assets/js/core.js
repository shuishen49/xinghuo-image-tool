(function(){
  const STRICT_RULE = '分镜图，必须9:16竖版。严格遵循 script 内的当前段场景地点、时间、动作与情绪，不得替换成其他地点。人物必须与参考图一致且必须出镜，画面要体现人物关系与动作叙事。禁止纯人物立绘、禁止白底棚拍、禁止与 script 冲突的背景。镜头语言电影写实，构图清晰，叙事明确。 Framing constraint: output composition must strictly use 9:16 (vertical portrait). Do not use any aspect ratio other than 9:16. Do not produce square framing.';
  const VIDEO_STYLE_RULE = '黑白线条为主的 meme 漫画风 / 萌系手绘表情包风，少量青蓝点缀，夸张表情，清晰动作节奏，统一角色画风与镜头风格。';

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

  function saveChat(chatHistory){
    try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory)); } catch {}
  }

  function getQueryParam(name){
    try { return new URLSearchParams(location.search).get(name) || ''; } catch { return ''; }
  }

  function getDefaultChatBase(){
    // Embedded gateway serves everything from one origin.
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

    // Gateway forwards to configured sub2api upstream; no lobster remapping.

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

  window.__previewCore = {
    STRICT_RULE,
    VIDEO_STYLE_RULE,
    CHAT_STORAGE_KEY,
    CHAT_CONFIG_KEY,
    DEFAULT_CHAT_PATH,
    STORY_OUTLINE_DRAFT_KEY,
    PROJECT_CHARACTERS_DRAFT_KEY,
    PROJECT_CHARACTER_IMAGE_OVERRIDES_KEY,
    PROJECT_INDEX_STORAGE_KEY,
    CHARACTER_LIBRARY_STORAGE_KEY,
    PROJECT_CHARACTER_OVERRIDE_KEY,
    DEFAULT_PROJECT_FALLBACK,
    q,
    setStatus,
    getProject,
    escapeHtml,
    parseInlineMarkdown,
    sanitizeRenderedMarkdown,
    markdownToHtml,
    saveChat,
    getQueryParam,
    getDefaultChatBase,
    isLikelyNotFoundError,
    isLikelyServiceUnavailable,
    normalizeBaseUrl,
    normalizeApiPath,
    getChatConfig,
    saveChatConfig,
    resetChatConfig,
    fillChatConfigUi,
    setChatStatus,
  };
})();
