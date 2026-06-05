// Embedded HTTP server: 1:1 reimplementation of grok-storyboard-preview's
// preview-server + bridge-server.  All 16 endpoints implemented in pure Rust.
// No python subprocess or external Node bridge needed.
// Image gen reuses run_generation. Chat goes to sub2api. Video → pic2api HTTP.
// Dubbing → dashscope HTTP (with local-mock WAV fallback).
// Frame capture → system ffmpeg.

use axum::{
    body::Body,
    extract::{Path as AxPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::SharedConfig;

const DEFAULT_PAGE: &str = "main.html";
const PROJECT_INDEX_FILE: &str = "project-index.json";

// ---------- embedded assets ----------

#[derive(RustEmbed)]
#[folder = "web-assets/"]
struct WebAssets;

// ---------- in-memory dubbing voice state ----------

#[derive(Clone, Default)]
struct VoiceEntry {
    voice_id: String,
    preview_text: String,
    preview_audio_url: String,
}

type DubbingState = Arc<Mutex<HashMap<String, VoiceEntry>>>;

// ---------- request body structs ----------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VideoGenReq {
    prompt: String,
    model: String,
    size: String,
    duration: Option<u32>,
    image_url: Option<String>,
    image: Option<String>,
    image_tail_url: Option<String>,
    image_tail: Option<String>,
    image_tail_data_url: Option<String>,
    #[serde(default)] timeout_sec: u32,
    #[serde(default)] poll_interval_sec: u32,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VideoSaveReq {
    project: String,
    #[serde(alias = "segmentId", alias = "sid")]
    segment_id: String,
    #[serde(default, alias = "remoteVideoUrl", alias = "videoUrl", alias = "url")]
    remote_video_url: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FrameReq {
    #[serde(default, alias = "videoUrl", alias = "url")]
    video_url: String,
    project: String,
    #[serde(default, alias = "segmentId", alias = "sid")]
    segment_id: String,
    #[serde(default, alias = "timeSec", alias = "time")]
    time_sec: f64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HeadUploadReq {
    project: String,
    #[serde(default, alias = "segmentId", alias = "sid")]
    segment_id: String,
    #[serde(default)] image_data_url: String,
    #[serde(default)] file_name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SceneSaveReq {
    #[serde(default)] image_url: String,
    project: String,
    #[serde(default, alias = "segmentId")]
    segment_id: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SceneVariantReq {
    project: String,
    #[serde(default, alias = "segmentId")] segment_id: String,
    #[serde(default)] image_url: String,
    prompt: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ThreeViewReq {
    #[serde(default, alias = "characterName", alias = "name")] character_name: String,
    #[serde(default)] prompt: String,
    #[serde(default)] role: String,
    #[serde(default)] design_notes: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VoiceDesignReq {
    project: String, role: String, prompt: String,
    #[serde(default)] preview_text: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VoicePreviewReq {
    #[serde(default)] project: String,
    #[serde(default)] role: String,
    #[serde(default, alias = "voiceId", alias = "voice")] voice_id: String,
    #[serde(default)] text: String,
    #[serde(default)] force_regenerate: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LobsterPayload {
    #[serde(default)] project: String,
    #[serde(default, alias = "segmentId")] segment_id: String,
    #[serde(default, alias = "imagePrompt")] image_prompt: String,
    #[serde(default)] image_url: String,
    #[serde(default)] source_image_url: String,
    #[serde(default)] character_refs: Vec<SerdeCharacterRef>,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SerdeCharacterRef { #[serde(default)] image_url: String }

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LobsterReq { payload: LobsterPayload }

#[derive(Deserialize, Default)]
struct ProjectsQuery { #[serde(default)] refresh: Option<String> }

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RebuildReq { #[serde(default)] projects: Vec<String> }

// ============= server startup =============

pub fn start(config: SharedConfig) -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("failed to bind gateway");
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();

    let dubbing: DubbingState = Default::default();
    let workspace = { config.read().unwrap().workspace_dir.clone() };
    let _ = std::fs::create_dir_all(&workspace);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all().build().expect("gateway tokio runtime");
        rt.block_on(async {
            let app = build_router(config, dubbing);
            let l = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(l, app.into_make_service_with_connect_info::<SocketAddr>()).await.ok();
        });
    });
    port
}

fn build_router(cfg: SharedConfig, dub: DubbingState) -> Router {
    Router::new()
        .route("/", get(serve_root))
        .route("/health", get(health_handler))
        .route("/*path", get(serve_path).head(serve_path_head))
        .route("/api/projects", get(handle_projects))
        .route("/api/projects/rebuild", post(handle_projects_rebuild))
        .route("/api/scene-image/save-local", post(handle_scene_save))
        .route("/api/scene-image/variant", post(handle_scene_variant))
        .route("/api/lobster/task", post(handle_lobster_task))
        .route("/api/character/threeview", post(handle_threeview))
        .route("/api/video/generate", post(handle_video_generate))
        .route("/api/video/save-local", post(handle_video_save))
        .route("/api/video/frame-capture", post(handle_frame_capture))
        .route("/api/video/head-image-upload", post(handle_head_upload))
        .route("/api/dubbing/voice/design", post(handle_voice_design))
        .route("/api/dubbing/voice/preview", post(handle_voice_preview))
        .route("/v1/chat/completions", post(handle_chat))
        .route("/chat/completions", post(handle_chat))
        .route("/api/chat/completions", post(handle_chat))
        .with_state((cfg, dub))
}

// ============= static file serving =============

async fn serve_root() -> Response { serve_embedded(DEFAULT_PAGE) }

async fn serve_path_head(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    AxPath(path): AxPath<String>,
) -> Response { serve_path_impl(cfg, path, true).await }

async fn serve_path(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    AxPath(path): AxPath<String>,
) -> Response { serve_path_impl(cfg, path, false).await }

async fn serve_path_impl(cfg: SharedConfig, path: String, head_only: bool) -> Response {
    let clean = path.trim_start_matches('/');
    if let Some(c) = WebAssets::get(clean) {
        let m = mime_for(clean);
        return ([(header::CONTENT_TYPE, m)], c.data.into_owned()).into_response();
    }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    let Some(rel) = safe_rel(clean) else { return (StatusCode::FORBIDDEN, "bad path").into_response() };
    let mut full = ws.join(&rel);
    if !full.starts_with(&ws) { return (StatusCode::FORBIDDEN, "bad path").into_response(); }
    if full.is_dir() { full = full.join("index.html"); }
    match tokio::fs::read(&full).await {
        Ok(bytes) => {
            let m = mime_for(full.to_string_lossy().as_ref());
            if head_only {
                Response::builder().header(header::CONTENT_TYPE, m).body(Body::empty()).unwrap()
            } else { ([(header::CONTENT_TYPE, m)], bytes).into_response() }
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn serve_embedded(path: &str) -> Response {
    match WebAssets::get(path) {
        Some(c) => ([(header::CONTENT_TYPE, mime_for(path))], c.data.into_owned()).into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

// ============= health =============

async fn health_handler(State((cfg, _)): State<(SharedConfig, DubbingState)>) -> Response {
    let (ws, port) = {
        let g = cfg.read().unwrap();
        (g.workspace_dir.clone(), g.self_port)
    };
    ok_json(json!({"ok":true,"service":"storyboard-gateway","port":port,"workspace":ws.to_string_lossy(),"page":DEFAULT_PAGE}))
}

// ============= projects =============

async fn handle_projects(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Query(q): Query<ProjectsQuery>,
) -> Response {
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    let scanned = scan_projects(&ws);
    if q.refresh.as_deref().is_some_and(|s| !s.is_empty()) {
        write_project_index(&ws, &scanned);
    }
    let from_json = read_project_index(&ws);
    let mut merged = from_json.clone();
    for p in &scanned { if !merged.contains(p) { merged.push(p.clone()); } }
    merged.sort();
    if from_json.is_empty() && !merged.is_empty() { write_project_index(&ws, &merged); }
    let rows: Vec<Value> = merged.iter().map(|n| json!({"name":n})).collect();
    ok_json(json!({"source":"local-gateway","projects":merged,"projectRows":rows}))
}

async fn handle_projects_rebuild(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<RebuildReq>,
) -> Response {
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    let names: Vec<String> = if body.projects.is_empty() { scan_projects(&ws) }
        else { body.projects.clone() };
    let idx = write_project_index(&ws, &names);
    ok_json(json!({"ok":true,"source":"rebuild","updatedAt":now_iso(),"projects":idx}))
}

fn scan_projects(ws: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Ok(ents) = std::fs::read_dir(ws) else { return out };
    for e in ents.flatten() {
        if !e.path().is_dir() { continue; }
        let Some(n) = e.file_name().to_str().map(|s| s.to_string()) else { continue };
        if !is_proj_name(&n) { continue; }
        if e.path().join("planning").is_dir() { out.push(n); }
    }
    out.sort(); out
}

fn read_project_index(ws: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(ws.join(PROJECT_INDEX_FILE)) else { return vec![] };
    let Ok(data): Result<Value,_> = serde_json::from_str(&raw) else { return vec![] };
    data.get("projects").and_then(|v| v.as_array()).cloned().unwrap_or_default()
        .iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).filter(|s| is_proj_name(s)).collect()
}

fn write_project_index(ws: &Path, projects: &[String]) -> Vec<String> {
    let mut u: Vec<String> = projects.iter().filter(|s| is_proj_name(s)).cloned().collect();
    u.sort(); u.dedup();
    let _ = std::fs::create_dir_all(ws);
    let _ = std::fs::write(ws.join(PROJECT_INDEX_FILE),
        json!({"updatedAt":now_iso(),"projects":&u}).to_string());
    u
}

fn is_proj_name(n: &str) -> bool {
    n.len() >= 4 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && n.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
}

// ============= scene image save-local =============

async fn handle_scene_save(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<SceneSaveReq>,
) -> Response {
    let u = body.image_url.trim().to_string();
    if u.is_empty() { return err_json(StatusCode::BAD_REQUEST, json!({"error":"missing imageUrl"})); }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    match download_scene(&ws, &u, &body.project, &body.segment_id).await {
        Ok((_, rel)) => ok_json(json!({"localImageUrl":rel})),
        Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":e})),
    }
}

// ============= scene image variant (img2img) =============

async fn handle_scene_variant(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<SceneVariantReq>,
) -> Response {
    let img = body.image_url.trim().to_string();
    let prompt = body.prompt.trim().to_string();
    if img.is_empty() || prompt.is_empty() {
        return err_json(StatusCode::BAD_REQUEST,
            json!({"error":{"type":"missing_field","message":"缺少 imageUrl / prompt"}}));
    }
    let (img_base, img_key, img_model, img_upload_url, img_timeout) = {
        let g = cfg.read().unwrap();
        (g.img_base.clone(), g.img_key.clone(), g.img_model.clone(),
         g.img_upload_url.clone(), g.img_timeout)
    };
    if img_base.is_empty() || img_key.is_empty() {
        return err_json(StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":{"type":"linggan_disabled","message":"图片接口未配置"}}));
    }
    let model = if img_model.is_empty() { "gpt-5-4-thinking" } else { img_model.as_str() };
    let upload_url: Option<&str> = if img_upload_url.is_empty() { None } else { Some(&img_upload_url) };
    let to = if img_timeout == 0 { 120 } else { img_timeout };
    let refs = vec![img];
    match crate::run_generation(&img_base, &img_key, model, &prompt, Some("1024x1792"), &refs, to, None, None, upload_url).await {
        Ok(list) if !list.is_empty() => {
            let (bytes, mime, _) = &list[0];
            let ws = { cfg.read().unwrap().workspace_dir.clone() };
            match save_scene_file(&ws, &body.project, &body.segment_id, bytes, mime, "variant") {
                Ok((_, rel)) => ok_json(json!({"ok":true,"project":body.project,"segmentId":body.segment_id,
                    "sourceImageUrl":body.image_url,"promptUsed":prompt,"localImageUrl":rel,"sceneImageUrl":rel})),
                Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"save_failed","message":e}})),
            }
        }
        Ok(_) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"no_image","message":"未返回图片"}})),
        Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"variant_failed","message":e}})),
    }
}

// ============= lobster task (storyboard image gen) =============

async fn handle_lobster_task(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<LobsterReq>,
) -> Response {
    let p = &body.payload;
    let project = if p.project.is_empty() { "default".to_string() } else { p.project.clone() };
    let seg = if p.segment_id.is_empty() { "SXX".to_string() } else { p.segment_id.clone() };
    let prompt = (!p.image_prompt.is_empty()).then(|| p.image_prompt.clone())
        .unwrap_or_default();

    let mut refs: Vec<String> = Vec::new();
    for u in [&p.image_url, &p.source_image_url] {
        if !u.is_empty() { refs.push(u.clone()); }
    }
    for cr in &p.character_refs { if !cr.image_url.is_empty() { refs.push(cr.image_url.clone()); } }
    refs.dedup();

    let (img_base, img_key, img_model, img_upload_url, img_timeout) = {
        let g = cfg.read().unwrap();
        (g.img_base.clone(), g.img_key.clone(), g.img_model.clone(),
         g.img_upload_url.clone(), g.img_timeout)
    };
    if img_base.is_empty() || img_key.is_empty() {
        return ok_json(json!({"result":{"ok":false,"error":"no image api configured"}}));
    }
    let model = if img_model.is_empty() { "gpt-5-4-thinking" } else { img_model.as_str() };
    let upload_url: Option<&str> = if img_upload_url.is_empty() { None } else { Some(&img_upload_url) };
    let to = if img_timeout == 0 { 600 } else { img_timeout };

    match crate::run_generation(&img_base, &img_key, model, &prompt, Some("864x1536"), &refs, to, None, None, upload_url).await {
        Ok(list) if !list.is_empty() => {
            let (bytes, mime) = (&list[0].0, &list[0].1);
            let ws = { cfg.read().unwrap().workspace_dir.clone() };
            match save_scene_file(&ws, &project, &seg, bytes, mime, "lobster") {
                Ok((_, rel)) => ok_json(json!({"result":{"ok":true,"sceneImageUrl":rel,"remoteImageUrl":rel}})),
                Err(e) => ok_json(json!({"result":{"ok":false,"error":e}})),
            }
        }
        Ok(_) => ok_json(json!({"result":{"ok":false,"error":"no image returned"}})),
        Err(e) => ok_json(json!({"result":{"ok":false,"error":e}})),
    }
}

// ============= character threeview =============

async fn handle_threeview(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<ThreeViewReq>,
) -> Response {
    let name = if body.character_name.is_empty() { "未命名角色" } else { body.character_name.as_str() };
    let base = if !body.prompt.is_empty() { body.prompt.clone() }
        else { [body.role.clone(), body.design_notes.clone()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("；") };
    if base.is_empty() { return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"missing_prompt","message":"缺少 prompt"}})); }
    let prompt = format!("{base}\n构图硬约束：必须16:9横版（禁止9:16竖版），统一角色形象，三视图（正面/侧面/背面）一致。");

    let (img_base, img_key, img_model, img_upload_url, img_timeout) = {
        let g = cfg.read().unwrap();
        (g.img_base.clone(), g.img_key.clone(), g.img_model.clone(), g.img_upload_url.clone(), g.img_timeout)
    };
    if img_base.is_empty() || img_key.is_empty() {
        return err_json(StatusCode::SERVICE_UNAVAILABLE, json!({"error":{"type":"missing_auth","message":"图片接口未配置"}}));
    }
    let model = if img_model.is_empty() { "gpt-5-4-thinking" } else { img_model.as_str() };
    let up: Option<&str> = if img_upload_url.is_empty() { None } else { Some(&img_upload_url) };
    let to = if img_timeout == 0 { 120 } else { img_timeout };
    let refs: Vec<String> = vec![];

    match crate::run_generation(&img_base, &img_key, model, &prompt, Some("16:9"), &refs, to, None, None, up).await {
        Ok(list) if !list.is_empty() => {
            let (bytes, mime, _) = &list[0];
            let ws = { cfg.read().unwrap().workspace_dir.clone() };
            match save_char_file(&ws, name, bytes, mime).await {
                Ok((_, rel)) => ok_json(json!({"ok":true,"characterName":name,"promptUsed":prompt,"imageUrl":rel,"localImageUrl":rel})),
                Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"save_failed","message":e}})),
            }
        }
        Ok(_) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"no_image","message":"未返回图片"}})),
        Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"call_failed","message":e}})),
    }
}

// ============= video generate (pic2api submit + poll) =============

async fn handle_video_generate(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<VideoGenReq>,
) -> Response {
    let (api_base, api_key, def_model, ws) = {
        let g = cfg.read().unwrap();
        (g.pic2api_base.clone(), g.pic2api_key.clone(), g.pic2api_model.clone(), g.workspace_dir.clone())
    };
    if api_key.is_empty() {
        return err_json(StatusCode::SERVICE_UNAVAILABLE, json!({"error":{"type":"pic2api_disabled","message":"pic2api 未配置"}}));
    }
    let tb = api_base.trim().trim_end_matches('/');
    let true_base = if tb.is_empty() { "https://www.pic2api.com/v1" } else { tb };

    let prompt = body.prompt.trim().to_string();
    if prompt.is_empty() { return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"missing_prompt","message":"缺少 prompt"}})); }

    let model = if body.model.is_empty() { if def_model.is_empty() { "sora2-pro".to_string() } else { def_model } } else { body.model.clone() };
    let size = if body.size.is_empty() { "1024x576".to_string() } else { body.size.clone() };
    let dur = body.duration.unwrap_or(8);
    let to = if body.timeout_sec == 0 { 480 } else { body.timeout_sec };
    let poll_int = if body.poll_interval_sec == 0 { 4 } else { body.poll_interval_sec };
    let mk = model.to_lowercase();
    let allowed: &[u32] = if mk.starts_with("veo3.1") || mk.starts_with("veo3-fast") { &[4,6,8] } else { &[4,8,12] };
    let dur = if allowed.contains(&dur) { dur } else { allowed[0] };

    let head_raw = body.image_url.as_deref().or(body.image.as_deref()).unwrap_or("").trim().to_string();
    let tail_raw = body.image_tail_url.as_deref().or(body.image_tail.as_deref()).unwrap_or("").trim().to_string();
    let tail_data = body.image_tail_data_url.as_deref().unwrap_or("").trim().to_string();

    let mut payload = json!({"model":model,"prompt":prompt,"size":size,"duration":dur});
    if !head_raw.is_empty() {
        let hp = resolve_ref(&head_raw, &ws);
        if hp.exists() && hp.is_file() { if let Ok(b) = std::fs::read(&hp) { payload["image"] = json!(B64.encode(&b)); } }
    }
    if !tail_data.is_empty() && tail_data.starts_with("data:image/") {
        if let Ok(p) = decode_dataurl_tmp(&ws, &tail_data) {
            if let Ok(b) = std::fs::read(&p) { payload["image_tail"] = json!(B64.encode(&b)); }
        }
    } else if !tail_raw.is_empty() {
        let tp = resolve_ref(&tail_raw, &ws);
        if tp.exists() && tp.is_file() { if let Ok(b) = std::fs::read(&tp) { payload["image_tail"] = json!(B64.encode(&b)); } }
    }

    let sub_url = format!("{true_base}/video/generations");
    let (st, sub) = http_post(&sub_url, &api_key, &payload, 120).await.unwrap_or((0, json!({})));
    if st < 200 || st >= 300 {
        return err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"submit_failed","message":sub.to_string()}}));
    }
    let task_id = sub.get("task_id").or_else(|| sub.get("id")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    if task_id.is_empty() { return err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"no_task_id","message":"未返回 task_id"}})); }

    let poll_url = format!("{true_base}/video/generations/{task_id}");
    let started = std::time::Instant::now();
    loop {
        if started.elapsed().as_secs() > to as u64 {
            return err_json(StatusCode::GATEWAY_TIMEOUT, json!({"error":{"type":"timeout","message":"视频生成超时","taskId":task_id}}));
        }
        let (pst, pr) = match http_get(&poll_url, &api_key, 120).await {
            Ok(r) => r, Err(_) => { tokio::time::sleep(Duration::from_secs(poll_int as u64)).await; continue; }
        };
        if pst >= 500 { tokio::time::sleep(Duration::from_secs(poll_int as u64)).await; continue; }
        if pst < 200 || pst >= 300 {
            return err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"poll_failed","message":pr.to_string(),"taskId":task_id}}));
        }
        let stat = pr.get("status").or_else(|| pr.get("data").and_then(|d| d.get("status"))).and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let vurl = pick_vurl(&pr);
        if (stat == "completed" || stat == "succeeded" || stat == "success") && !vurl.is_empty() {
            if let Ok((_, lrel)) = download_video(&ws, &vurl, "video-gen", "S01").await {
                return ok_json(json!({"ok":true,"taskId":task_id,"model":model,"size":size,"duration":dur,
                    "remoteVideoUrl":vurl,"videoUrl":lrel,"localVideoUrl":lrel,"variant":format!("pic2api/{model}")}));
            }
            return ok_json(json!({"ok":true,"taskId":task_id,"model":model,"size":size,"duration":dur,
                "remoteVideoUrl":vurl,"videoUrl":vurl,"localVideoUrl":"","variant":format!("pic2api/{model}"),"downloadLocalOk":false}));
        }
        if stat == "failed" || stat == "error" || stat == "cancelled" {
            return err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"video_failed","message":format!("视频生成失败: {stat}")}}));
        }
        tokio::time::sleep(Duration::from_secs(poll_int as u64)).await;
    }
}

fn pick_vurl(r: &Value) -> String {
    if let Some(u) = r.get("output").and_then(|o| o.get("url")).and_then(|v| v.as_str()) { return u.to_string(); }
    for k in &["url","video_url","play_url","local_url","hd_video_url"] {
        if let Some(u) = r.get("data").and_then(|d| d.get(k)).and_then(|v| v.as_str()) { return u.to_string(); }
    }
    for k in &["url","video_url","play_url","local_url","hdVideoUrl"] {
        if let Some(u) = r.get(k).and_then(|v| v.as_str()) { return u.to_string(); }
    }
    String::new()
}

// ============= video save-local =============

async fn handle_video_save(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<VideoSaveReq>,
) -> Response {
    let url = body.remote_video_url.trim().to_string();
    if url.is_empty() || !url.starts_with("http") {
        return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"missing_url","message":"缺少 remoteVideoUrl"}}));
    }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    match download_video(&ws, &url, &body.project, &body.segment_id).await {
        Ok((_, rel)) => ok_json(json!({"ok":true,"videoUrl":rel,"localVideoUrl":rel,"downloadLocalOk":true,"status":"completed"})),
        Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"download_failed","message":e}})),
    }
}

// ============= video frame capture =============

async fn handle_frame_capture(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<FrameReq>,
) -> Response {
    let video_url = body.video_url.trim().to_string();
    if video_url.is_empty() { return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"missing_url","message":"缺少 videoUrl"}})); }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    let ff = { let g = cfg.read().unwrap(); if g.ffmpeg_path.is_empty() { "ffmpeg".to_string() } else { g.ffmpeg_path.clone() } };
    match capture_frame(&ws, &ff, &video_url, &body.project, &body.segment_id, body.time_sec).await {
        Ok(r) => ok_json(json!({"ok":true,"timeSec":body.time_sec,"imageMimeType":"image/jpeg","imageBase64":r.b64,"imageRelUrl":r.rel})),
        Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"type":"capture_failed","message":e}})),
    }
}

struct FrameOut { b64: String, rel: String }

async fn capture_frame(ws: &Path, ffmpeg: &str, vurl: &str, proj: &str, seg: &str, secs: f64) -> Result<FrameOut, String> {
    let dir = ws.join("generated").join("frames");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("mkdir: {e}"))?;
    let stem = sanitize_file_stem(&format!("{proj}-{seg}-frame"));
    let fp = dir.join(format!("{stem}-{}.jpg", ts_ms()));

    let vabs = if vurl.starts_with("./") || vurl.starts_with("generated/") {
        resolve_ref(vurl, ws)
    } else if vurl.starts_with("http") {
        let (a, _) = download_video(ws, vurl, "frame-cap", seg).await?;
        a
    } else { return Err("仅支持 http(s) 或本地视频地址".to_string()); };
    if !vabs.exists() { return Err(format!("视频不存在: {vurl}")); }

    let sec = secs.max(0.0);
    let out = Command::new(ffmpeg).args(["-y","-ss",&sec.to_string(),"-i"])
        .arg(vabs.to_string_lossy().as_ref()).args(["-frames:v","1","-q:v","2"])
        .arg(fp.to_string_lossy().as_ref()).output()
        .map_err(|e| format!("ffmpeg 调用失败: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffmpeg 截帧失败: {}", String::from_utf8_lossy(&out.stderr)));
    }
    if !fp.exists() { return Err("截帧输出不存在".to_string()); }
    let b = tokio::fs::read(&fp).await.map_err(|e| format!("read: {e}"))?;
    let rel = format!("./generated/frames/{}", fp.file_name().unwrap().to_string_lossy());
    Ok(FrameOut { b64: B64.encode(&b), rel })
}

// ============= video head-image upload =============

async fn handle_head_upload(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<HeadUploadReq>,
) -> Response {
    if body.project.is_empty() || body.segment_id.is_empty() || body.image_data_url.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"missing_field","message":"缺少 project/segmentId/imageDataUrl"}}));
    }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    match save_dataurl_scene(&ws, &body.image_data_url, &body.project, &body.segment_id, &body.file_name) {
        Ok((_, rel)) => ok_json(json!({"ok":true,"project":body.project,"segmentId":body.segment_id,"localImageUrl":rel})),
        Err(e) => err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"upload_failed","message":e}})),
    }
}

// ============= dubbing voice design =============

async fn handle_voice_design(
    State((cfg, dub)): State<(SharedConfig, DubbingState)>,
    Json(body): Json<VoiceDesignReq>,
) -> Response {
    let proj = body.project.trim().to_string();
    let role = body.role.trim().to_string();
    let prompt = body.prompt.trim().to_string();
    if proj.is_empty() || role.is_empty() || prompt.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"missing_field","message":"缺少 project/role/prompt"}}));
    }
    let ptext = if body.preview_text.is_empty() { format!("{role}，您好，这是一段音色试听。") } else { body.preview_text.clone() };

    let (ds_key, dm, tm) = {
        let g = cfg.read().unwrap();
        (g.dashscope_key.clone(), g.dashscope_design_model.clone(), g.dashscope_tts_model.clone())
    };
    let dm = if dm.is_empty() { "qwen-voice-design" } else { &dm };
    let tm = if tm.is_empty() { "qwen3-tts-vd-realtime-2026-01-15" } else { &tm };

    // Try real DashScope if key configured
    if !ds_key.is_empty() {
        if let Ok(r) = ds_voice_design(&ds_key, dm, tm, &role, &prompt, &ptext).await {
            let k = voice_key(&proj, &role);
            dub.lock().unwrap().insert(k, VoiceEntry {
                voice_id: r.vid.clone(), preview_text: ptext.clone(), preview_audio_url: r.pau.clone(),
            });
            return ok_json(json!({"ok":true,"project":proj,"role":role,"voiceId":r.vid,"voice":r.vid,
                "model":dm,"provider":"dashscope","ttsModel":tm,"previewText":ptext,"previewAudioUrl":r.pau}));
        }
    }

    // Mock fallback
    let seed = format!("{proj}|{role}|{prompt}");
    let vid = format!("voice_{:x}", hash_u32(&seed));
    let pau = wav_tone(&format!("{vid}:{prompt}"), 1.2);
    let k = voice_key(&proj, &role);
    dub.lock().unwrap().insert(k, VoiceEntry {
        voice_id: vid.clone(), preview_text: ptext.clone(), preview_audio_url: pau.clone(),
    });
    ok_json(json!({"ok":true,"project":proj,"role":role,"voiceId":vid,"voice":vid,"model":"local-mock-voice-design",
        "provider":"local-mock","previewText":ptext,"previewAudioUrl":pau,"note":"已返回本地预览音频（未接入真实音色供应商）"}))
}

struct DsVoiceOut { vid: String, pau: String }

async fn ds_voice_design(key: &str, dm: &str, tm: &str, role: &str, prompt: &str, ptext: &str) -> Result<DsVoiceOut, String> {
    let url = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
    let body = json!({"model":dm,"input":{"action":"create","target_model":tm,"voice_prompt":prompt,"preview_text":ptext,"preferred_name":sanitize_preferred(role),"language":"zh"},"parameters":{"sample_rate":24000,"response_format":"wav"}});
    let (st, resp) = http_post(url, key, &body, 120).await?;
    if st < 200 || st >= 300 { return Err(format!("dashscope HTTP {st}")); }
    let out = resp.get("output").cloned().unwrap_or_default();
    let vid = out.get("voice").or_else(|| out.get("voice_id")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    if vid.is_empty() { return Err("未返回 voice".to_string()); }
    let pau = pick_ds_audio(&out);
    Ok(DsVoiceOut { vid, pau })
}

// ============= voice preview =============

async fn handle_voice_preview(
    State((cfg, dub)): State<(SharedConfig, DubbingState)>,
    Json(mut body): Json<VoicePreviewReq>,
) -> Response {
    let vid = body.voice_id.trim().to_string();
    if body.project.is_empty() || body.role.is_empty() {
        if let Some((p, r)) = find_voice_by_id(&dub, &vid) { body.project = p; body.role = r; }
    }
    if body.project.is_empty() { body.project = "__adhoc__".into(); }
    if body.role.is_empty() { body.role = "角色".into(); }
    let text = if body.text.is_empty() { format!("{}，您好，这是一段音色试听。", body.role) } else { body.text.clone() };

    let (stored_pau, stored_pt): (String, String) = {
        let k = voice_key(&body.project, &body.role);
        let g = dub.lock().unwrap();
        g.get(&k).map(|e| (e.preview_audio_url.clone(), e.preview_text.clone())).unwrap_or_default()
    };
    let (ds_key, tm) = {
        let g = cfg.read().unwrap();
        let tm = if g.dashscope_tts_model.is_empty() { "qwen3-tts-vd-realtime-2026-01-15".into() } else { g.dashscope_tts_model.clone() };
        (g.dashscope_key.clone(), tm)
    };

    if is_real_vid(&vid) && !ds_key.is_empty() {
        if let Ok(a) = ds_voice_preview(&ds_key, &tm, &vid, &text).await {
            return ok_json(json!({"ok":true,"project":body.project,"role":body.role,"voiceId":vid,"previewText":text,"audioUrl":a,"provider":"dashscope","ttsModel":tm}));
        }
    }
    let seed = format!("{vid}:{text}:{}", ts_ms());
    let audio = if !body.force_regenerate && !stored_pau.is_empty() && text == stored_pt { stored_pau } else { wav_tone(&seed, 1.2) };
    ok_json(json!({"ok":true,"project":body.project,"role":body.role,"voiceId":vid,"previewText":text,"audioUrl":audio,"provider":"local-mock"}))
}

// ============= chat completions =============

async fn handle_chat(
    State((cfg, _)): State<(SharedConfig, DubbingState)>,
    _headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    let (base, key, model) = {
        let g = cfg.read().unwrap();
        (g.chat_base.clone(), g.chat_key.clone(), g.chat_model.clone())
    };
    if base.is_empty() { return err_json(StatusCode::BAD_GATEWAY, json!({"error":{"message":"chat upstream not configured"}})); }
    if !model.is_empty() { body["model"] = json!(model); }

    let url = chat_url(&base);
    let client = match crate::http_client(300) { Ok(c) => c, Err(e) => return err_json(StatusCode::BAD_GATEWAY, json!({"error":{"message":e}})) };
    // Always use the configured chat key from main app settings.
    // The workspace page must not send its own key; all keys stay Rust-side.
    if key.is_empty() {
        return err_json(StatusCode::BAD_GATEWAY,
            json!({"error":{"message":"聊天接口未配置 API Key，请在设置页的「漫剧工作台 · 聊天接口」填写"}}));
    }
    let rb = client.post(&url).json(&body).bearer_auth(&key);

    match rb.send().await {
        Ok(r) => { let st=r.status(); let t=r.text().await.unwrap_or_default();
            Response::builder().status(st).header(header::CONTENT_TYPE,"application/json").body(Body::from(t)).unwrap() }
        Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"message":format!("chat upstream failed: {e}")}})),
    }
}

fn chat_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") { b.to_string() }
    else if b.ends_with("/v1") { format!("{b}/chat/completions") }
    else { format!("{b}/v1/chat/completions") }
}

// ============= HTTP helpers =============

async fn http_post(url: &str, key: &str, payload: &Value, timeout: u64) -> Result<(u16, Value), String> {
    let c = crate::http_client(timeout)?;
    let r = c.post(url).bearer_auth(key).json(payload).send().await.map_err(|e| format!("req: {e}"))?;
    let st = r.status().as_u16();
    let t = r.text().await.map_err(|e| format!("body: {e}"))?;
    let v: Value = serde_json::from_str(&t).unwrap_or(Value::String(t));
    Ok((st, v))
}

async fn http_get(url: &str, key: &str, timeout: u64) -> Result<(u16, Value), String> {
    let c = crate::http_client(timeout)?;
    let r = c.get(url).bearer_auth(key).send().await.map_err(|e| format!("req: {e}"))?;
    let st = r.status().as_u16();
    let t = r.text().await.map_err(|e| format!("body: {e}"))?;
    let v: Value = serde_json::from_str(&t).unwrap_or(Value::String(t));
    Ok((st, v))
}

// ============= voice helpers =============

fn voice_key(proj: &str, role: &str) -> String { format!("{proj}::{role}") }

fn find_voice_by_id(state: &DubbingState, vid: &str) -> Option<(String, String)> {
    for (k, e) in state.lock().unwrap().iter() {
        if e.voice_id == vid {
            if let Some((p, r)) = k.split_once("::") { return Some((p.to_string(), r.to_string())); }
        }
    }
    None
}

fn is_real_vid(vid: &str) -> bool { !vid.is_empty() && !vid.starts_with("voice_") }

async fn ds_voice_preview(key: &str, tm: &str, vid: &str, text: &str) -> Result<String, String> {
    let c = crate::http_client(60)?;
    for url in ["https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech",
                "https://dashscope.aliyuncs.com/api/v1/services/audio/tts"] {
        let body = json!({"model":tm,"input":text,"voice":vid,"response_format":"wav"});
        if let Ok(r) = c.post(url).bearer_auth(key).json(&body).send().await {
            if r.status().is_success() {
                if let Ok(b) = r.bytes().await {
                    if !b.is_empty() { return Ok(format!("data:audio/wav;base64,{}", B64.encode(&b))); }
                }
            }
        }
    }
    Err("dashscope voice preview failed".to_string())
}

fn pick_ds_audio(out: &Value) -> String {
    for k in &["preview_audio","previewAudio","audio"] {
        if let Some(v) = out.get(k) {
            if let Some(s) = v.as_str() { if s.starts_with("data:audio/") { return s.to_string(); } return format!("data:audio/wav;base64,{s}"); }
            if let Some(d) = v.get("data").or_else(|| v.get("base64")).and_then(|x| x.as_str()) { return format!("data:audio/wav;base64,{d}"); }
        }
    }
    String::new()
}

fn sanitize_preferred(role: &str) -> String {
    let c: String = role.chars().map(|c| if c.is_ascii_alphanumeric() || c=='-' || c=='_' { c } else { '_' }).collect();
    let t = c.trim_matches('_'); if t.len() > 32 { t[..32].to_string() } else if t.is_empty() { format!("voice_{:x}", hash_u32(role)) } else { t.to_string() }
}

// ============= WAV mock tone generator =============

fn wav_tone(seed: &str, secs: f64) -> String {
    let sr = 22050u32; let total = ((sr as f64) * secs.max(0.3)) as usize;
    let freq = 220.0 + (hash_u32(seed) % 300) as f64; let amp = 0.22;
    let mut pcm = Vec::with_capacity(total * 2);
    for i in 0..total { let t = i as f64 / sr as f64;
        let fin = (i as f64 / (sr as f64 * 0.04)).min(1.0); let fout = ((total - i) as f64 / (sr as f64 * 0.06)).min(1.0);
        let s = ((2.0 * std::f64::consts::PI * freq * t).sin() * amp * fin.min(fout)).clamp(-1.0, 1.0);
        pcm.extend_from_slice(&((s * 32767.0) as i16).to_le_bytes()); }
    let ds = pcm.len() as u32; let br = sr * 2;
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF"); w.extend_from_slice(&(36u32 + ds).to_le_bytes()); w.extend_from_slice(b"WAVE");
    w.extend_from_slice(b"fmt "); w.extend_from_slice(&16u32.to_le_bytes()); w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); w.extend_from_slice(&sr.to_le_bytes()); w.extend_from_slice(&br.to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes()); w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data"); w.extend_from_slice(&ds.to_le_bytes()); w.extend_from_slice(&pcm);
    format!("data:audio/wav;base64,{}", B64.encode(&w))
}

fn hash_u32(s: &str) -> u32 { let mut h: u32 = 2166136261; for b in s.bytes() { h ^= b as u32; h = h.wrapping_mul(16777619); } h }

// ============= file operations =============

fn save_scene_file(ws: &Path, proj: &str, seg: &str, bytes: &[u8], mime: &str, sfx: &str) -> Result<(PathBuf, String), String> {
    let d = ws.join("generated").join("scenes");
    std::fs::create_dir_all(&d).map_err(|e| format!("mkdir: {e}"))?;
    let stem = sanitize_file_stem(&format!("{proj}-{seg}-{sfx}"));
    let ext = crate::ext_for(mime);
    let n = format!("{stem}-{}.{ext}", ts_ms());
    let a = d.join(&n);
    std::fs::write(&a, bytes).map_err(|e| format!("write: {e}"))?;
    Ok((a, format!("./generated/scenes/{n}")))
}

async fn save_char_file(ws: &Path, name: &str, bytes: &[u8], mime: &str) -> Result<(PathBuf, String), String> {
    let d = ws.join("generated").join("characters");
    tokio::fs::create_dir_all(&d).await.map_err(|e| format!("mkdir: {e}"))?;
    let stem = sanitize_file_stem(name);
    let ext = crate::ext_for(mime);
    let n = format!("{stem}-{}.{ext}", ts_ms());
    let a = d.join(&n);
    tokio::fs::write(&a, bytes).await.map_err(|e| format!("write: {e}"))?;
    Ok((a, format!("./generated/characters/{n}")))
}

async fn download_scene(ws: &Path, url: &str, proj: &str, seg: &str) -> Result<(PathBuf, String), String> {
    let (bytes, mime) = crate::src_to_bytes(&crate::http_client(60)?, url).await?;
    save_scene_file(ws, proj, seg, &bytes, &mime, "scene")
}

async fn download_video(ws: &Path, url: &str, proj: &str, seg: &str) -> Result<(PathBuf, String), String> {
    let d = ws.join("generated").join("videos");
    tokio::fs::create_dir_all(&d).await.map_err(|e| format!("mkdir: {e}"))?;
    let c = crate::http_client(120)?;
    let r = c.get(url).send().await.map_err(|e| format!("download: {e}"))?;
    if !r.status().is_success() { return Err(format!("下载视频失败 (HTTP {})", r.status())); }
    let b = r.bytes().await.map_err(|e| format!("read: {e}"))?;
    if b.is_empty() { return Err("下载视频失败（空内容）".to_string()); }
    let ext = guess_vid_ext(url);
    let stem = sanitize_file_stem(&format!("{proj}-{seg}"));
    let n = format!("{stem}-{}.{ext}", ts_ms());
    let a = d.join(&n);
    tokio::fs::write(&a, &b).await.map_err(|e| format!("write: {e}"))?;
    Ok((a, format!("./generated/videos/{n}")))
}

fn save_dataurl_scene(ws: &Path, dataurl: &str, proj: &str, seg: &str, fname: &str) -> Result<(PathBuf, String), String> {
    let (bytes, ext) = parse_dataurl(dataurl)?;
    let d = ws.join("generated").join("scenes");
    std::fs::create_dir_all(&d).map_err(|e| format!("mkdir: {e}"))?;
    let stem = sanitize_file_stem(&format!("{proj}-{seg}-{}",
        std::path::Path::new(fname).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("head".into())));
    let n = format!("{stem}-{}.{ext}", ts_ms());
    let a = d.join(&n);
    std::fs::write(&a, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok((a, format!("./generated/scenes/{n}")))
}

fn decode_dataurl_tmp(ws: &Path, dataurl: &str) -> Result<String, String> {
    let (bytes, ext) = parse_dataurl(dataurl)?;
    let d = ws.join("tmp").join("video-tail");
    std::fs::create_dir_all(&d).map_err(|e| format!("mkdir: {e}"))?;
    let n = format!("tail-{}.{ext}", ts_ms());
    let a = d.join(&n);
    std::fs::write(&a, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok(a.to_string_lossy().to_string())
}

fn parse_dataurl(dataurl: &str) -> Result<(Vec<u8>, String), String> {
    if !dataurl.starts_with("data:image/") { return Err("非法 data URL".to_string()); }
    let Some((meta, b64)) = dataurl.split_once(',') else { return Err("非法 data URL".to_string()) };
    let ext = if meta.contains("png") { "png" } else if meta.contains("jpeg")||meta.contains("jpg") { "jpg" } else if meta.contains("webp") { "webp" } else if meta.contains("gif") { "gif" } else { "png" };
    let bytes = B64.decode(b64.trim()).map_err(|e| format!("base64: {e}"))?;
    if bytes.is_empty() { return Err("图片为空".to_string()); }
    Ok((bytes, ext.to_string()))
}

fn resolve_ref(url: &str, ws: &Path) -> PathBuf {
    let r = url.trim(); if r.is_empty() { return PathBuf::new(); }
    if r.starts_with("http://") || r.starts_with("https://") { return PathBuf::from(r); }
    if Path::new(r).is_absolute() { return PathBuf::from(r); }
    ws.join(r.trim_start_matches("./"))
}

fn guess_vid_ext(url: &str) -> String {
    if let Some(e) = url.rsplit('.').next() { let x = e.split('?').next().unwrap_or("mp4").to_lowercase();
        if ["mp4","webm","mov","m4v","mkv","avi"].contains(&x.as_str()) { return x; } }
    "mp4".to_string()
}

// ============= utility helpers =============

fn sanitize_file_stem(v: &str) -> String {
    let c: String = v.chars().map(|c| if c.is_ascii_alphanumeric() || c=='-' || c=='_' { c } else { '-' }).collect();
    let t = c.trim_matches('-').to_string();
    let s = if t.len() > 64 { &t[..64] } else { &t };
    if s.is_empty() { "default".into() } else { s.to_string() }
}

fn ts_ms() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) }

fn now_iso() -> String { format!("{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()) }

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html"|"htm" => "text/html; charset=utf-8",
        "js"|"mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg"|"jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

fn safe_rel(path: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in PathBuf::from(path).components() {
        match c { Component::Normal(x) => out.push(x), Component::CurDir => {}, _ => return None }
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

fn ok_json(v: Value) -> Response { (StatusCode::OK, Json(v)).into_response() }

fn err_json(st: StatusCode, v: Value) -> Response { (st, Json(v)).into_response() }
