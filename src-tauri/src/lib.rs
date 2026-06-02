use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// Monotonic counter so concurrent tasks never collide on a filename.
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Default image host. Local reference images (`data:` URIs / raw base64) are
/// uploaded here to obtain a public URL the generation API can fetch.
/// Overridable per request via `GenReq::upload_url`.
const DEFAULT_UPLOAD_URL: &str = "https://imageproxy.zhongzhuan.chat/api/upload";

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

// ---------- helpers ----------

fn normalize_base(base: &str) -> String {
    let mut b = base.trim().trim_end_matches('/').to_string();
    if b.ends_with("/v1") {
        b.truncate(b.len() - 3);
    }
    b
}

fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
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

fn ext_for(mime: &str) -> &'static str {
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
async fn src_to_bytes(c: &reqwest::Client, src: &str) -> Result<(Vec<u8>, String), String> {
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

/// Pull a public URL out of the image-host upload response.
/// Mirrors the host's shapes: `url` | `data.url` | `result.url` | `file.url`.
fn extract_uploaded_url(v: &serde_json::Value) -> Option<String> {
    let pick = |s: Option<&str>| s.filter(|x| !x.is_empty()).map(str::to_string);
    pick(v["url"].as_str())
        .or_else(|| pick(v["data"]["url"].as_str()))
        .or_else(|| pick(v["result"]["url"].as_str()))
        .or_else(|| pick(v["file"]["url"].as_str()))
}

/// Upload raw image bytes to the host (multipart `file` field, Bearer auth)
/// and return the public http(s) URL it responds with.
async fn upload_image(
    c: &reqwest::Client,
    upload_url: &str,
    bytes: Vec<u8>,
    mime: &str,
) -> Result<String, String> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("ref.{}", ext_for(mime)))
        .mime_str(mime)
        .map_err(|e| format!("构造上传数据失败: {e}"))?;
    let form = reqwest::multipart::Form::new().part("file", part);
    // The image host accepts anonymous uploads — do NOT forward the generation
    // API key to this third-party host.
    let resp = c
        .post(upload_url)
        .multipart(form)
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
async fn ref_to_url(c: &reqwest::Client, upload_url: &str, src: &str) -> Result<String, String> {
    let s = src.trim();
    if s.starts_with("http://") || s.starts_with("https://") {
        return Ok(s.to_string());
    }
    let (bytes, mime) = resolve_src(c, s).await?;
    upload_image(c, upload_url, bytes, &mime).await
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

/// POST {base}/v1/images/generations (OpenAI-compatible).
/// Text-to-image when `image` is empty; image-to-image when it has reference URLs.
#[tauri::command]
async fn generate_images(app: tauri::AppHandle, req: GenReq) -> Result<Vec<ImageOut>, String> {
    if req.prompt.trim().is_empty() {
        return Err("prompt 不能为空".into());
    }
    let base = normalize_base(&req.base_url);
    // server waits up to timeout_sec; give the client a margin on top.
    let timeout_sec = req.timeout_sec.unwrap_or(300).clamp(10, 1800);
    let c = http_client(timeout_sec as u64 + 60)?;

    // Only fields allowed by the schema (additionalProperties: false).
    let mut body = serde_json::json!({
        "model": req.model,
        "prompt": req.prompt,
    });
    if let Some(size) = req.size.as_ref().filter(|s| !s.is_empty()) {
        body["size"] = serde_json::json!(size);
    }
    let raw_refs: Vec<&String> = req.image.iter().filter(|s| !s.trim().is_empty()).collect();
    let is_i2i = !raw_refs.is_empty();
    if is_i2i {
        // The generation API only fetches http(s) URLs, so any local image
        // (an uploaded file or pasted clipboard image arrives as a `data:` URI)
        // is uploaded to the image host first to obtain a public URL.
        let upload_url = req
            .upload_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_UPLOAD_URL);
        let mut ref_urls: Vec<String> = Vec::with_capacity(raw_refs.len());
        for src in &raw_refs {
            ref_urls.push(ref_to_url(&c, upload_url, src).await?);
        }
        body["image"] = serde_json::json!(ref_urls);
    }
    body["timeout_sec"] = serde_json::json!(timeout_sec);
    if let Some(tier) = req.account_tier.as_ref().filter(|s| !s.is_empty()) {
        body["debug_account_tier"] = serde_json::json!(tier);
    }
    if let Some(tok) = req.debug_token.as_ref().filter(|s| !s.is_empty()) {
        body["debug_chatgpt_token"] = serde_json::json!(tok);
    }

    // Single attempt (no retry). We time it so we can tell *where* it dies:
    // a consistent elapsed value points at a gateway/LB timeout closing the
    // connection; near-instant means the connection never really opened.
    let url = format!("{base}/v1/images/generations");
    let started = std::time::Instant::now();
    let send_result = c
        .post(&url)
        .bearer_auth(&req.api_key)
        .json(&body)
        .send()
        .await;
    let elapsed = started.elapsed();
    let resp = match send_result {
        Ok(resp) => {
            eprintln!(
                "[generate_images] 收到响应头: {} {:?} (耗时 {:.1}s)",
                resp.status(),
                resp.version(),
                elapsed.as_secs_f64()
            );
            resp
        }
        Err(e) => {
            // Full source chain for a readable, actionable message.
            let mut detail = e.to_string();
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                detail.push_str(&format!("\n  ↳ {s}"));
                src = s.source();
            }
            eprintln!(
                "[generate_images] send 失败,耗时 {:.1}s — 服务器在返回任何响应头之前就关闭了连接(没有可打印的返回值)。",
                elapsed.as_secs_f64()
            );
            eprintln!("[generate_images] {e:#?}");
            return Err(format!(
                "请求失败(等待 {:.0}s 后连接被关闭,服务器未返回任何数据): {detail}",
                elapsed.as_secs_f64()
            ));
        }
    };
    let status = resp.status();
    // Stream the body so a partial/truncated payload is still logged before we
    // error out — this is the only place a "return value" could exist.
    let text = match resp.text().await {
        Ok(text) => {
            eprintln!(
                "[generate_images] 响应体读取完成: {} 字节,总耗时 {:.1}s\n[generate_images] 返回内容: {}",
                text.len(),
                started.elapsed().as_secs_f64(),
                truncate(&text, 1200)
            );
            text
        }
        Err(e) => {
            eprintln!(
                "[generate_images] 读取响应体失败,总耗时 {:.1}s: {e:#?}",
                started.elapsed().as_secs_f64()
            );
            return Err(format!("读取响应失败: {e}"));
        }
    };
    if !status.is_success() {
        return Err(error_message(status, &text));
    }

    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {e}"))?;
    let data = v["data"]
        .as_array()
        .ok_or_else(|| format!("响应缺少 data 数组: {}", truncate(&text, 300)))?;

    let tag = if is_i2i { "img2img" } else { "txt2img" };
    let mut outs = Vec::new();
    let mut last_err = String::new();
    for (i, item) in data.iter().enumerate() {
        // Per spec both `url` and `b64_json` hold the image URL; prefer `url`.
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
                outs.push(to_out(&app, bytes, mime, tag, i, source_url)?);
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![generate_images])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
