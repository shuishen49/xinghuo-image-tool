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
      r.local_url || r.hdVideoUrl || r.remoteVideoUrl || r.remote_video_url || r.mediaUrl || r.media_url ||
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
let segmentTaskRunning = false;
let outlineAutosaveBound = false;
let outlineAutosaveTimer = null;

function setSegmentTaskStatus(text = '', state = 'idle'){
  const el = q('segmentTaskStatus');
  if(!el) return;
  el.textContent = `任务状态：${text || '空闲'}`;
  el.className = 'segment-task-status';
  if(state === 'running') el.classList.add('running');
  else if(state === 'ok') el.classList.add('ok');
  else if(state === 'err') el.classList.add('err');
}

function setSegmentTaskButtonState(running = false){
  const btn = q('segmentTaskBtn');
  if(!btn) return;
  btn.disabled = !!running;
  btn.textContent = running ? '分段任务进行中…' : '一键剧情分段';
}

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

  setupOutlineAutosave();
}

// 自动保存：用户手动编辑故事大纲时，把内容写入草稿(localStorage)，
// 避免修改后未保存、下次打开变空白。只绑定一次。
function setupOutlineAutosave(){
  if(outlineAutosaveBound) return;
  const box = q('storyOutline');
  if(!box) return;
  outlineAutosaveBound = true;

  box.addEventListener('input', () => {
    if(outlineAutosaveTimer) clearTimeout(outlineAutosaveTimer);
    outlineAutosaveTimer = setTimeout(() => {
      const project = latestOutlineProject || getProject();
      saveStoryOutlineDraft(project, box.value);
    }, 400);
  });

  // 放大编辑弹窗：编辑时同步写回主文本框并保存草稿，保持两处一致。
  const zoomBox = q('outlineZoomText');
  if(zoomBox){
    zoomBox.addEventListener('input', () => {
      box.value = zoomBox.value;
      if(outlineAutosaveTimer) clearTimeout(outlineAutosaveTimer);
      outlineAutosaveTimer = setTimeout(() => {
        const project = latestOutlineProject || getProject();
        saveStoryOutlineDraft(project, box.value);
      }, 400);
    });
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

// Find every balanced {...} or [...] block in a string (handles strings/escapes).
function findJsonCandidates(raw){
  const out = [];
  for(let i = 0; i < raw.length; i++){
    const open = raw[i];
    if(open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for(let j = i; j < raw.length; j++){
      const ch = raw[j];
      if(inStr){
        if(esc){ esc = false; }
        else if(ch === '\\'){ esc = true; }
        else if(ch === '"'){ inStr = false; }
        continue;
      }
      if(ch === '"'){ inStr = true; continue; }
      if(ch === open) depth++;
      else if(ch === close){
        depth--;
        if(depth === 0){ out.push(raw.slice(i, j + 1)); break; }
      }
    }
  }
  return out;
}

// Coerce various shapes into { segments: [...] }.
function coerceSegmentsObject(obj){
  if(!obj || typeof obj !== 'object') return null;
  if(Array.isArray(obj)) return { segments: obj };
  if(Array.isArray(obj.segments)) return obj;
  if(Array.isArray(obj.data?.segments)) return { segments: obj.data.segments };
  if(Array.isArray(obj.result?.segments)) return { segments: obj.result.segments };
  if(Array.isArray(obj.list)) return { segments: obj.list };
  if(Array.isArray(obj.rows)) return { segments: obj.rows };
  return null;
}

function extractSegmentsJsonFromText(text=''){
  const raw = String(text || '').trim();
  if(!raw) return null;

  // 1) ```json ... ``` fenced blocks (or plain ``` ... ```)
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for(const m of fences){
    try {
      const obj = coerceSegmentsObject(JSON.parse(String(m[1] || '').trim()));
      if(obj?.segments?.length) return obj;
    } catch {}
  }

  // 2) Every balanced {...} / [...] candidate, largest first.
  const candidates = findJsonCandidates(raw).sort((a, b) => b.length - a.length);
  for(const c of candidates){
    try {
      const obj = coerceSegmentsObject(JSON.parse(c));
      if(obj?.segments?.length) return obj;
    } catch {}
  }

  // 3) Loose repair: strip trailing commas, smart quotes, then retry largest.
  for(const c of candidates){
    const repaired = c
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
    try {
      const obj = coerceSegmentsObject(JSON.parse(repaired));
      if(obj?.segments?.length) return obj;
    } catch {}
  }

  // 4) Last resort: parse the human-readable list into segments.
  const fromText = parseSegmentsFromReadableText(raw);
  if(fromText?.segments?.length) return fromText;

  return null;
}

// Fallback: parse a numbered/structured readable list into segments.
// Recognises lines like: "S01 | 5秒 | 短剧情 | 画面... | 动作... | 台词..."
// or markdown / labelled blocks with 段号/时长/类型/画面/动作/台词.
function parseSegmentsFromReadableText(raw){
  const segments = [];
  // Split into blocks by segment id markers (S01, S1, 第1段, 镜头1, etc.)
  const blocks = raw.split(/\n(?=\s*(?:S\d+|第\s*\d+\s*段|镜头\s*\d+|片段\s*\d+)\b)/i);
  let idx = 0;
  for(const block of blocks){
    const b = block.trim();
    if(!b) continue;
    const idMatch = b.match(/\b(S\d{1,3})\b/i) || b.match(/第\s*(\d+)\s*段/) || b.match(/镜头\s*(\d+)/);
    const durMatch = b.match(/(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i);
    const typeMatch = b.match(/(长对话|短剧情|对话|剧情|动作)/);
    const dialogueMatch = b.match(/台词[：:]\s*([^\n]+)/);
    const sceneMatch = b.match(/(?:画面|场景)[：:]\s*([^\n]+)/);
    const actionMatch = b.match(/(?:动作|角色动作)[：:]\s*([^\n]+)/);
    if(!idMatch && !durMatch && !sceneMatch && !dialogueMatch) continue;
    idx++;
    const sid = idMatch
      ? (/^S/i.test(idMatch[1]||idMatch[0]) ? String(idMatch[1]||idMatch[0]).toUpperCase() : `S${String(idMatch[1]).padStart(2,'0')}`)
      : `S${String(idx).padStart(2,'0')}`;
    segments.push({
      id: sid,
      segmentId: sid,
      durationSec: durMatch ? Number(durMatch[1]) : undefined,
      type: typeMatch ? typeMatch[1] : '',
      scene: sceneMatch ? sceneMatch[1].trim() : '',
      action: actionMatch ? actionMatch[1].trim() : '',
      dialogue: dialogueMatch ? dialogueMatch[1].trim() : '',
    });
  }
  return segments.length ? { segments } : null;
}

async function oneClickSegmentStory(){
  if(segmentTaskRunning){
    setStatus('已有分段任务在执行，请等待完成后再点击', false);
    setSegmentTaskStatus('已有任务在执行，请稍候…', 'running');
    return;
  }

  const box = q('storyOutline');
  if(!box) return;

  const outlineText = String(box.value || '').trim();
  if(!outlineText){
    setStatus('当前没有可分段的故事大纲', false);
    return;
  }

  if(typeof requestChatCompletion !== 'function'){
    setStatus('分段失败：聊天能力未就绪（requestChatCompletion 缺失）', false);
    return;
  }

  const project = latestOutlineProject || getProject();
  const sysRules = [
    '你是短视频剧情分段助手。把输入大纲拆成可执行分镜段落。',
    '时长约束：长对话段单段≤10秒；短剧情动作段单段≤5秒；不得超限。',
    '',
    '【输出要求 · 非常重要】',
    '只输出一个 JSON 对象，不要输出任何解释、标题、寒暄、markdown 代码块标记。',
    '第一个字符必须是 {，最后一个字符必须是 }。',
    '',
    'JSON 结构固定如下（segments 至少 1 项）：',
    '{"segments":[{"id":"S01","durationSec":5,"type":"短剧情","scene":"画面内容","action":"角色动作","dialogue":"台词，可为空字符串"}]}',
    '',
    '字段说明：id 从 S01 递增；durationSec 为整数秒；type 取“长对话”或“短剧情”；scene/action 必填；dialogue 可为空字符串。',
  ].join('\n');

  const prompt = `${sysRules}\n\n【项目】${project || '未命名项目'}\n【待分段大纲】\n${outlineText}\n\n现在只输出 JSON：`;

  try {
    segmentTaskRunning = true;
    setSegmentTaskButtonState(true);
    setStatus('正在进行 AI 一键剧情分段...');
    setSegmentTaskStatus('正在进行 AI 一键剧情分段...', 'running');
    if(typeof setChatStatus === 'function') setChatStatus('AI 正在按 10s/5s 规则分段...');

    const reply = await requestChatCompletion(prompt);
    const text = String(reply || '').trim();
    console.log('[segment] AI raw reply length=', text.length, '\n', text);

    if(!text){
      setStatus('分段失败：AI 返回空内容（可能流式未拼接到内容）', false);
      setSegmentTaskStatus('分段失败：AI 返回空内容', 'err');
      return;
    }

    const parsed = extractSegmentsJsonFromText(text);
    if(!parsed || !parsed.segments){
      // AI returned text but no parseable JSON — show it in chat so user can see + retry
      console.warn('[segment] no JSON found. raw reply:\n', text);
      addChat('bot', `分段未能自动解析。AI 原始返回如下，可点「🔄 重新发送」再试：\n\n${text}`, { isError: true });
      const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
      setStatus(`分段失败：未找到 JSON 分段数据。返回预览：${preview}`, false);
      setSegmentTaskStatus('分段失败：未找到 JSON 分段数据（已在右侧显示原文）', 'err');
      if(typeof setChatStatus === 'function') setChatStatus('AI 未按 JSON 格式返回，已显示原文，可重试。', false);
      return;
    }
    if(!parsed.segments.length){
      setStatus('分段失败：AI 返回的分段列表为空', false);
      setSegmentTaskStatus('分段失败：段数为 0', 'err');
      return;
    }
    let applied = false;
    if(typeof applyManualSegmentsToPreviewRows === 'function'){
      applied = !!applyManualSegmentsToPreviewRows(parsed.segments);
    } else {
      setStatus('分段失败：渲染模块未加载（applyManualSegmentsToPreviewRows 缺失）', false);
      setSegmentTaskStatus('分段失败：渲染上下文缺失', 'err');
      return;
    }
    if(!applied){
      // Try one more time with explicit render call
      const segs = normalizeSegments(parsed.segments);
      if(segs && segs.length){
        const project = latestOutlineProject || getProject() || 'manual-segments';
        setProjectManualSegments(project, segs);
        if(typeof render === 'function'){
          render(project, segs, {}, {}, {}, {}, {}, {});
          applied = true;
        }
      }
    }
    if(!applied){
      throw new Error('分段已生成但渲染失败：请尝试刷新页面后重新点击"一键剧情分段"');
    }

    const count = parsed.segments.length;
    const countLabel = `${count} 段`;
    setStatus(`剧情分段已写入下方表格（${countLabel}，规则：长对话≤10s，短剧情≤5s）。故事大纲未改动。`);
    setSegmentTaskStatus(`已完成（${countLabel}，已写入下方表格）`, 'ok');
    if(typeof setChatStatus === 'function') setChatStatus('剧情分段已完成（仅更新下方表格）。', true);
  } catch (err) {
    const msg = `一键剧情分段失败：${err?.message || err}`;
    setStatus(msg, false);
    setSegmentTaskStatus(msg, 'err');
    if(typeof setChatStatus === 'function') setChatStatus(msg, false);
  } finally {
    segmentTaskRunning = false;
    setSegmentTaskButtonState(false);
  }
}

// 兼容旧按钮名：复制大纲 -> 一键剧情分段
async function copyStoryOutline(){
  return oneClickSegmentStory();
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

