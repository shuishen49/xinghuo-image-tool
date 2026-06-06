use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

mod gateway;

/// Monotonic counter so concurrent tasks never collide on a filename.
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Upstream credentials the embedded gateway (gateway.rs) needs to serve the
/// drama workspace: the image API (storyboard image gen, shared with the normal
/// image tool), the chat endpoint (sub2api), pic2api video generation, dashscope
/// voice dubbing, and ffmpeg for frame capture. The frontend pushes these via
/// `configure_gateway` whenever settings are saved, so keys never leak into the
/// iframe'd workspace page.
#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    // --- image api (shared with the normal image tool) ---
    #[serde(default)]
    pub img_base: String,
    #[serde(default)]
    pub img_key: String,
    #[serde(default)]
    pub img_model: String,
    #[serde(default)]
    pub img_upload_url: String,
    #[serde(default)]
    pub img_timeout: u32,
    // --- chat upstream (sub2api) ---
    #[serde(default)]
    pub chat_base: String,
    #[serde(default)]
    pub chat_key: String,
    #[serde(default)]
    pub chat_model: String,
    // --- pic2api video generation ---
    #[serde(default)]
    pub pic2api_base: String,
    #[serde(default)]
    pub pic2api_key: String,
    #[serde(default)]
    pub pic2api_model: String,
    // --- dashscope voice dubbing ---
    #[serde(default)]
    pub dashscope_key: String,
    #[serde(default)]
    pub dashscope_design_model: String,
    #[serde(default)]
    pub dashscope_tts_model: String,
    // --- ffmpeg ---
    #[serde(default)]
    pub ffmpeg_path: String,
    /// Port the embedded server actually bound to (filled in Rust-side).
    #[serde(skip)]
    pub self_port: u16,
    /// Root dir the gateway serves user project data + generated images from.
    #[serde(skip)]
    pub workspace_dir: PathBuf,
}

pub type SharedConfig = Arc<RwLock<GatewayConfig>>;

// Local reference images (`data:` URIs / raw base64) are uploaded to the
// platform's own OSS endpoint ({base}/api/v1/uploads/upload?public=true) to get
// a public URL the generation API can fetch. See `generate_images`.

// ---------- request payload (sent from the frontend) ----------

/// Mirrors the OpenAI-compatible `ImageGenerationsRequest`.
/// Image-to-image is the same call with a non-empty `image` array.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenReq {
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    #[serde(default)]
    size: Option<String>,
    /// reference images for image-to-image: http(s) URLs or `data:` URIs
    #[serde(default)]
    image: Vec<String>,
    #[serde(default)]
    timeout_sec: Option<u32>,
    /// optional debug: debug_account_tier (free | plus | think)
    #[serde(default)]
    account_tier: Option<String>,
    /// optional debug: debug_chatgpt_token
    #[serde(default)]
    debug_token: Option<String>,
    /// override for the image-upload endpoint; empty/None -> DEFAULT_UPLOAD_URL
    #[serde(default)]
    upload_url: Option<String>,
}

// ---------- response sent back to the frontend ----------

#[derive(Serialize)]
struct ImageOut {
    /// raw base64 (no data: prefix) for in-app preview
    b64: String,
    mime: String,
    /// absolute path the image was saved to on disk
    saved_path: String,
    /// original remote URL the API returned (when available)
    source_url: Option<String>,
}

/// Base64 + mime of an image read back from disk (for restoring persisted tasks).
#[derive(Serialize)]
struct SavedImage {
    b64: String,
    mime: String,
}

pub(crate) fn mime_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    }
}

/// Read a previously-saved image file and return it as base64 for preview.
/// Used when the app reopens and re-renders persisted task results from disk
/// (so we never have to store heavy base64 in the browser's localStorage).
#[tauri::command]
fn read_saved_image(path: String) -> Result<SavedImage, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
    Ok(SavedImage {
        b64: B64.encode(&bytes),
        mime: mime_for_path(&path).to_string(),
    })
}

// ---------- helpers ----------

fn normalize_base(base: &str) -> String {
    let mut b = base.trim().trim_end_matches('/').to_string();
    if b.ends_with("/v1") {
        b.truncate(b.len() - 3);
    }
    b
}

pub(crate) fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    // NOTE: do NOT set .tcp_keepalive() here. Image generation keeps the
    // connection silent for several minutes; on some network paths a stateful
    // firewall/NAT drops the keepalive probe packets, so enabling keepalive
    // actually causes the OS to declare the connection dead at ~120s
    // ("connection closed before message completed"). curl (no keepalive)
    // survives the same request for 200s+, so we mirror that: just a timeout.
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        // Use rustls so ALPN reliably negotiates HTTP/2. Windows' native SChannel
        // often falls back to HTTP/1.1, and this Envoy gateway appears to cut
        // idle HTTP/1.1 connections at ~120s (curl over HTTP/2 survives 200s+).
        .use_rustls_tls()
        // The gateway closes a connection that carries no data for ~120s. Image
        // generation keeps the connection silent for minutes while the server
        // renders, so we send HTTP/2 PING frames as an application-level
        // heartbeat. Unlike TCP keepalive (plaintext probes that firewalls drop)
        // these PINGs travel *inside* TLS, so the gateway sees them and keeps
        // resetting its idle timer — this is why curl over HTTP/2 survives.
        .http2_keep_alive_interval(std::time::Duration::from_secs(20))
        .http2_keep_alive_timeout(std::time::Duration::from_secs(20))
        .http2_keep_alive_while_idle(true)
        // Don't reuse a long-lived pooled connection across parallel requests.
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| format!("无法创建 HTTP 客户端: {e}"))
}

pub(crate) fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let head: String = s.chars().take(n).collect();
        format!("{head}…")
    }
}

/// Heuristic: a long string made only of base64 characters (no scheme).
fn looks_like_base64(s: &str) -> bool {
    let s = s.trim();
    s.len() > 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

/// Pull a user-readable message out of an error response body.
/// The spec prefers `message` (model/upstream text) over `error` (program reason).
fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        let msg = v["message"].as_str().filter(|s| !s.is_empty());
        let err = v["error"].as_str().filter(|s| !s.is_empty());
        // nested OpenAI-style { "error": { "message": "..." } }
        let nested = v["error"]["message"].as_str().filter(|s| !s.is_empty());
        if let Some(m) = msg.or(nested).or(err) {
            return m.to_string();
        }
    }
    format!("接口返回 {}: {}", status.as_u16(), truncate(body, 300))
}

/// Resolve an image source returned by the API or supplied as a reference.
/// May be an http(s) URL, a `data:` URI, or (defensively) raw base64.
async fn resolve_src(c: &reqwest::Client, src: &str) -> Result<(Vec<u8>, String), String> {
    if src.starts_with("http://") || src.starts_with("https://") || src.starts_with("data:") {
        src_to_bytes(c, src).await
    } else if looks_like_base64(src) {
        let bytes = B64
            .decode(src.trim())
            .map_err(|e| format!("base64 解码失败: {e}"))?;
        Ok((bytes, "image/png".to_string()))
    } else {
        Err(format!("无法识别的图片来源: {}", truncate(src, 80)))
    }
}

/// Resolve an http(s) URL or `data:` URI to raw bytes + mime.
pub(crate) async fn src_to_bytes(c: &reqwest::Client, src: &str) -> Result<(Vec<u8>, String), String> {
    if let Some(rest) = src.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',').ok_or("无效的 data URI")?;
        let mime = meta.split(';').next().unwrap_or("image/png").to_string();
        let bytes = B64
            .decode(data.trim())
            .map_err(|e| format!("base64 解码失败: {e}"))?;
        Ok((bytes, mime))
    } else {
        let resp = c
            .get(src)
            .send()
            .await
            .map_err(|e| format!("下载图片失败: {e}"))?;
        let mime = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(';').next().unwrap_or("image/png").to_string())
            .unwrap_or_else(|| "image/png".to_string());
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取图片字节失败: {e}"))?
            .to_vec();
        Ok((bytes, mime))
    }
}

/// Pull a public URL out of the upload response.
/// Platform OSS (`/api/v1/uploads/upload`) returns `data.signed_url` /
/// `data.oss_url`; older third-party hosts use `url` | `data.url` | etc.
/// Prefer `signed_url` (immediately fetchable), then the public `oss_url`.
fn extract_uploaded_url(v: &serde_json::Value) -> Option<String> {
    let pick = |s: Option<&str>| s.filter(|x| !x.is_empty()).map(str::to_string);
    pick(v["data"]["signed_url"].as_str())
        .or_else(|| pick(v["data"]["oss_url"].as_str()))
        .or_else(|| pick(v["signed_url"].as_str()))
        .or_else(|| pick(v["oss_url"].as_str()))
        .or_else(|| pick(v["url"].as_str()))
        .or_else(|| pick(v["data"]["url"].as_str()))
        .or_else(|| pick(v["result"]["url"].as_str()))
        .or_else(|| pick(v["file"]["url"].as_str()))
}

/// Upload raw image bytes to the host (multipart `file` field, Bearer auth)
/// and return the public http(s) URL it responds with.
async fn upload_image(
    c: &reqwest::Client,
    upload_url: &str,
    api_key: Option<&str>,
    bytes: Vec<u8>,
    mime: &str,
) -> Result<String, String> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("ref.{}", ext_for(mime)))
        .mime_str(mime)
        .map_err(|e| format!("构造上传数据失败: {e}"))?;
    let form = reqwest::multipart::Form::new().part("file", part);
    // The platform OSS endpoint authenticates with the API key; a third-party
    // host (if explicitly configured) takes anonymous uploads (api_key = None).
    let mut rb = c.post(upload_url).multipart(form);
    if let Some(key) = api_key {
        rb = rb.bearer_auth(key);
    }
    let resp = rb
        .send()
        .await
        .map_err(|e| format!("上传图片失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取上传响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "上传图片失败 {}: {}",
            status.as_u16(),
            truncate(&text, 300)
        ));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析上传响应失败: {e}"))?;
    extract_uploaded_url(&v)
        .ok_or_else(|| format!("上传响应里找不到图片地址: {}", truncate(&text, 300)))
}

/// Turn a reference image into an http(s) URL the generation API can fetch.
/// http(s) URLs pass through; `data:` URIs / raw base64 are uploaded first.
async fn ref_to_url(
    c: &reqwest::Client,
    upload_url: &str,
    api_key: Option<&str>,
    src: &str,
) -> Result<String, String> {
    let s = src.trim();
    if s.starts_with("http://") || s.starts_with("https://") {
        return Ok(s.to_string());
    }
    let (bytes, mime) = resolve_src(c, s).await?;
    upload_image(c, upload_url, api_key, bytes, &mime).await
}

/// Save bytes under <Pictures>/xinghuo-image-tool/ and return the absolute path.
fn save_image(
    app: &tauri::AppHandle,
    bytes: &[u8],
    mime: &str,
    tag: &str,
    idx: usize,
) -> Result<String, String> {
    let base_dir = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("无法定位保存目录: {e}"))?;
    let dir = base_dir.join("xinghuo-image-tool");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("{tag}-{ts}-{seq}-{idx}.{}", ext_for(mime)));
    std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn to_out(
    app: &tauri::AppHandle,
    bytes: Vec<u8>,
    mime: String,
    tag: &str,
    idx: usize,
    source_url: Option<String>,
) -> Result<ImageOut, String> {
    let saved_path = save_image(app, &bytes, &mime, tag, idx)?;
    Ok(ImageOut {
        b64: B64.encode(&bytes),
        mime,
        saved_path,
        source_url,
    })
}

// ---------- command ----------

/// Core generation call shared by the Tauri command and the embedded gateway.
/// POSTs {base}/v1/images/generations (OpenAI-compatible) and returns the list
/// of resolved (bytes, mime, source_url) images. Reference images are uploaded
/// to OSS first when doing image-to-image. Saving to disk is the caller's job.
pub async fn run_generation(
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    size: Option<&str>,
    refs: &[String],
    timeout_sec: u32,
    account_tier: Option<&str>,
    debug_token: Option<&str>,
    upload_url_override: Option<&str>,
) -> Result<Vec<(Vec<u8>, String, Option<String>)>, String> {
    if prompt.trim().is_empty() {
        return Err("prompt 不能为空".into());
    }
    let base = normalize_base(base_url);
    let timeout_sec = timeout_sec.clamp(10, 1800);
    let c = http_client(timeout_sec as u64 + 60)?;

    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
    });
    if let Some(size) = size.filter(|s| !s.is_empty()) {
        body["size"] = serde_json::json!(size);
    }
    let raw_refs: Vec<&String> = refs.iter().filter(|s| !s.trim().is_empty()).collect();
    let is_i2i = !raw_refs.is_empty();
    if is_i2i {
        let custom_host = upload_url_override
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.contains("imageproxy.zhongzhuan.chat"));
        let (upload_url, upload_key): (String, Option<&str>) = match custom_host {
            Some(host) => (host.to_string(), None),
            None => (
                format!("{base}/api/v1/uploads/upload?public=true"),
                Some(api_key),
            ),
        };
        eprintln!("[run_generation] 参考图上传到: {upload_url}");
        let mut ref_urls: Vec<String> = Vec::with_capacity(raw_refs.len());
        for src in &raw_refs {
            ref_urls.push(ref_to_url(&c, &upload_url, upload_key, src).await?);
        }
        eprintln!("[run_generation] 参考图 URL: {ref_urls:?}");
        body["image"] = serde_json::json!(ref_urls);
    }
    body["timeout_sec"] = serde_json::json!(timeout_sec);
    if let Some(tier) = account_tier.filter(|s| !s.is_empty()) {
        body["debug_account_tier"] = serde_json::json!(tier);
    }
    if let Some(tok) = debug_token.filter(|s| !s.is_empty()) {
        body["debug_chatgpt_token"] = serde_json::json!(tok);
    }

    let url = format!("{base}/v1/images/generations");
    let max_attempts: u32 = 3;
    let mut attempt: u32 = 0;
    let text = loop {
        attempt += 1;
        let started = std::time::Instant::now();
        let send_result = c
            .post(&url)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await;
        let elapsed = started.elapsed();
        let resp = match send_result {
            Ok(resp) => {
                eprintln!(
                    "[run_generation] 收到响应头: {} {:?} (耗时 {:.1}s, 第 {attempt}/{max_attempts} 次)",
                    resp.status(),
                    resp.version(),
                    elapsed.as_secs_f64()
                );
                resp
            }
            Err(e) => {
                let mut detail = e.to_string();
                let mut src = std::error::Error::source(&e);
                while let Some(s) = src {
                    detail.push_str(&format!("\n  ↳ {s}"));
                    src = s.source();
                }
                return Err(format!(
                    "请求失败(等待 {:.0}s 后连接被关闭,服务器未返回任何数据): {detail}",
                    elapsed.as_secs_f64()
                ));
            }
        };
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {e}"))?;
        if status.is_success() {
            break text;
        }
        let low = text.to_lowercase();
        let transient = low.contains("token_revoked")
            || low.contains("invalidated oauth token")
            || low.contains("upload image failed")
            || status.as_u16() == 503;
        if transient && attempt < max_attempts {
            eprintln!("[run_generation] 账号/上传类临时错误,重试 ({attempt}/{max_attempts})…");
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }
        return Err(error_message(status, &text));
    };

    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {e}"))?;
    let data = v["data"]
        .as_array()
        .ok_or_else(|| format!("响应缺少 data 数组: {}", truncate(&text, 300)))?;

    let mut outs = Vec::new();
    let mut last_err = String::new();
    for item in data.iter() {
        let Some(src) = item["url"]
            .as_str()
            .or_else(|| item["b64_json"].as_str())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        match resolve_src(&c, src).await {
            Ok((bytes, mime)) => {
                let source_url = src.starts_with("http").then(|| src.to_string());
                outs.push((bytes, mime, source_url));
            }
            Err(e) => last_err = e,
        }
    }
    if outs.is_empty() {
        let detail = if last_err.is_empty() {
            truncate(&text, 300)
        } else {
            last_err
        };
        return Err(format!("未从响应中获取到图片: {detail}"));
    }
    Ok(outs)
}

/// POST {base}/v1/images/generations (OpenAI-compatible).
/// Text-to-image when `image` is empty; image-to-image when it has reference URLs.
#[tauri::command]
async fn generate_images(app: tauri::AppHandle, req: GenReq) -> Result<Vec<ImageOut>, String> {
    let is_i2i = req.image.iter().any(|s| !s.trim().is_empty());
    let outs = run_generation(
        &req.base_url,
        &req.api_key,
        &req.model,
        &req.prompt,
        req.size.as_deref(),
        &req.image,
        req.timeout_sec.unwrap_or(300),
        req.account_tier.as_deref(),
        req.debug_token.as_deref(),
        req.upload_url.as_deref(),
    )
    .await?;

    let tag = if is_i2i { "img2img" } else { "txt2img" };
    let mut result = Vec::new();
    for (i, (bytes, mime, source_url)) in outs.into_iter().enumerate() {
        result.push(to_out(&app, bytes, mime, tag, i, source_url)?);
    }
    Ok(result)
}

/// Push upstream credentials from the frontend into the gateway's shared state.
/// Called whenever the user saves settings, so the iframe'd drama workspace can
/// generate storyboard images, chat, video (pic2api) and voice (dashscope) without
/// holding any keys.
#[tauri::command]
fn configure_gateway(state: tauri::State<'_, SharedConfig>, cfg: GatewayConfig) {
    let mut guard = state.write().unwrap();
    guard.img_base = cfg.img_base;
    guard.img_key = cfg.img_key;
    guard.img_model = cfg.img_model;
    guard.img_upload_url = cfg.img_upload_url;
    guard.img_timeout = cfg.img_timeout;
    guard.chat_base = cfg.chat_base;
    guard.chat_key = cfg.chat_key;
    guard.chat_model = cfg.chat_model;
    guard.pic2api_base = cfg.pic2api_base;
    guard.pic2api_key = cfg.pic2api_key;
    guard.pic2api_model = cfg.pic2api_model;
    guard.dashscope_key = cfg.dashscope_key;
    guard.dashscope_design_model = cfg.dashscope_design_model;
    guard.dashscope_tts_model = cfg.dashscope_tts_model;
    guard.ffmpeg_path = cfg.ffmpeg_path;
}

/// URL of the embedded workspace server, e.g. `http://127.0.0.1:12733/main.html`.
/// The frontend navigates an iframe here to open the drama workspace.
#[tauri::command]
fn gateway_url(state: tauri::State<'_, SharedConfig>) -> String {
    let port = state.read().unwrap().self_port;
    format!("http://127.0.0.1:{port}")
}

#[tauri::command]
async fn test_chat_base(base: String, key: String, model: String) -> Result<String, String> {
    let b = base.trim().trim_end_matches('/');
    if b.is_empty() {
        return Err("Base URL 为空".into());
    }
    let url = if b.ends_with("/chat/completions") {
        b.to_string()
    } else if b.ends_with("/v1") {
        format!("{b}/chat/completions")
    } else {
        format!("{b}/v1/chat/completions")
    };
    let client = http_client(30).map_err(|e| e)?;
    let payload = serde_json::json!({
        "model": if model.trim().is_empty() { "gpt-4o-mini".to_string() } else { model.trim().to_string() },
        "messages": [{"role":"user","content":"ping"}],
        "max_tokens": 1,
        "stream": false
    });
    let mut rb = client.post(&url).json(&payload);
    if !key.trim().is_empty() {
        rb = rb.bearer_auth(key.trim());
    }
    match rb.send().await {
        Ok(r) => {
            let st = r.status();
            if st.is_success() {
                Ok(format!("连接正常 (HTTP {})", st.as_u16()))
            } else {
                let body = r.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(160).collect();
                Err(format!("HTTP {}：{}", st.as_u16(), snippet))
            }
        }
        Err(e) => Err(format!("请求失败：{e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Workspace dir: <Pictures>/xinghuo-image-tool/projects (shares the
            // root where generated images already land). The gateway serves
            // project JSON + saved scene images out of here.
            let workspace_dir = app
                .path()
                .picture_dir()
                .or_else(|_| app.path().app_data_dir())
                .map(|d| d.join("xinghuo-image-tool").join("projects"))
                .unwrap_or_else(|_| std::env::temp_dir().join("xinghuo-projects"));
            let _ = std::fs::create_dir_all(&workspace_dir);

            let config: SharedConfig = Arc::new(RwLock::new(GatewayConfig {
                workspace_dir,
                ..Default::default()
            }));
            let port = gateway::start(config.clone());
            config.write().unwrap().self_port = port;
            app.manage(config);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            generate_images,
            read_saved_image,
            configure_gateway,
            gateway_url,
            test_chat_base
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
