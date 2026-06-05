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

function extractSegmentsJsonFromText(text=''){
  const raw = String(text || '').trim();
  if(!raw) return null;

  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if(fenced && fenced[1]){
    try {
      const obj = JSON.parse(fenced[1].trim());
      if(Array.isArray(obj?.segments)) return obj;
    } catch {}
  }

  const starts = [];
  for(let i = 0; i < raw.length; i++) if(raw[i] === '{') starts.push(i);
  for(let i = starts.length - 1; i >= 0; i--){
    const part = raw.slice(starts[i]).trim();
    try {
      const obj = JSON.parse(part);
      if(Array.isArray(obj?.segments)) return obj;
    } catch {}
  }
  return null;
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
    '你是短视频剧情分段助手。',
    '请把输入大纲拆成可执行分镜段落，并严格按时长约束：',
    '1) 长对话段：单段最长 10 秒。',
    '2) 短剧情动作段：单段最长 5 秒。',
    '3) 不能出现超过上限的段落。',
    '4) 每段必须包含：段号、时长(秒)、类型(长对话/短剧情)、画面内容、角色动作、台词(可空)。',
    '5) 输出先给“分段列表（可读版）”，然后给严格 JSON。',
    '6) JSON 格式固定为：{"segments":[{"id":"S01","durationSec":5,"type":"短剧情","scene":"...","action":"...","dialogue":"..."}]}.',
    '7) 解释里明确：之所以限制 10s/5s，是因为视频最大长度约束。',
    '8) 仅输出结果，不要寒暄。'
  ].join('\n');

  const prompt = `${sysRules}\n\n【项目】${project || '未命名项目'}\n【待分段大纲】\n${outlineText}`;

  try {
    segmentTaskRunning = true;
    setSegmentTaskButtonState(true);
    setStatus('正在进行 AI 一键剧情分段...');
    setSegmentTaskStatus('正在进行 AI 一键剧情分段...', 'running');
    if(typeof setChatStatus === 'function') setChatStatus('AI 正在按 10s/5s 规则分段...');

    const reply = await requestChatCompletion(prompt);
    const text = String(reply || '').trim();

    if(!text){
      setStatus('分段失败：AI 返回空内容', false);
      return;
    }

    const parsed = extractSegmentsJsonFromText(text);
    let applied = false;
    if(parsed?.segments?.length && typeof applyManualSegmentsToPreviewRows === 'function'){
      applied = !!applyManualSegmentsToPreviewRows(parsed.segments);
    }
    if(!applied){
      throw new Error('分段结果已生成，但写入下方表格失败（未找到可用渲染上下文）');
    }

    const countMatch = text.match(/"id"\s*:\s*"S\d+"/g);
    const count = parsed?.segments?.length || (countMatch ? countMatch.length : null);
    const countLabel = count ? `${count} 段` : '若干段';
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

