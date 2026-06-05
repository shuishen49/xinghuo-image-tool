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

