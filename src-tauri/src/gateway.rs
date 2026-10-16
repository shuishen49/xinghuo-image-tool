// Embedded HTTP server: 1:1 reimplementation of grok-storyboard-preview's
// preview-server + bridge-server.  All 16 endpoints implemented in pure Rust.
// No python subprocess or external Node bridge needed.
// Image gen reuses run_generation.
// Video generate (pic2api), the chat upstream (sub2api) and dubbing (dashscope)
// were removed along with their settings — the workspace pages that call them
// are unreachable while SHOW_DRAMA is false.
// Frame capture → system ffmpeg.

use axum::{
    body::Body,
    extract::{Path as AxPath, Query, State},
    extract::DefaultBodyLimit,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::SharedConfig;

const DEFAULT_PAGE: &str = "main.html";
const PROJECT_INDEX_FILE: &str = "project-index.json";

// ---------- embedded assets ----------

#[derive(RustEmbed)]
#[folder = "web-assets/"]
struct WebAssets;


// ---------- request body structs ----------

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
struct CharacterImageUploadReq {
    project: String,
    #[serde(default, alias = "characterName", alias = "name")]
    character_name: String,
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

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoryOutlineReq {
    project: String,
    #[serde(default)] text: String,
}

#[derive(Deserialize, Default)]
struct StoryOutlineQuery {
    #[serde(default)] project: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ManualSegmentsReq {
    project: String,
    #[serde(default)] segments: serde_json::Value,
}

#[derive(Deserialize, Default)]
struct ManualSegmentsQuery {
    #[serde(default)] project: String,
}

// ============= server startup =============

pub fn start(config: SharedConfig) -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("failed to bind gateway");
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();

    let workspace = { config.read().unwrap().workspace_dir.clone() };
    let _ = std::fs::create_dir_all(&workspace);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all().build().expect("gateway tokio runtime");
        rt.block_on(async {
            let app = build_router(config);
            let l = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(l, app.into_make_service_with_connect_info::<SocketAddr>()).await.ok();
        });
    });
    port
}

fn build_router(cfg: SharedConfig) -> Router {
    Router::new()
        .route("/", get(serve_root))
        .route("/health", get(health_handler))
        .route("/*path", get(serve_path).head(serve_path_head))
        .route("/api/projects", get(handle_projects))
        .route("/api/projects/rebuild", post(handle_projects_rebuild))
        .route("/api/story-outline", get(handle_story_outline_get).post(handle_story_outline_save))
        .route("/api/manual-segments", get(handle_manual_segments_get).post(handle_manual_segments_save))
        .route("/api/scene-image/save-local", post(handle_scene_save))
        .route("/api/scene-image/variant", post(handle_scene_variant))
        .route("/api/lobster/task", post(handle_lobster_task))
        .route("/api/character/threeview", post(handle_threeview))
        .route("/api/character/image-upload", post(handle_character_image_upload))
        .route("/api/video/save-local", post(handle_video_save))
        .route("/api/video/frame-capture", post(handle_frame_capture))
        .route("/api/video/head-image-upload", post(handle_head_upload))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .with_state(cfg)
}

// ============= static file serving =============

async fn serve_root() -> Response { serve_embedded(DEFAULT_PAGE) }

async fn serve_path_head(
    State(cfg): State<SharedConfig>,
    AxPath(path): AxPath<String>,
) -> Response { serve_path_impl(cfg, path, true).await }

async fn serve_path(
    State(cfg): State<SharedConfig>,
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

fn gateway_image_ref(src: &str) -> String {
    let s = src.trim();
    s.to_string()
}

pub(crate) fn embedded_asset_bytes(path: &str) -> Option<(Vec<u8>, String)> {
    let clean = path.trim().trim_start_matches("./").trim_start_matches('/');
    let c = WebAssets::get(clean)?;
    Some((c.data.into_owned(), mime_for(clean).to_string()))
}

// ============= health =============

async fn health_handler(State(cfg): State<SharedConfig>) -> Response {
    let (ws, port) = {
        let g = cfg.read().unwrap();
        (g.workspace_dir.clone(), g.self_port)
    };
    ok_json(json!({"ok":true,"service":"storyboard-gateway","port":port,"workspace":ws.to_string_lossy(),"page":DEFAULT_PAGE}))
}

// ============= projects =============

async fn handle_projects(
    State(cfg): State<SharedConfig>,
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
    State(cfg): State<SharedConfig>,
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

async fn handle_story_outline_get(
    State(cfg): State<SharedConfig>,
    Query(q): Query<StoryOutlineQuery>,
) -> Response {
    if !is_proj_name(&q.project) {
        return err_json(StatusCode::BAD_REQUEST, json!({"error":{"message":"invalid project"}}));
    }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    let path = story_outline_path(&ws, &q.project);
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => ok_json(json!({"ok":true,"project":q.project,"text":text})),
        Err(_) => ok_json(json!({"ok":false,"project":q.project,"text":""})),
    }
}

async fn handle_story_outline_save(
    State(cfg): State<SharedConfig>,
    Json(body): Json<StoryOutlineReq>,
) -> Response {
    if !is_proj_name(&body.project) {
        return err_json(StatusCode::BAD_REQUEST, json!({"error":{"message":"invalid project"}}));
    }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    let path = story_outline_path(&ws, &body.project);
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return err_json(StatusCode::BAD_GATEWAY, json!({"error":{"message":format!("mkdir: {e}")}}));
        }
    }
    match tokio::fs::write(&path, body.text).await {
        Ok(_) => ok_json(json!({"ok":true,"project":body.project})),
        Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"message":format!("write: {e}")}})),
    }
}

fn story_outline_path(ws: &Path, project: &str) -> PathBuf {
    ws.join(project).join("planning").join("story-outline-draft.txt")
}

async fn handle_manual_segments_get(
    State(cfg): State<SharedConfig>,
    Query(q): Query<ManualSegmentsQuery>,
) -> Response {
    if !is_proj_name(&q.project) {
        return err_json(StatusCode::BAD_REQUEST, json!({"error":{"message":"invalid project"}}));
    }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    let path = manual_segments_path(&ws, &q.project);
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => {
            let segments: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|_| json!([]));
            ok_json(json!({"ok":true,"project":q.project,"segments":segments}))
        }
        Err(_) => ok_json(json!({"ok":false,"project":q.project,"segments":[]})),
    }
}

async fn handle_manual_segments_save(
    State(cfg): State<SharedConfig>,
    Json(body): Json<ManualSegmentsReq>,
) -> Response {
    if !is_proj_name(&body.project) {
        return err_json(StatusCode::BAD_REQUEST, json!({"error":{"message":"invalid project"}}));
    }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    let path = manual_segments_path(&ws, &body.project);
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return err_json(StatusCode::BAD_GATEWAY, json!({"error":{"message":format!("mkdir: {e}")}}));
        }
    }
    let text = serde_json::to_string_pretty(&body.segments).unwrap_or_else(|_| "[]".to_string());
    match tokio::fs::write(&path, text).await {
        Ok(_) => ok_json(json!({"ok":true,"project":body.project})),
        Err(e) => err_json(StatusCode::BAD_GATEWAY, json!({"error":{"message":format!("write: {e}")}})),
    }
}

fn manual_segments_path(ws: &Path, project: &str) -> PathBuf {
    ws.join(project).join("planning").join("manual-segments-draft.json")
}

// ============= scene image save-local =============

async fn handle_scene_save(
    State(cfg): State<SharedConfig>,
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
    State(cfg): State<SharedConfig>,
    Json(body): Json<SceneVariantReq>,
) -> Response {
    let img = body.image_url.trim().to_string();
    let prompt = body.prompt.trim().to_string();
    if img.is_empty() || prompt.is_empty() {
        return err_json(StatusCode::BAD_REQUEST,
            json!({"error":{"type":"missing_field","message":"缺少 imageUrl / prompt"}}));
    }
    let (img_base, img_key, img_token, img_model, img_upload_url, img_timeout) = {
        let g = cfg.read().unwrap();
        (g.img_base.clone(), g.img_key.clone(), g.img_token.clone(),
         g.img_model.clone(), g.img_upload_url.clone(), g.img_timeout)
    };
    // Empty token = API-key mode; the backend needs the `token` header omitted.
    let img_token_opt: Option<&str> = if img_token.is_empty() { None } else { Some(&img_token) };
    if img_base.is_empty() || img_key.is_empty() {
        return err_json(StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":{"type":"linggan_disabled","message":"图片接口未配置"}}));
    }
    let model = if img_model.is_empty() { "gpt-5-4-thinking" } else { img_model.as_str() };
    let upload_url: Option<&str> = if img_upload_url.is_empty() { None } else { Some(&img_upload_url) };
    let to = if img_timeout == 0 { 120 } else { img_timeout };
    let refs = vec![gateway_image_ref(&img)];
    match crate::run_generation(&img_base, &img_key, img_token_opt, model, &prompt, Some("1024x1792"), &refs, to, None, None, upload_url).await {
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
    State(cfg): State<SharedConfig>,
    Json(body): Json<LobsterReq>,
) -> Response {
    let p = &body.payload;
    let project = if p.project.is_empty() { "default".to_string() } else { p.project.clone() };
    let seg = if p.segment_id.is_empty() { "SXX".to_string() } else { p.segment_id.clone() };
    let prompt = (!p.image_prompt.is_empty()).then(|| p.image_prompt.clone())
        .unwrap_or_default();

    let (img_base, img_key, img_token, img_model, img_upload_url, img_timeout) = {
        let g = cfg.read().unwrap();
        (g.img_base.clone(), g.img_key.clone(), g.img_token.clone(),
         g.img_model.clone(), g.img_upload_url.clone(), g.img_timeout)
    };
    // Empty token = API-key mode; the backend needs the `token` header omitted.
    let img_token_opt: Option<&str> = if img_token.is_empty() { None } else { Some(&img_token) };

    let mut refs: Vec<String> = Vec::new();
    for u in [&p.image_url, &p.source_image_url] {
        if !u.is_empty() { refs.push(gateway_image_ref(u)); }
    }
    for cr in &p.character_refs {
        if !cr.image_url.is_empty() { refs.push(gateway_image_ref(&cr.image_url)); }
    }
    refs.dedup();

    if img_base.is_empty() || img_key.is_empty() {
        return ok_json(json!({"result":{"ok":false,"error":"no image api configured"}}));
    }
    let model = if img_model.is_empty() { "gpt-5-4-thinking" } else { img_model.as_str() };
    let upload_url: Option<&str> = if img_upload_url.is_empty() { None } else { Some(&img_upload_url) };
    let to = if img_timeout == 0 { 600 } else { img_timeout };

    match crate::run_generation(&img_base, &img_key, img_token_opt, model, &prompt, Some("1080x1920"), &refs, to, None, None, upload_url).await {
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
    State(cfg): State<SharedConfig>,
    Json(body): Json<ThreeViewReq>,
) -> Response {
    let name = if body.character_name.is_empty() { "未命名角色" } else { body.character_name.as_str() };
    let base = if !body.prompt.is_empty() { body.prompt.clone() }
        else { [body.role.clone(), body.design_notes.clone()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("；") };
    if base.is_empty() { return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"missing_prompt","message":"缺少 prompt"}})); }
    let prompt = format!("{base}\n构图硬约束：必须16:9横版（禁止9:16竖版），统一角色形象，三视图（正面/侧面/背面）一致。");

    let (img_base, img_key, img_token, img_model, img_upload_url, img_timeout) = {
        let g = cfg.read().unwrap();
        (g.img_base.clone(), g.img_key.clone(), g.img_token.clone(),
         g.img_model.clone(), g.img_upload_url.clone(), g.img_timeout)
    };
    // Empty token = API-key mode; the backend needs the `token` header omitted.
    let img_token_opt: Option<&str> = if img_token.is_empty() { None } else { Some(&img_token) };
    if img_base.is_empty() || img_key.is_empty() {
        return err_json(StatusCode::SERVICE_UNAVAILABLE, json!({"error":{"type":"missing_auth","message":"图片接口未配置"}}));
    }
    let model = if img_model.is_empty() { "gpt-5-4-thinking" } else { img_model.as_str() };
    let up: Option<&str> = if img_upload_url.is_empty() { None } else { Some(&img_upload_url) };
    let to = if img_timeout == 0 { 120 } else { img_timeout };
    let refs: Vec<String> = vec![];

    match crate::run_generation(&img_base, &img_key, img_token_opt, model, &prompt, Some("16:9"), &refs, to, None, None, up).await {
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

// ============= video save-local =============

async fn handle_video_save(
    State(cfg): State<SharedConfig>,
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
    State(cfg): State<SharedConfig>,
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
    State(cfg): State<SharedConfig>,
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

async fn handle_character_image_upload(
    State(cfg): State<SharedConfig>,
    Json(body): Json<CharacterImageUploadReq>,
) -> Response {
    let project = body.project.trim().to_string();
    let name = body.character_name.trim().to_string();
    if project.is_empty() || name.is_empty() || body.image_data_url.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"missing_field","message":"缺少 project/characterName/imageDataUrl"}}));
    }
    let ws = { cfg.read().unwrap().workspace_dir.clone() };
    match save_dataurl_character(&ws, &body.image_data_url, &project, &name, &body.file_name) {
        Ok((_, rel)) => {
            if let Err(e) = save_character_image_override_to_disk(&ws, &project, &name, &rel) {
                return err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"save_override_failed","message":e}}));
            }
            ok_json(json!({"ok":true,"project":project,"characterName":name,"imageUrl":rel,"localImageUrl":rel}))
        }
        Err(e) => err_json(StatusCode::BAD_REQUEST, json!({"error":{"type":"upload_failed","message":e}})),
    }
}

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

fn save_dataurl_character(ws: &Path, dataurl: &str, proj: &str, name: &str, fname: &str) -> Result<(PathBuf, String), String> {
    let (bytes, ext) = parse_dataurl(dataurl)?;
    let d = ws.join("generated").join("characters");
    std::fs::create_dir_all(&d).map_err(|e| format!("mkdir: {e}"))?;
    let file_stem = std::path::Path::new(fname)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload".into());
    let stem = sanitize_file_stem(&format!("{proj}-{name}-{file_stem}"));
    let n = format!("{stem}-{}.{ext}", ts_ms());
    let a = d.join(&n);
    std::fs::write(&a, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok((a, format!("./generated/characters/{n}")))
}

fn save_character_image_override_to_disk(ws: &Path, proj: &str, name: &str, rel: &str) -> Result<(), String> {
    let dir = ws.join(proj).join("planning");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let path = dir.join("character-image-overrides.json");
    let mut root: Value = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
        serde_json::from_str(&text).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    if !root.is_object() { root = json!({}); }
    let key = name.trim().to_lowercase();
    root[&key] = json!(rel);
    let text = serde_json::to_string_pretty(&root).map_err(|e| format!("json: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("write: {e}"))?;
    Ok(())
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
