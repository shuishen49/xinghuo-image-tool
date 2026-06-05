// Embedded local HTTP server that replaces the old openclaw "lobster" bridge.
//
// Serves the drama workspace static files plus the /api/* and chat endpoints
// so the app is fully standalone (no openclaw / lobster needed).

use axum::{
    body::Body,
    extract::{Path as AxPath, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Component, PathBuf};

use crate::SharedConfig;

#[derive(RustEmbed)]
#[folder = "web-assets/"]
struct WebAssets;

pub fn start(config: SharedConfig) -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("failed to bind embedded gateway port");
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("gateway tokio runtime");
        rt.block_on(async move {
            let app = Router::new()
                .route("/api/lobster/task", post(lobster_task))
                .route("/api/scene-image/save-local", post(save_local))
                .route("/api/projects", get(list_projects))
                .route("/api/projects/rebuild", get(list_projects))
                .route("/v1/chat/completions", post(chat_completions))
                .route("/", get(serve_root))
                .route("/*path", get(serve_path))
                .with_state(config);
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .await
                .ok();
        });
    });

    port
}

async fn serve_root() -> Response {
    serve_embedded("main.html")
}

async fn serve_path(State(cfg): State<SharedConfig>, AxPath(path): AxPath<String>) -> Response {
    let clean = path.trim_start_matches('/');
    if WebAssets::get(clean).is_some() {
        return serve_embedded(clean);
    }
    let workspace = { cfg.read().unwrap().workspace_dir.clone() };
    let Some(rel) = safe_relative(clean) else {
        return (StatusCode::FORBIDDEN, "bad path").into_response();
    };
    let full = workspace.join(rel);
    match tokio::fs::read(&full).await {
        Ok(bytes) => {
            let mime = crate::mime_for_path(full.to_string_lossy().as_ref());
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn serve_embedded(path: &str) -> Response {
    match WebAssets::get(path) {
        Some(content) => {
            let mime = crate::mime_for_path(path);
            ([(header::CONTENT_TYPE, mime)], content.data.into_owned()).into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn safe_relative(path: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in PathBuf::from(path).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}
async fn lobster_task(State(cfg): State<SharedConfig>, Json(req): Json<Value>) -> Response {
    let payload = &req["payload"];
    let project = payload["project"].as_str().unwrap_or("default").to_string();
    let segment = payload["segmentId"].as_str().unwrap_or("SXX").to_string();
    let prompt = payload["imagePrompt"]
        .as_str()
        .or_else(|| payload["prompt"].as_str())
        .unwrap_or("")
        .to_string();

    let mut refs: Vec<String> = Vec::new();
    for key in ["imageUrl", "sourceImageUrl"] {
        if let Some(u) = payload[key].as_str().filter(|s| !s.is_empty()) {
            refs.push(u.to_string());
        }
    }
    if let Some(arr) = payload["characterRefs"].as_array() {
        for it in arr {
            if let Some(u) = it["imageUrl"].as_str().filter(|s| !s.is_empty()) {
                refs.push(u.to_string());
            }
        }
    }
    refs.dedup();

    let (img_base, img_key, img_model, upload_url, timeout, workspace) = {
        let g = cfg.read().unwrap();
        (
            g.img_base.clone(),
            g.img_key.clone(),
            g.img_model.clone(),
            g.img_upload_url.clone(),
            g.img_timeout,
            g.workspace_dir.clone(),
        )
    };
    if img_base.is_empty() || img_key.is_empty() {
        return ok_json(json!({
            "result": { "ok": false, "error": "no image api configured" }
        }));
    }

    let model = if img_model.is_empty() {
        "gpt-5-4-thinking"
    } else {
        img_model.as_str()
    };
    let outs = crate::run_generation(
        &img_base,
        &img_key,
        model,
        &prompt,
        Some("864x1536"),
        &refs,
        if timeout == 0 { 600 } else { timeout },
        None,
        None,
        if upload_url.is_empty() {
            None
        } else {
            Some(upload_url.as_str())
        },
    )
    .await;

    match outs {
        Ok(list) if !list.is_empty() => {
            let (bytes, mime) = (&list[0].0, &list[0].1);
            match save_into_project(&workspace, &project, &segment, bytes, mime) {
                Ok(local_url) => ok_json(json!({
                    "result": {
                        "ok": true,
                        "sceneImageUrl": local_url,
                        "remoteImageUrl": local_url
                    }
                })),
                Err(e) => ok_json(json!({ "result": { "ok": false, "error": e } })),
            }
        }
        Ok(_) => ok_json(json!({ "result": { "ok": false, "error": "no image returned" } })),
        Err(e) => ok_json(json!({ "result": { "ok": false, "error": e } })),
    }
}

async fn save_local(State(cfg): State<SharedConfig>, Json(req): Json<Value>) -> Response {
    let image_url = req["imageUrl"].as_str().unwrap_or("").to_string();
    let project = req["project"].as_str().unwrap_or("default").to_string();
    let segment = req["segmentId"].as_str().unwrap_or("SXX").to_string();
    if image_url.is_empty() {
        return ok_json(json!({ "error": "missing imageUrl" }));
    }
    let workspace = { cfg.read().unwrap().workspace_dir.clone() };

    let client = match crate::http_client(120) {
        Ok(c) => c,
        Err(e) => return ok_json(json!({ "error": e })),
    };
    let (bytes, mime) = match crate::src_to_bytes(&client, &image_url).await {
        Ok(v) => v,
        Err(e) => return ok_json(json!({ "error": e })),
    };
    match save_into_project(&workspace, &project, &segment, &bytes, &mime) {
        Ok(local_url) => ok_json(json!({ "localImageUrl": local_url })),
        Err(e) => ok_json(json!({ "error": e })),
    }
}

fn save_into_project(
    workspace: &std::path::Path,
    project: &str,
    segment: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<String, String> {
    let safe_project = sanitize_seg(project);
    let safe_segment = sanitize_seg(segment);
    let dir = workspace.join(&safe_project).join("generated").join("scenes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("{safe_segment}-{ts}.{}", crate::ext_for(mime));
    let full = dir.join(&name);
    std::fs::write(&full, bytes).map_err(|e| format!("write: {e}"))?;
    Ok(format!("./{safe_project}/generated/scenes/{name}"))
}

fn sanitize_seg(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed
    }
}

async fn list_projects(State(cfg): State<SharedConfig>) -> Response {
    let workspace = { cfg.read().unwrap().workspace_dir.clone() };
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&workspace) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                if let Some(n) = e.file_name().to_str() {
                    names.push(n.to_string());
                }
            }
        }
    }
    names.sort();
    let rows: Vec<Value> = names.iter().map(|n| json!({ "name": n })).collect();
    ok_json(json!({ "source": "local-gateway", "projects": names, "projectRows": rows }))
}

async fn chat_completions(
    State(cfg): State<SharedConfig>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    let (base, key, model) = {
        let g = cfg.read().unwrap();
        (g.chat_base.clone(), g.chat_key.clone(), g.chat_model.clone())
    };
    if base.is_empty() {
        return upstream_err("chat upstream not configured");
    }

    if !model.is_empty() {
        body["model"] = json!(model);
    }

    let url = build_chat_url(&base);
    let client = match crate::http_client(300) {
        Ok(c) => c,
        Err(e) => return upstream_err(&e),
    };
    let mut rb = client.post(&url).json(&body);
    if !key.is_empty() {
        rb = rb.bearer_auth(&key);
    } else if let Some(auth) = headers.get(header::AUTHORIZATION) {
        rb = rb.header(header::AUTHORIZATION, auth);
    }

    match rb.send().await {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(text))
                .unwrap()
        }
        Err(e) => upstream_err(&format!("chat upstream request failed: {e}")),
    }
}

fn build_chat_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") {
        b.to_string()
    } else if b.ends_with("/v1") {
        format!("{b}/chat/completions")
    } else {
        format!("{b}/v1/chat/completions")
    }
}

fn ok_json(v: Value) -> Response {
    (StatusCode::OK, Json(v)).into_response()
}

fn upstream_err(msg: &str) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": { "message": msg } })),
    )
        .into_response()
}
