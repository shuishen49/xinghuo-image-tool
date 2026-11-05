//! Size-bounded diagnostic log for field debugging.
//!
//! Why this exists: a release Windows GUI build has no console, so every
//! `eprintln!` in this codebase is silently discarded on the user's machine.
//! `tauri-plugin-log` is only attached in debug builds. When a user reports
//! "download failed" there is literally nothing to hand over.
//!
//! Design constraints (agreed with the maintainer):
//! - Total on-disk size never exceeds 512 KiB: `app.log` + `app.1.log`,
//!   256 KiB each, oldest half dropped on rotation. No growth over time.
//! - Zero extra dependencies, so `cargo build --offline` keeps working.
//! - Every line is self-describing (UTC timestamp / level / scope / task id /
//!   event / key=value fields), so a pasted excerpt is enough to reconstruct
//!   an entire failed generation.
//! - Never persist secrets: API keys, JWTs, passwords, prompt text, image
//!   bytes, and signed-URL query parameters are masked before hitting disk
//!   or the clipboard.

use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Each half of the ring. Two halves => hard cap of 512 KiB on disk.
const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Guard against a single giant field (e.g. an upstream error page).
const MAX_LINE_CHARS: usize = 2000;
/// "Copy recent log" produces something pasteable into a chat window.
const COPY_TAIL_BYTES: usize = 64 * 1024;

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static TASK_SEQ: AtomicU64 = AtomicU64::new(0);

struct State {
    dir: PathBuf,
    cur: PathBuf,
    prev: PathBuf,
}

/// Non-secret environment snapshot supplied by the frontend when exporting.
/// All fields are optional so an older/mismatched frontend can never break
/// the export path.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiagContext {
    pub base_url: String,
    pub model: String,
    pub auth_mode: String,
    pub timeout_sec: u32,
    pub max_concurrent: u32,
    pub upload_url_custom: bool,
    pub os: String,
    pub local_time: String,
    pub note: String,
}

pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let st = State {
        cur: dir.join("app.log"),
        prev: dir.join("app.1.log"),
        dir,
    };
    rotate_if_full(&st);
    let _ = STATE.set(Mutex::new(st));
    log(
        "INFO",
        "app",
        "-",
        "app_start",
        &format!(
            "version={} os={} arch={}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );
}

fn state() -> Option<MutexGuard<'static, State>> {
    STATE.get().and_then(|m| m.lock().ok())
}

/// A short id that ties every line of one generation together, even when
/// several tasks run concurrently.
pub fn task_id() -> String {
    let n = TASK_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("g{:x}-{}", now_ms() % 0xfff_fff, n)
}

/// Write one structured line. Called from both the Tauri commands and the
/// embedded gateway, always under a mutex so concurrent tasks interleave by
/// line rather than by byte.
pub fn log(level: &str, scope: &str, task: &str, event: &str, fields: &str) {
    let clean: String = scrub(fields).chars().take(MAX_LINE_CHARS).collect();
    let line = format!(
        "{} [{:<5}] [{:<5}] [{}] event={} {}\n",
        utc_now(),
        level,
        scope,
        task,
        event,
        clean
    );
    if let Some(st) = state() {
        append(&line, &st);
    }
    // Keep console output useful during `tauri dev`. Use write_all + ignore
    // the result: `eprint!` panics when stderr is unusable, which is exactly
    // the situation on a release Windows GUI build. Logging must never be
    // able to crash the app it is trying to diagnose.
    let _ = std::io::stderr().write_all(line.as_bytes());
}

fn rotate_if_full(st: &State) {
    let full = fs::metadata(&st.cur)
        .map(|m| m.len() >= MAX_FILE_BYTES)
        .unwrap_or(false);
    if full {
        let _ = fs::remove_file(&st.prev);
        let _ = fs::rename(&st.cur, &st.prev);
    }
}

fn append(line: &str, st: &State) {
    rotate_if_full(st);
    // Open/write/flush per line: a crash or forced kill must not lose the
    // failure that the user is trying to report. Log volume is tiny.
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&st.cur) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

// ---------- redaction ----------

fn is_sensitive(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    [
        "token",
        "key",
        "secret",
        "sign",
        "credential",
        "auth",
        "password",
        "pwd",
    ]
    .iter()
    .any(|s| k.contains(s))
}

fn mask_query(q: &str) -> String {
    q.split('&')
        .map(|pair| match pair.split_once('=') {
            Some((k, _)) if is_sensitive(k) => format!("{k}=***"),
            _ => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// Keep scheme/host/path (needed to diagnose 403/404) but drop credentials
/// embedded in the authority and any signed query parameters.
pub fn safe_url(url: &str) -> String {
    let url = url.trim().trim_end_matches(|c| matches!(c, ')' | ',' | ';'));
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (url, None),
    };
    let mut out = String::new();
    if let Some((scheme, rest)) = base.split_once("://") {
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        out.push_str(scheme);
        out.push_str("://");
        if let Some((_, host)) = authority.rsplit_once('@') {
            out.push_str("***@");
            out.push_str(host);
        } else {
            out.push_str(authority);
        }
        out.push_str(path);
    } else {
        out.push_str(base);
    }
    if let Some(q) = query {
        out.push('?');
        out.push_str(&mask_query(q));
    }
    out
}

/// Collapse whitespace (keeps one event = one line) and mask anything that
/// looks like a credential, including URLs carrying presigned query strings.
pub fn scrub(s: &str) -> String {
    s.split_whitespace()
        .map(|tok| {
            if let Some(i) = tok.find("http://").or_else(|| tok.find("https://")) {
                let (head, tail) = tok.split_at(i);
                format!("{head}{}", safe_url(tail))
            } else if tok.contains("sk-") || tok.contains("eyJ") {
                "<redacted>".to_string()
            } else if let Some((k, _)) = tok.split_once('=') {
                if is_sensitive(k) {
                    format!("{k}=***")
                } else {
                    tok.to_string()
                }
            } else {
                tok.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A short, single-line preview of an error response body. This is what turns
/// a useless "download failed" into "403 XML AccessDenied" in the report.
pub fn snippet(bytes: &[u8], max_chars: usize) -> String {
    let head = &bytes[..bytes.len().min(max_chars * 4)];
    let s = String::from_utf8_lossy(head);
    s.chars()
        .take(max_chars)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------- time (no chrono dependency) ----------

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn utc_now() -> String {
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

/// Howard Hinnant's days-from-civil inverse: days since 1970-01-01 -> y/m/d.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + (if mp < 10 { 3 } else { -9 });
    (y + (if m <= 2 { 1 } else { 0 }), m, d)
}

fn file_stamp() -> String {
    utc_now()
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(14)
        .collect()
}

// ---------- export ----------

fn read_all() -> Vec<u8> {
    let Some(st) = state() else {
        return Vec::new();
    };
    let mut buf = Vec::new();
    for p in [&st.prev, &st.cur] {
        if let Ok(mut f) = fs::File::open(p) {
            let _ = f.read_to_end(&mut buf);
        }
    }
    buf
}

/// Trim to the newest `max` bytes, starting at a line boundary.
fn tail_string(bytes: Vec<u8>, max: usize) -> String {
    if bytes.len() <= max {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    let start = bytes.len() - max;
    let mut i = start;
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    let slice: &[u8] = if i < bytes.len() {
        &bytes[i + 1..]
    } else {
        &bytes[start..]
    };
    format!(
        "…（更早的记录已省略，完整记录请点「导出日志文件」）\n{}",
        String::from_utf8_lossy(slice)
    )
}

fn header(ctx: &DiagContext) -> String {
    let s = |v: &str| -> String { scrub(v).chars().take(200).collect() };
    format!(
        "====== 灵感10s · 诊断日志 ======\n\
导出时间(本地): {}\n\
导出时间(UTC)  : {}\n\
应用版本      : {} ({}/{})\n\
系统信息      : {}\n\
接口地址      : {}\n\
登录方式      : {}（仅记方式，不记凭证）\n\
模型          : {}\n\
超时 / 并发   : {}s / {}\n\
自定义图床    : {}\n\
备注          : {}\n\
隐私说明      : 不含 API Key / Token / 密码 / 提示词原文 / 图片内容；URL 查询参数中的签名已打码。\n\
日志策略      : 本机循环写入 app.log + app.1.log，合计不超过 512 KB；下方按时间由旧到新排列。\n\
================================\n\n",
        s(&ctx.local_time),
        utc_now(),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        s(&ctx.os),
        s(&ctx.base_url),
        s(&ctx.auth_mode),
        s(&ctx.model),
        ctx.timeout_sec,
        ctx.max_concurrent,
        if ctx.upload_url_custom { "是" } else { "否" },
        s(&ctx.note),
    )
}

/// Paste-friendly report: header + newest 64 KiB. Goes to the clipboard.
pub fn read_diagnostics(ctx: DiagContext) -> String {
    format!("{}{}", header(&ctx), tail_string(read_all(), COPY_TAIL_BYTES))
}

/// Full report (<= 512 KiB + header), written next to the ring files.
/// Returns the absolute path so the UI can show it and copy it for the user.
pub fn export_diagnostics(ctx: DiagContext) -> Result<String, String> {
    let dir = state()
        .map(|st| st.dir.clone())
        .ok_or_else(|| "日志系统未初始化".to_string())?;
    let path = dir.join(format!("diagnostics-{}.txt", file_stamp()));
    let text = format!("{}{}", header(&ctx), String::from_utf8_lossy(&read_all()));
    fs::write(&path, text.as_bytes()).map_err(|e| format!("写入日志失败: {e}"))?;
    log(
        "INFO",
        "app",
        "-",
        "export",
        &format!("file={} bytes={}", path.display(), text.len()),
    );
    Ok(path.to_string_lossy().to_string())
}
