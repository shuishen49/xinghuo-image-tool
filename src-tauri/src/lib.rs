use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

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
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
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
    let path = dir.join(format!("{tag}-{ts}-{idx}.{}", ext_for(mime)));
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
    let refs: Vec<&String> = req.image.iter().filter(|s| !s.trim().is_empty()).collect();
    let is_i2i = !refs.is_empty();
    if is_i2i {
        body["image"] = serde_json::json!(refs);
    }
    body["timeout_sec"] = serde_json::json!(timeout_sec);
    if let Some(tier) = req.account_tier.as_ref().filter(|s| !s.is_empty()) {
        body["debug_account_tier"] = serde_json::json!(tier);
    }
    if let Some(tok) = req.debug_token.as_ref().filter(|s| !s.is_empty()) {
        body["debug_chatgpt_token"] = serde_json::json!(tok);
    }

    let resp = c
        .post(format!("{base}/v1/images/generations"))
        .bearer_auth(&req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
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
