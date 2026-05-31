use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

// ---------- request payloads (sent from the frontend) ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnReq {
    base_url: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenReq {
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    n: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditReq {
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    /// source image as a data URI: `data:image/png;base64,....`
    image: String,
}

// ---------- response sent back to the frontend ----------

#[derive(Serialize)]
struct ImageOut {
    /// raw base64 (no data: prefix) for in-app preview
    b64: String,
    mime: String,
    /// absolute path the image was saved to on disk
    saved_path: String,
}

// ---------- helpers ----------

fn normalize_base(base: &str) -> String {
    let mut b = base.trim().trim_end_matches('/').to_string();
    if b.ends_with("/v1") {
        b.truncate(b.len() - 3);
    }
    b
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
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

/// Scan free-form text for http(s) URLs and `data:image/...` URIs.
fn extract_urls(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = s.char_indices().peekable();
    while let Some((i, _)) = chars.next() {
        let rest = &s[i..];
        if rest.starts_with("http://") || rest.starts_with("https://") || rest.starts_with("data:image/") {
            let end = rest
                .find(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | '"' | '\'' | '<' | '>' | '`'))
                .unwrap_or(rest.len());
            out.push(rest[..end].to_string());
            // skip the chars we just consumed
            let target = i + end;
            while let Some(&(j, _)) = chars.peek() {
                if j < target {
                    chars.next();
                } else {
                    break;
                }
            }
        }
    }
    out
}

/// Resolve an image source (http(s) URL or data URI) to raw bytes + mime.
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
) -> Result<ImageOut, String> {
    let saved_path = save_image(app, &bytes, &mime, tag, idx)?;
    Ok(ImageOut {
        b64: B64.encode(&bytes),
        mime,
        saved_path,
    })
}

// ---------- commands ----------

/// GET /v1/models — also doubles as a "test connection" check.
#[tauri::command]
async fn list_models(req: ConnReq) -> Result<Vec<String>, String> {
    let base = normalize_base(&req.base_url);
    let c = http_client()?;
    let resp = c
        .get(format!("{base}/v1/models"))
        .bearer_auth(&req.api_key)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("接口返回 {status}: {}", truncate(&text, 300)));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {e}"))?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

/// POST /v1/images/generations (text → image, OpenAI-compatible).
#[tauri::command]
async fn generate_image(app: tauri::AppHandle, req: GenReq) -> Result<Vec<ImageOut>, String> {
    let base = normalize_base(&req.base_url);
    let c = http_client()?;
    let mut body = serde_json::json!({
        "model": req.model,
        "prompt": req.prompt,
        "n": req.n.unwrap_or(1),
    });
    if let Some(size) = req.size.as_ref().filter(|s| !s.is_empty()) {
        body["size"] = serde_json::json!(size);
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
        return Err(format!("接口返回 {status}: {}", truncate(&text, 400)));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {e}"))?;
    let data = v["data"]
        .as_array()
        .ok_or_else(|| format!("响应缺少 data 数组: {}", truncate(&text, 300)))?;
    let mut outs = Vec::new();
    for (i, item) in data.iter().enumerate() {
        let (bytes, mime) = if let Some(b64) = item["b64_json"].as_str() {
            (
                B64.decode(b64.trim())
                    .map_err(|e| format!("base64 解码失败: {e}"))?,
                "image/png".to_string(),
            )
        } else if let Some(url) = item["url"].as_str() {
            src_to_bytes(&c, url).await?
        } else {
            continue;
        };
        outs.push(to_out(&app, bytes, mime, "txt2img", i)?);
    }
    if outs.is_empty() {
        return Err(format!("未从响应中解析到图片: {}", truncate(&text, 300)));
    }
    Ok(outs)
}

/// Image → image. The gateway has no /v1/images/edits, so we use the
/// multimodal /v1/chat/completions shape (image-capable model returns an image).
#[tauri::command]
async fn edit_image(app: tauri::AppHandle, req: EditReq) -> Result<Vec<ImageOut>, String> {
    let base = normalize_base(&req.base_url);
    let c = http_client()?;
    let body = serde_json::json!({
        "model": req.model,
        "stream": false,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": req.prompt},
                {"type": "image_url", "image_url": {"url": req.image}}
            ]
        }]
    });
    let resp = c
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(&req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("接口返回 {status}: {}", truncate(&text, 400)));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {e}"))?;
    let msg = &v["choices"][0]["message"];

    let mut srcs: Vec<String> = Vec::new();
    // some gateways return images under message.images[]
    if let Some(imgs) = msg["images"].as_array() {
        for im in imgs {
            if let Some(u) = im["url"].as_str() {
                srcs.push(u.to_string());
            } else if let Some(u) = im["image_url"]["url"].as_str() {
                srcs.push(u.to_string());
            } else if let Some(u) = im.as_str() {
                srcs.push(u.to_string());
            }
        }
    }
    // content may be a plain string or an array of parts
    match &msg["content"] {
        serde_json::Value::String(s) => srcs.extend(extract_urls(s)),
        serde_json::Value::Array(arr) => {
            for it in arr {
                if let Some(u) = it["image_url"]["url"].as_str() {
                    srcs.push(u.to_string());
                } else if let Some(s) = it["text"].as_str() {
                    srcs.extend(extract_urls(s));
                }
            }
        }
        _ => {}
    }
    srcs.dedup();

    if srcs.is_empty() {
        let content_text = msg["content"].as_str().unwrap_or("");
        let shown = if content_text.is_empty() { &text } else { content_text };
        return Err(format!("未返回图片。模型回复：{}", truncate(shown, 400)));
    }

    let mut outs = Vec::new();
    for (i, src) in srcs.iter().enumerate() {
        if let Ok((bytes, mime)) = src_to_bytes(&c, src).await {
            outs.push(to_out(&app, bytes, mime, "img2img", i)?);
        }
    }
    if outs.is_empty() {
        return Err("解析到图片链接但下载失败".to_string());
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
        .invoke_handler(tauri::generate_handler![
            list_models,
            generate_image,
            edit_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
