use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rusqlite::{backup::Progress, params, Connection, DatabaseName, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    net::{IpAddr, ToSocketAddrs},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{menu::MenuBuilder, tray::TrayIconBuilder, Manager, State, WindowEvent};
use url::{Host, Url};

const DATABASE_SCHEMA_VERSION: i64 = 7;

fn external_tool_start_error(tool: &str, error: &std::io::Error) -> String {
    if error.raw_os_error() == Some(4551) {
        return format!(
            "{tool}被 Windows 智能应用控制阻止。请在 Windows 安全中心的“应用和浏览器控制”中检查智能应用控制；关闭该功能后需要重启电脑。"
        );
    }
    format!("无法启动{tool}：{error}")
}

struct AppState {
    db: Mutex<Connection>,
    db_path: PathBuf,
    bridge_inbox: PathBuf,
    components_dir: PathBuf,
    extension_dir: PathBuf,
    downloads_dir: Mutex<PathBuf>,
    downloads_config_path: PathBuf,
    component_installing: AtomicBool,
    component_cancel_requested: AtomicBool,
    component_install_phase: AtomicU8,
    component_install_progress: AtomicU8,
    active_downloads: Arc<Mutex<HashMap<i64, Arc<AtomicU8>>>>,
    queued_downloads: Arc<Mutex<HashMap<i64, Arc<AtomicU8>>>>,
    active_processing: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
    queued_processing: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
    source_browser: Mutex<Option<String>>,
    source_login: Mutex<Option<SourceLoginSession>>,
    allow_exit: AtomicBool,
}

struct SourceLoginSession {
    browser: String,
    profile_dir: PathBuf,
    child: Child,
}

fn current_downloads_dir(state: &AppState) -> Result<PathBuf, String> {
    state
        .downloads_dir
        .lock()
        .map(|path| path.clone())
        .map_err(|_| "下载目录状态不可用。".to_string())
}

fn safe_asset_folder_segment(value: &str, fallback: &str) -> String {
    let mut segment = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(96)
        .collect::<String>();
    segment = segment.trim().trim_end_matches(['.', ' ']).to_string();
    if segment.is_empty() {
        segment = fallback.to_string();
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        segment.insert(0, '_');
    }
    segment
}

fn asset_package_directory(
    downloads_dir: &PathBuf,
    title: &str,
    source_id: Option<&str>,
    item_id: i64,
) -> PathBuf {
    let title = safe_asset_folder_segment(title, "未命名素材");
    let identity = safe_asset_folder_segment(
        source_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(""),
        &format!("item-{item_id}"),
    );
    downloads_dir.join(format!("{title} [{identity}]"))
}

fn asset_root_for_media(media_path: &PathBuf) -> PathBuf {
    let parent = media_path.parent().unwrap_or(media_path.as_path());
    let parent_name = parent
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if matches!(parent_name, "video" | "audio") {
        parent.parent().unwrap_or(parent).to_path_buf()
    } else {
        parent.to_path_buf()
    }
}

fn asset_type_directory(media_path: &PathBuf, asset_type: &str) -> PathBuf {
    asset_root_for_media(media_path).join(asset_type)
}

fn asset_sidecar_counts(media_path: &PathBuf) -> (usize, usize) {
    (
        usize::from(cover_sidecar_path(media_path).is_some()),
        discover_sidecar_subtitles(media_path)
            .map(|tracks| tracks.len())
            .unwrap_or(0),
    )
}

fn allow_managed_roots(
    app: &tauri::AppHandle,
    connection: &Connection,
    current: &PathBuf,
) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(current, true)
        .map_err(|error| format!("允许应用读取下载目录失败：{error}"))?;
    let mut statement = connection
        .prepare("SELECT path FROM managed_roots")
        .map_err(|error| format!("读取素材目录授权失败：{error}"))?;
    let roots = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("读取素材目录授权失败：{error}"))?;
    for root in roots.flatten() {
        let path = PathBuf::from(root);
        if path.is_absolute() && path.is_dir() {
            app.asset_protocol_scope()
                .allow_directory(path, true)
                .map_err(|error| format!("恢复素材目录读取权限失败：{error}"))?;
        }
    }
    Ok(())
}

struct InstallFlagGuard<'a> {
    installing: &'a AtomicBool,
    phase: &'a AtomicU8,
    progress: &'a AtomicU8,
}

fn terminate_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let status = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !status.map(|value| value.success()).unwrap_or(false) {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

impl Drop for InstallFlagGuard<'_> {
    fn drop(&mut self) {
        self.phase.store(0, Ordering::Release);
        self.progress.store(0, Ordering::Release);
        self.installing.store(false, Ordering::Release);
    }
}

#[cfg(test)]
fn ensure_queue_capacity(active: usize, limit: usize, label: &str) -> Result<(), String> {
    if active >= limit {
        Err(format!(
            "{label}并发已满（最多 {limit} 个），请等待当前任务完成。"
        ))
    } else {
        Ok(())
    }
}

fn try_claim_queued_task<T>(
    active: &mut HashMap<i64, Arc<T>>,
    queued: &mut HashMap<i64, Arc<T>>,
    task_id: i64,
    limit: usize,
) -> bool {
    if active.len() >= limit || queued.keys().min().copied() != Some(task_id) {
        return false;
    }
    let Some(cancelled) = queued.remove(&task_id) else {
        return false;
    };
    active.insert(task_id, cancelled);
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceAuthStatus {
    configured: bool,
    browser: Option<String>,
    login_open: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleTrack {
    path: String,
    label: String,
    language: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentStatus {
    yt_dlp_ready: bool,
    ffmpeg_ready: bool,
    deno_ready: bool,
    component_directory: PathBuf,
    downloads_directory: PathBuf,
    download_pipeline: String,
    yt_dlp_version: Option<String>,
    ffmpeg_version: Option<String>,
    deno_version: Option<String>,
    storage_free_bytes: Option<u64>,
    installing: bool,
    install_phase: String,
    install_progress_percent: Option<u8>,
    yt_dlp_bytes: u64,
    ffmpeg_bytes: u64,
    deno_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentInstallStatus {
    installing: bool,
    install_phase: String,
    install_progress_percent: Option<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentInstallResult {
    component: String,
    version: String,
    sha256: String,
    bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct EditorInfo {
    id: String,
    name: String,
    verified: bool,
    #[serde(skip_serializing)]
    executable: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorImportResult {
    editor_name: String,
    imported_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatus {
    queue_path: PathBuf,
    host_name: String,
    protocol_version: u8,
    host_installed: bool,
    registered: bool,
    extension_id: Option<String>,
    extension_verified: bool,
    extension_active: bool,
    extension_version: Option<String>,
    extension_package_version: Option<String>,
    last_seen_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionHeartbeat {
    extension_id: String,
    version: String,
    received_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaRemovalImpact {
    file_path: String,
    file_name: String,
    size_bytes: Option<u64>,
    reference_count: i64,
    managed_file: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceRecord {
    schema_version: u8,
    page_url: String,
    title: String,
    source_host: String,
    source_id: Option<String>,
    captured_at: i64,
    downloaded_at: i64,
    quality: String,
    output_preset: String,
    save_subtitles: bool,
    subtitle_languages: Vec<String>,
    save_cover: bool,
    retain_source: bool,
    managed_file: bool,
    file_name: String,
}

#[derive(Debug, Deserialize)]
struct ResolverOutput {
    id: Option<String>,
    title: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    vcodec: Option<String>,
    acodec: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    ext: Option<String>,
    filesize: Option<u64>,
    filesize_approx: Option<u64>,
    #[serde(default)]
    formats: Vec<ResolverFormat>,
    #[serde(default)]
    subtitles: HashMap<String, serde_json::Value>,
    #[serde(default)]
    automatic_captions: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SubtitleOption {
    language: String,
    automatic: bool,
}

#[derive(Debug, Deserialize)]
struct ResolverFormat {
    format_id: Option<String>,
    vcodec: Option<String>,
    acodec: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    ext: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadJob {
    id: i64,
    item_id: i64,
    title: String,
    source_host: String,
    status: String,
    file_path: Option<String>,
    error_message: Option<String>,
    error_code: Option<String>,
    warning_message: Option<String>,
    save_subtitles: bool,
    subtitle_languages: Vec<String>,
    save_cover: bool,
    save_source_record: bool,
    retain_source: bool,
    progress_percent: Option<f64>,
    duration_seconds: Option<i64>,
    thumbnail_url: Option<String>,
    quality: String,
    output_preset: String,
    created_at: i64,
    updated_at: i64,
    library_hidden: bool,
    file_missing: bool,
    project_name: String,
    managed_file: bool,
    stage: String,
    downloaded_bytes: Option<i64>,
    total_bytes: Option<i64>,
    speed_bytes_per_second: Option<f64>,
    eta_seconds: Option<i64>,
    image_count: usize,
    subtitle_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalImportPreview {
    count: usize,
    total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaDerivative {
    id: i64,
    parent_job_id: i64,
    title: String,
    kind: String,
    status: String,
    file_path: Option<String>,
    error_message: Option<String>,
    error_code: Option<String>,
    progress_percent: Option<f64>,
    created_at: i64,
    updated_at: i64,
    library_hidden: bool,
    file_missing: bool,
    project_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMediaInput {
    job_id: i64,
    mode: String,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
    crop_position_x: Option<f64>,
    crop_position_y: Option<f64>,
    crop_scale: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboxItem {
    id: i64,
    request_id: String,
    page_url: String,
    title: String,
    original_title: String,
    source_host: String,
    project_name: String,
    status: String,
    capture_method: String,
    created_at: i64,
    resolved_at: Option<i64>,
    duration_seconds: Option<i64>,
    thumbnail_url: Option<String>,
    error_message: Option<String>,
    source_id: Option<String>,
    has_video: Option<bool>,
    has_audio: Option<bool>,
    max_height: Option<i64>,
    available_heights: Vec<i64>,
    compatible_mp4: Option<bool>,
    estimated_bytes: Option<u64>,
    subtitle_options: Vec<SubtitleOption>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureInput {
    request_id: Option<String>,
    page_url: String,
    title: Option<String>,
    project_name: Option<String>,
    capture_method: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureResult {
    item: InboxItem,
    duplicate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    name: String,
    is_system: bool,
    item_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeEnvelope {
    protocol_version: u32,
    request_id: String,
    #[serde(rename = "type")]
    message_type: String,
    payload: BridgeCapturePayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeCapturePayload {
    page_url: String,
    title: Option<String>,
    project_name: Option<String>,
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn ensure_free_space(path: &PathBuf, required_bytes: u64, operation: &str) -> Result<(), String> {
    let available =
        fs2::available_space(path).map_err(|error| format!("无法读取磁盘可用空间：{error}"))?;
    if available < required_bytes {
        return Err(format!(
            "磁盘空间不足，{operation}至少需要 {} MiB 可用空间，当前约 {} MiB。",
            required_bytes / 1_048_576,
            available / 1_048_576
        ));
    }
    Ok(())
}

fn new_request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("desktop-{nanos}")
}

fn normalize_project_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let length = name.chars().count();
    if length == 0 || length > 50 {
        return Err("项目名称必须为 1–50 个字符。".into());
    }
    if name.chars().any(char::is_control) {
        return Err("项目名称不能包含控制字符。".into());
    }
    Ok(name.to_string())
}

fn validate_page_url(raw: &str) -> Result<(String, String), String> {
    let raw = raw.trim();
    if raw.len() > 8192 {
        return Err("页面链接不能超过 8192 个字符。".into());
    }
    let parsed = Url::parse(raw).map_err(|_| "请输入完整的 HTTP(S) 页面链接。")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 HTTP(S) 页面链接。".into());
    }
    let host = parsed.host().ok_or("链接缺少有效域名。")?;
    let blocked = match host {
        Host::Ipv4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Host::Ipv6(ip) => ip.is_loopback() || ip.is_unspecified(),
        Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            domain == "localhost" || domain.ends_with(".localhost") || domain.ends_with(".local")
        }
    };
    if blocked {
        return Err("为保护本机网络，暂不接受本机或私有网络地址。".into());
    }
    let source_host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    Ok((parsed.to_string(), source_host))
}

fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || ip
                    .to_ipv4_mapped()
                    .map(|mapped| is_non_public_ip(IpAddr::V4(mapped)))
                    .unwrap_or(false)
        }
    }
}

fn validate_network_destination(raw: &str) -> Result<(), String> {
    let parsed = Url::parse(raw).map_err(|_| "页面链接无效。".to_string())?;
    let host = parsed.host_str().ok_or("链接缺少有效域名。")?;
    let port = parsed.port_or_known_default().ok_or("链接缺少有效端口。")?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| "无法解析页面域名，请检查网络或链接。".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("页面域名没有可用网络地址。".into());
    }
    if addresses
        .iter()
        .any(|address| is_non_public_ip(address.ip()))
    {
        return Err("为保护本机网络，该域名解析到了本机或私有网络地址。".into());
    }
    Ok(())
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS inbox_items (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               request_id TEXT NOT NULL UNIQUE,
               page_url TEXT NOT NULL,
               title TEXT NOT NULL,
               source_host TEXT NOT NULL,
               project_name TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('captured','resolving','ready','failed')),
               capture_method TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               waiting_component INTEGER NOT NULL DEFAULT 0,
               auth_required INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_inbox_created_at ON inbox_items(created_at DESC);",
        )
        .map_err(|error| format!("初始化数据库失败：{error}"))?;
    let columns = connection
        .prepare("PRAGMA table_info(inbox_items)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("读取数据库结构失败：{error}"))?;
    for (name, definition) in [
        ("duration_seconds", "INTEGER"),
        ("thumbnail_url", "TEXT"),
        ("error_message", "TEXT"),
        ("source_id", "TEXT"),
        ("has_video", "INTEGER"),
        ("has_audio", "INTEGER"),
        ("max_height", "INTEGER"),
        ("available_heights_json", "TEXT"),
        ("quality_format_ids_json", "TEXT"),
        ("compatible_mp4", "INTEGER"),
        ("estimated_bytes", "INTEGER"),
        ("display_title", "TEXT"),
        ("resolved_at", "INTEGER"),
        ("subtitles_json", "TEXT"),
        ("waiting_component", "INTEGER NOT NULL DEFAULT 0"),
        ("auth_required", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection
                .execute(
                    &format!("ALTER TABLE inbox_items ADD COLUMN {name} {definition}"),
                    [],
                )
                .map_err(|error| format!("升级数据库结构失败：{error}"))?;
        }
    }
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
           name TEXT PRIMARY KEY COLLATE NOCASE,
           is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0,1)),
           created_at INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO projects(name,is_system,created_at) VALUES('未分类',1,0);
         INSERT OR IGNORE INTO projects(name,is_system,created_at)
           SELECT DISTINCT project_name,0,created_at FROM inbox_items WHERE trim(project_name) <> '';
         CREATE TABLE IF NOT EXISTS managed_roots (
           path TEXT PRIMARY KEY,
           created_at INTEGER NOT NULL
         );"
    ).map_err(|error| format!("初始化项目表失败：{error}"))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS download_jobs (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           item_id INTEGER NOT NULL UNIQUE REFERENCES inbox_items(id) ON DELETE CASCADE,
           status TEXT NOT NULL CHECK(status IN ('queued','downloading','paused','completed','failed')),
           file_path TEXT,
           error_message TEXT,
           error_code TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_download_jobs_updated_at ON download_jobs(updated_at DESC);
         CREATE TABLE IF NOT EXISTS media_derivatives (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           parent_job_id INTEGER NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
           title TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('convert','clip','audio','crop-vertical','rotate-left','rotate-right','mute','speed-2x','compress','source')),
           status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
           file_path TEXT,
           error_message TEXT,
           error_code TEXT,
           start_seconds REAL,
           end_seconds REAL,
           crop_position_x REAL,
           crop_position_y REAL,
           crop_scale REAL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_media_derivatives_updated_at ON media_derivatives(updated_at DESC);"
    ).map_err(|error| format!("初始化下载任务表失败：{error}"))?;
    let job_columns = connection
        .prepare("PRAGMA table_info(download_jobs)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("读取下载任务结构失败：{error}"))?;
    if !job_columns
        .iter()
        .any(|column| column == "progress_percent")
    {
        connection
            .execute(
                "ALTER TABLE download_jobs ADD COLUMN progress_percent REAL",
                [],
            )
            .map_err(|error| format!("升级下载任务结构失败：{error}"))?;
    }
    if !job_columns.iter().any(|column| column == "quality") {
        connection
            .execute(
                "ALTER TABLE download_jobs ADD COLUMN quality TEXT NOT NULL DEFAULT 'best'",
                [],
            )
            .map_err(|error| format!("升级下载规格结构失败：{error}"))?;
    }
    if !job_columns.iter().any(|column| column == "output_preset") {
        connection
            .execute(
                "ALTER TABLE download_jobs ADD COLUMN output_preset TEXT NOT NULL DEFAULT 'video'",
                [],
            )
            .map_err(|error| format!("升级下载输出预设失败：{error}"))?;
    }
    if !job_columns.iter().any(|column| column == "library_hidden") {
        connection
            .execute(
                "ALTER TABLE download_jobs ADD COLUMN library_hidden INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("升级素材库状态失败：{error}"))?;
    }
    if !job_columns.iter().any(|column| column == "display_title") {
        connection
            .execute(
                "ALTER TABLE download_jobs ADD COLUMN display_title TEXT",
                [],
            )
            .map_err(|error| format!("升级素材标题结构失败：{error}"))?;
    }
    if !job_columns.iter().any(|column| column == "warning_message") {
        connection
            .execute(
                "ALTER TABLE download_jobs ADD COLUMN warning_message TEXT",
                [],
            )
            .map_err(|error| format!("升级下载警告结构失败：{error}"))?;
    }
    if !job_columns.iter().any(|column| column == "error_code") {
        connection
            .execute("ALTER TABLE download_jobs ADD COLUMN error_code TEXT", [])
            .map_err(|error| format!("升级下载错误分类失败：{error}"))?;
    }
    for (name, definition) in [
        ("save_subtitles", "INTEGER NOT NULL DEFAULT 0"),
        ("subtitle_languages_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("save_cover", "INTEGER NOT NULL DEFAULT 0"),
        ("save_source_record", "INTEGER NOT NULL DEFAULT 1"),
        ("retain_source", "INTEGER NOT NULL DEFAULT 1"),
        ("managed_file", "INTEGER NOT NULL DEFAULT 1"),
        ("stage", "TEXT NOT NULL DEFAULT 'queued'"),
        ("downloaded_bytes", "INTEGER"),
        ("total_bytes", "INTEGER"),
        ("speed_bytes_per_second", "REAL"),
        ("eta_seconds", "INTEGER"),
    ] {
        if !job_columns.iter().any(|column| column == name) {
            connection
                .execute(
                    &format!("ALTER TABLE download_jobs ADD COLUMN {name} {definition}"),
                    [],
                )
                .map_err(|error| format!("升级下载参数快照失败：{error}"))?;
        }
    }
    let jobs_schema: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='download_jobs'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取下载任务约束失败：{error}"))?;
    if !jobs_schema.contains("'queued'") || !jobs_schema.contains("'paused'") {
        connection
            .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;")
            .map_err(|error| format!("准备下载队列迁移失败：{error}"))?;
        let migration = connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE download_jobs RENAME TO download_jobs_legacy;
             CREATE TABLE download_jobs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               item_id INTEGER NOT NULL UNIQUE REFERENCES inbox_items(id) ON DELETE CASCADE,
               status TEXT NOT NULL CHECK(status IN ('queued','downloading','paused','completed','failed')),
               file_path TEXT,
               error_message TEXT,
               error_code TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               progress_percent REAL,
               quality TEXT NOT NULL DEFAULT 'best',
               output_preset TEXT NOT NULL DEFAULT 'video',
               library_hidden INTEGER NOT NULL DEFAULT 0,
               display_title TEXT,
               warning_message TEXT,
               save_subtitles INTEGER NOT NULL DEFAULT 0,
               subtitle_languages_json TEXT NOT NULL DEFAULT '[]',
               save_cover INTEGER NOT NULL DEFAULT 0,
               save_source_record INTEGER NOT NULL DEFAULT 1,
               retain_source INTEGER NOT NULL DEFAULT 1
               ,managed_file INTEGER NOT NULL DEFAULT 1,
               stage TEXT NOT NULL DEFAULT 'queued',
               downloaded_bytes INTEGER,
               total_bytes INTEGER,
               speed_bytes_per_second REAL,
               eta_seconds INTEGER
             );
             INSERT INTO download_jobs(id,item_id,status,file_path,error_message,error_code,created_at,updated_at,progress_percent,quality,output_preset,library_hidden,display_title,warning_message,save_subtitles,subtitle_languages_json,save_cover,save_source_record,retain_source,managed_file,stage,downloaded_bytes,total_bytes,speed_bytes_per_second,eta_seconds)
               SELECT id,item_id,status,file_path,error_message,error_code,created_at,updated_at,progress_percent,quality,output_preset,library_hidden,display_title,warning_message,save_subtitles,subtitle_languages_json,save_cover,save_source_record,retain_source,managed_file,stage,downloaded_bytes,total_bytes,speed_bytes_per_second,eta_seconds FROM download_jobs_legacy;
             DROP TABLE download_jobs_legacy;
             CREATE INDEX idx_download_jobs_updated_at ON download_jobs(updated_at DESC);
             COMMIT;"
        );
        let _ = connection.execute_batch("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;");
        migration.map_err(|error| format!("升级下载队列结构失败：{error}"))?;
    }
    let derivative_columns = connection
        .prepare("PRAGMA table_info(media_derivatives)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("读取处理任务结构失败：{error}"))?;
    if !derivative_columns
        .iter()
        .any(|column| column == "progress_percent")
    {
        connection
            .execute(
                "ALTER TABLE media_derivatives ADD COLUMN progress_percent REAL",
                [],
            )
            .map_err(|error| format!("升级处理任务结构失败：{error}"))?;
    }
    if !derivative_columns
        .iter()
        .any(|column| column == "library_hidden")
    {
        connection.execute("ALTER TABLE media_derivatives ADD COLUMN library_hidden INTEGER NOT NULL DEFAULT 0", [])
            .map_err(|error| format!("升级派生素材库状态失败：{error}"))?;
    }
    if !derivative_columns
        .iter()
        .any(|column| column == "display_title")
    {
        connection
            .execute(
                "ALTER TABLE media_derivatives ADD COLUMN display_title TEXT",
                [],
            )
            .map_err(|error| format!("升级派生素材标题结构失败：{error}"))?;
    }
    if !derivative_columns
        .iter()
        .any(|column| column == "error_code")
    {
        connection
            .execute(
                "ALTER TABLE media_derivatives ADD COLUMN error_code TEXT",
                [],
            )
            .map_err(|error| format!("升级处理错误分类失败：{error}"))?;
    }
    if !derivative_columns
        .iter()
        .any(|column| column == "start_seconds")
    {
        connection
            .execute(
                "ALTER TABLE media_derivatives ADD COLUMN start_seconds REAL",
                [],
            )
            .map_err(|error| format!("升级处理配方失败：{error}"))?;
    }
    if !derivative_columns
        .iter()
        .any(|column| column == "end_seconds")
    {
        connection
            .execute(
                "ALTER TABLE media_derivatives ADD COLUMN end_seconds REAL",
                [],
            )
            .map_err(|error| format!("升级处理配方失败：{error}"))?;
    }
    for column in ["crop_position_x", "crop_position_y", "crop_scale"] {
        if !derivative_columns.iter().any(|existing| existing == column) {
            connection
                .execute(
                    &format!("ALTER TABLE media_derivatives ADD COLUMN {column} REAL"),
                    [],
                )
                .map_err(|error| format!("升级裁剪配方失败：{error}"))?;
        }
    }
    let derivatives_schema: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='media_derivatives'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取处理队列约束失败：{error}"))?;
    if !derivatives_schema.contains("'queued'")
        || !derivatives_schema.contains("'source'")
        || !derivatives_schema.contains("'rotate-left'")
    {
        connection
            .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;")
            .map_err(|error| format!("准备处理队列迁移失败：{error}"))?;
        let migration = connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE media_derivatives RENAME TO media_derivatives_legacy;
             CREATE TABLE media_derivatives (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               parent_job_id INTEGER NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
               title TEXT NOT NULL,
               kind TEXT NOT NULL CHECK(kind IN ('convert','clip','audio','crop-vertical','rotate-left','rotate-right','mute','speed-2x','compress','source')),
               status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
               file_path TEXT,
               error_message TEXT,
               error_code TEXT,
               start_seconds REAL,
               end_seconds REAL,
               crop_position_x REAL,
               crop_position_y REAL,
               crop_scale REAL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               progress_percent REAL,
               library_hidden INTEGER NOT NULL DEFAULT 0,
               display_title TEXT
             );
             INSERT INTO media_derivatives(id,parent_job_id,title,kind,status,file_path,error_message,error_code,start_seconds,end_seconds,crop_position_x,crop_position_y,crop_scale,created_at,updated_at,progress_percent,library_hidden,display_title)
               SELECT id,parent_job_id,title,kind,status,file_path,error_message,error_code,start_seconds,end_seconds,crop_position_x,crop_position_y,crop_scale,created_at,updated_at,progress_percent,library_hidden,display_title FROM media_derivatives_legacy;
             DROP TABLE media_derivatives_legacy;
             CREATE INDEX idx_media_derivatives_updated_at ON media_derivatives(updated_at DESC);
              CREATE UNIQUE INDEX idx_media_source_parent ON media_derivatives(parent_job_id) WHERE kind='source';
             COMMIT;"
        );
        let _ = connection.execute_batch("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;");
        migration.map_err(|error| format!("升级处理队列结构失败：{error}"))?;
    }
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_media_source_parent ON media_derivatives(parent_job_id) WHERE kind='source'", [])
        .map_err(|error| format!("初始化源文件索引失败：{error}"))?;
    connection
        .execute_batch(&format!("PRAGMA user_version={DATABASE_SCHEMA_VERSION};"))
        .map_err(|error| format!("记录数据库版本失败：{error}"))?;
    Ok(())
}

fn prepare_database_backup(
    connection: &Connection,
    database_path: &PathBuf,
    existed_before_open: bool,
) -> Result<Option<PathBuf>, String> {
    if !existed_before_open {
        return Ok(None);
    }
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取数据库版本失败：{error}"))?;
    if version >= DATABASE_SCHEMA_VERSION {
        return Ok(None);
    }
    let parent = database_path.parent().ok_or("无法确定数据库备份目录。")?;
    let backup_path = parent.join(format!("clipcargo.pre-migration-v{version}.sqlite3"));
    if backup_path.is_file() {
        return Ok(Some(backup_path));
    }
    if backup_path.exists() {
        return Err("数据库备份目标不是普通文件。".into());
    }
    if let Err(error) = connection.backup(DatabaseName::Main, &backup_path, None) {
        let _ = fs::remove_file(&backup_path);
        return Err(format!("创建迁移前数据库备份失败：{error}"));
    }
    Ok(Some(backup_path))
}

fn restore_database_backup(
    connection: &mut Connection,
    backup_path: &PathBuf,
) -> Result<(), String> {
    connection
        .restore(DatabaseName::Main, backup_path, None::<fn(Progress)>)
        .map_err(|error| format!("恢复迁移前数据库备份失败：{error}"))
}

fn row_to_derivative(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaDerivative> {
    let status: String = row.get(4)?;
    let file_path: Option<String> = row.get(5)?;
    let file_missing = status == "completed"
        && file_path
            .as_ref()
            .map(|path| !PathBuf::from(path).is_file())
            .unwrap_or(true);
    Ok(MediaDerivative {
        id: row.get(0)?,
        parent_job_id: row.get(1)?,
        title: row.get(2)?,
        kind: row.get(3)?,
        status,
        file_path,
        error_message: row.get(6)?,
        progress_percent: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        library_hidden: row.get::<_, i64>(10)? != 0,
        file_missing,
        project_name: row.get(11)?,
        error_code: row.get(12)?,
    })
}

fn row_to_download_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<DownloadJob> {
    let status: String = row.get(4)?;
    let file_path: Option<String> = row.get(5)?;
    let remote_thumbnail: Option<String> = row.get(9)?;
    let thumbnail_url = file_path
        .as_ref()
        .and_then(|path| cover_sidecar_path(&PathBuf::from(path)))
        .and_then(|path| cover_data_url(&path))
        .or(remote_thumbnail);
    let file_missing = status == "completed"
        && file_path
            .as_ref()
            .map(|path| !PathBuf::from(path).is_file())
            .unwrap_or(true);
    let (image_count, subtitle_count) = file_path
        .as_ref()
        .map(|path| asset_sidecar_counts(&PathBuf::from(path)))
        .unwrap_or_default();
    Ok(DownloadJob {
        id: row.get(0)?,
        item_id: row.get(1)?,
        title: row.get(2)?,
        source_host: row.get(3)?,
        status,
        file_path,
        error_message: row.get(6)?,
        progress_percent: row.get(7)?,
        duration_seconds: row.get(8)?,
        thumbnail_url,
        quality: row.get(10)?,
        output_preset: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        library_hidden: row.get::<_, i64>(14)? != 0,
        file_missing,
        project_name: row.get(15)?,
        warning_message: row.get(16)?,
        save_subtitles: row.get::<_, i64>(17)? != 0,
        subtitle_languages: row
            .get::<_, String>(18)
            .ok()
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default(),
        save_cover: row.get::<_, i64>(19)? != 0,
        save_source_record: row.get::<_, i64>(20)? != 0,
        retain_source: row.get::<_, i64>(21)? != 0,
        managed_file: row.get::<_, i64>(22)? != 0,
        error_code: row.get(23)?,
        stage: row.get(24)?,
        downloaded_bytes: row.get(25)?,
        total_bytes: row.get(26)?,
        speed_bytes_per_second: row.get(27)?,
        eta_seconds: row.get(28)?,
        image_count,
        subtitle_count,
    })
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboxItem> {
    let stored_status: String = row.get(7)?;
    let status = if row.get::<_, i64>(22).unwrap_or(0) != 0 {
        "waiting_component".to_string()
    } else {
        stored_status
    };
    Ok(InboxItem {
        id: row.get(0)?,
        request_id: row.get(1)?,
        page_url: row.get(2)?,
        title: row.get(3)?,
        original_title: row.get(4)?,
        source_host: row.get(5)?,
        project_name: row.get(6)?,
        status,
        capture_method: row.get(8)?,
        created_at: row.get(9)?,
        resolved_at: row.get(10)?,
        duration_seconds: row.get(11)?,
        thumbnail_url: row.get(12)?,
        error_message: row.get(13)?,
        source_id: row.get(14)?,
        has_video: row.get::<_, Option<i64>>(15)?.map(|value| value != 0),
        has_audio: row.get::<_, Option<i64>>(16)?.map(|value| value != 0),
        max_height: row.get(17)?,
        available_heights: row
            .get::<_, Option<String>>(18)?
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default(),
        compatible_mp4: row.get::<_, Option<i64>>(19)?.map(|value| value != 0),
        estimated_bytes: row.get(20)?,
        subtitle_options: row
            .get::<_, Option<String>>(21)?
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default(),
    })
}

fn select_by_request_id(connection: &Connection, request_id: &str) -> Result<InboxItem, String> {
    connection
        .query_row(
            "SELECT id, request_id, page_url, COALESCE(display_title,title), title, source_host, project_name, status, capture_method, created_at, resolved_at
             , duration_seconds, thumbnail_url, error_message, source_id, has_video, has_audio, max_height, available_heights_json, compatible_mp4, estimated_bytes, subtitles_json, waiting_component FROM inbox_items WHERE request_id = ?1",
            params![request_id],
            row_to_item,
        )
        .map_err(|error| format!("读取收集箱条目失败：{error}"))
}

fn insert_capture(connection: &Connection, input: CaptureInput) -> Result<CaptureResult, String> {
    let (page_url, source_host) = validate_page_url(&input.page_url)?;
    let request_id = input.request_id.unwrap_or_else(new_request_id);
    if request_id.len() > 128 || request_id.trim().is_empty() {
        return Err("请求标识无效。".into());
    }
    if let Ok(item) = select_by_request_id(connection, &request_id) {
        return Ok(CaptureResult {
            item,
            duplicate: true,
        });
    }

    let title = input
        .title
        .unwrap_or_default()
        .trim()
        .chars()
        .take(512)
        .collect::<String>();
    let title = if title.is_empty() {
        source_host.clone()
    } else {
        title
    };
    let project_name = input
        .project_name
        .unwrap_or_else(|| "未分类".into())
        .trim()
        .chars()
        .take(50)
        .collect::<String>();
    let project_name = if project_name.is_empty() {
        "未分类".into()
    } else {
        project_name
    };
    connection
        .execute(
            "INSERT OR IGNORE INTO projects(name,is_system,created_at) VALUES(?1,0,?2)",
            params![project_name, unix_seconds()],
        )
        .map_err(|error| format!("保存项目失败：{error}"))?;
    let existing_request_id = connection.query_row(
        "SELECT request_id FROM inbox_items WHERE page_url = ?1 AND project_name = ?2 ORDER BY id DESC LIMIT 1",
        params![page_url, project_name],
        |row| row.get::<_, String>(0),
    ).optional().map_err(|error| format!("检查重复收集失败：{error}"))?;
    if let Some(existing_request_id) = existing_request_id {
        let created_at = unix_seconds();
        connection
            .execute(
                "UPDATE inbox_items SET created_at = ?1 WHERE request_id = ?2",
                params![created_at, existing_request_id],
            )
            .map_err(|error| format!("更新重复条目失败：{error}"))?;
        return Ok(CaptureResult {
            item: select_by_request_id(connection, &existing_request_id)?,
            duplicate: true,
        });
    }
    let capture_method = input.capture_method.unwrap_or_else(|| "paste".into());
    let capture_method = match capture_method.as_str() {
        "extension" | "context-menu" => capture_method,
        _ => "paste".into(),
    };
    let created_at = unix_seconds();

    connection
        .execute(
            "INSERT INTO inbox_items
             (request_id, page_url, title, source_host, project_name, status, capture_method, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'captured', ?6, ?7)",
            params![request_id, page_url, title, source_host, project_name, capture_method, created_at],
        )
        .map_err(|error| format!("保存收集箱条目失败：{error}"))?;
    let item = select_by_request_id(connection, &request_id)?;
    Ok(CaptureResult {
        item,
        duplicate: false,
    })
}

fn import_bridge_files(state: &AppState) -> Result<usize, String> {
    fs::create_dir_all(&state.bridge_inbox)
        .map_err(|error| format!("创建浏览器收集目录失败：{error}"))?;
    let mut imported = 0;
    let entries = fs::read_dir(&state.bridge_inbox)
        .map_err(|error| format!("读取浏览器收集目录失败：{error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let result = fs::read_to_string(&path)
            .map_err(|error| format!("读取浏览器消息失败：{error}"))
            .and_then(|raw| {
                serde_json::from_str::<BridgeEnvelope>(&raw)
                    .map_err(|error| format!("浏览器消息格式无效：{error}"))
            })
            .and_then(|message| {
                if message.protocol_version != 1 || message.message_type != "capture_page" {
                    return Err("浏览器消息版本或类型不受支持。".into());
                }
                let connection = state
                    .db
                    .lock()
                    .map_err(|_| "数据库锁不可用。".to_string())?;
                insert_capture(
                    &connection,
                    CaptureInput {
                        request_id: Some(message.request_id),
                        page_url: message.payload.page_url,
                        title: message.payload.title,
                        project_name: message.payload.project_name,
                        capture_method: Some("extension".into()),
                    },
                )
            });
        match result {
            Ok(_) => {
                imported += 1;
                let _ = fs::remove_file(&path);
            }
            Err(error) => {
                let failed = path.with_extension("failed");
                let _ = fs::rename(&path, &failed);
                eprintln!("{error}");
            }
        }
    }
    Ok(imported)
}

#[tauri::command]
fn list_inbox(state: State<'_, AppState>) -> Result<Vec<InboxItem>, String> {
    let _ = import_bridge_files(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, request_id, page_url, COALESCE(display_title,title), title, source_host, project_name, status, capture_method, created_at, resolved_at
             , duration_seconds, thumbnail_url, error_message, source_id, has_video, has_audio, max_height, available_heights_json, compatible_mp4, estimated_bytes, subtitles_json, waiting_component FROM inbox_items ORDER BY created_at DESC, id DESC",
        )
        .map_err(|error| format!("读取收集箱失败：{error}"))?;
    let rows = statement
        .query_map([], row_to_item)
        .map_err(|error| format!("读取收集箱失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取收集箱失败：{error}"))
}

fn list_project_records(connection: &Connection) -> Result<Vec<ProjectSummary>, String> {
    let mut statement = connection
        .prepare(
            "SELECT p.name,p.is_system,COUNT(i.id)
         FROM projects p LEFT JOIN inbox_items i ON i.project_name=p.name COLLATE NOCASE
         GROUP BY p.name,p.is_system
         ORDER BY p.is_system DESC,p.created_at ASC,p.name COLLATE NOCASE",
        )
        .map_err(|error| format!("读取项目失败：{error}"))?;
    let projects = statement
        .query_map([], |row| {
            Ok(ProjectSummary {
                name: row.get(0)?,
                is_system: row.get::<_, i64>(1)? != 0,
                item_count: row.get(2)?,
            })
        })
        .map_err(|error| format!("读取项目失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取项目失败：{error}"))?;
    Ok(projects)
}

#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectSummary>, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    list_project_records(&connection)
}

fn create_project_record(connection: &Connection, name: &str) -> Result<(), String> {
    let name = normalize_project_name(&name)?;
    connection
        .execute(
            "INSERT INTO projects(name,is_system,created_at) VALUES(?1,0,?2)",
            params![name, unix_seconds()],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "同名项目已存在。".into()
            } else {
                format!("创建项目失败：{error}")
            }
        })?;
    Ok(())
}

#[tauri::command]
fn create_project(name: String, state: State<'_, AppState>) -> Result<Vec<ProjectSummary>, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    create_project_record(&connection, &name)?;
    list_project_records(&connection)
}

fn rename_project_record(
    connection: &mut Connection,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    let old_name = normalize_project_name(&old_name)?;
    let new_name = normalize_project_name(&new_name)?;
    if old_name == "未分类" {
        return Err("系统项目“未分类”不能重命名。".into());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始项目更新失败：{error}"))?;
    let changed = transaction
        .execute(
            "UPDATE projects SET name=?1 WHERE name=?2 AND is_system=0",
            params![new_name, old_name],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "同名项目已存在。".into()
            } else {
                format!("重命名项目失败：{error}")
            }
        })?;
    if changed == 0 {
        return Err("找不到可重命名的项目。".into());
    }
    transaction
        .execute(
            "UPDATE inbox_items SET project_name=?1 WHERE project_name=?2 COLLATE NOCASE",
            params![new_name, old_name],
        )
        .map_err(|error| format!("更新项目内容失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("保存项目更名失败：{error}"))?;
    Ok(())
}

#[tauri::command]
fn rename_project(
    old_name: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<Vec<ProjectSummary>, String> {
    let mut connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    rename_project_record(&mut connection, &old_name, &new_name)?;
    list_project_records(&connection)
}

fn delete_project_record(connection: &mut Connection, name: &str) -> Result<(), String> {
    let name = normalize_project_name(&name)?;
    if name == "未分类" {
        return Err("系统项目“未分类”不能删除。".into());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始删除项目失败：{error}"))?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE name=?1 AND is_system=0)",
            params![name],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查项目失败：{error}"))?;
    if !exists {
        return Err("找不到可删除的项目。".into());
    }
    transaction
        .execute(
            "UPDATE inbox_items SET project_name='未分类' WHERE project_name=?1 COLLATE NOCASE",
            params![name],
        )
        .map_err(|error| format!("迁移项目内容失败：{error}"))?;
    transaction
        .execute(
            "DELETE FROM projects WHERE name=?1 AND is_system=0",
            params![name],
        )
        .map_err(|error| format!("删除项目失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("保存项目删除失败：{error}"))?;
    Ok(())
}

#[tauri::command]
fn delete_project(name: String, state: State<'_, AppState>) -> Result<Vec<ProjectSummary>, String> {
    let mut connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    delete_project_record(&mut connection, &name)?;
    list_project_records(&connection)
}

#[tauri::command]
fn capture_page(input: CaptureInput, state: State<'_, AppState>) -> Result<CaptureResult, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    insert_capture(&connection, input)
}

#[tauri::command]
fn remove_inbox_item(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    remove_inbox_record(&connection, id)
}

fn remove_inbox_record(connection: &Connection, id: i64) -> Result<(), String> {
    let linked_jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM download_jobs WHERE item_id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查素材关联失败：{error}"))?;
    if linked_jobs > 0 {
        return Err("该条目已有下载任务或本地素材，请在素材管理功能中处理，避免遗留文件。".into());
    }
    let changed = connection
        .execute("DELETE FROM inbox_items WHERE id = ?1", params![id])
        .map_err(|error| format!("移除条目失败：{error}"))?;
    if changed == 0 {
        return Err("找不到该收集箱条目。".into());
    }
    Ok(())
}

fn move_inbox_records(
    connection: &mut Connection,
    ids: &[i64],
    project_name: &str,
) -> Result<usize, String> {
    if ids.is_empty() {
        return Err("请至少选择一个条目。".into());
    }
    if ids.len() > 100 {
        return Err("一次最多移动 100 个条目。".into());
    }
    let project_name = normalize_project_name(&project_name)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始移动条目失败：{error}"))?;
    let project_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE name=?1 COLLATE NOCASE)",
            params![&project_name],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查目标项目失败：{error}"))?;
    if !project_exists {
        return Err("目标项目不存在。".into());
    }
    let mut moved = 0;
    for id in ids {
        let changed = transaction
            .execute(
                "UPDATE inbox_items SET project_name=?1 WHERE id=?2",
                params![&project_name, id],
            )
            .map_err(|error| format!("移动条目失败：{error}"))?;
        if changed == 0 {
            return Err(format!("找不到收集箱条目 {id}。"));
        }
        moved += changed;
    }
    transaction
        .commit()
        .map_err(|error| format!("保存条目移动失败：{error}"))?;
    Ok(moved)
}

#[tauri::command]
fn move_inbox_items(
    ids: Vec<i64>,
    project_name: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mut connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    move_inbox_records(&mut connection, &ids, &project_name)
}

#[tauri::command]
fn update_inbox_details(
    id: i64,
    display_title: String,
    project_name: String,
    state: State<'_, AppState>,
) -> Result<InboxItem, String> {
    let display_title = display_title.trim();
    if display_title.is_empty()
        || display_title.chars().count() > 512
        || display_title
            .chars()
            .any(|value| matches!(value, '\r' | '\n' | '\0'))
    {
        return Err("显示标题应为 1 到 512 个有效字符。".into());
    }
    let project_name = normalize_project_name(&project_name)?;
    let mut connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始保存条目详情失败：{error}"))?;
    let project_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE name=?1 COLLATE NOCASE)",
            params![&project_name],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查目标项目失败：{error}"))?;
    if !project_exists {
        return Err("目标项目不存在。".into());
    }
    let original_title: String = transaction
        .query_row(
            "SELECT title FROM inbox_items WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|_| "找不到该收集箱条目。".to_string())?;
    let display_value = if display_title == original_title {
        None
    } else {
        Some(display_title)
    };
    transaction
        .execute(
            "UPDATE inbox_items SET display_title=?1,project_name=?2 WHERE id=?3",
            params![display_value, &project_name, id],
        )
        .map_err(|error| format!("保存条目详情失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交条目详情失败：{error}"))?;
    connection.query_row(
        "SELECT id, request_id, page_url, COALESCE(display_title,title), title, source_host, project_name, status, capture_method, created_at, resolved_at, duration_seconds, thumbnail_url, error_message, source_id, has_video, has_audio, max_height, available_heights_json, compatible_mp4, estimated_bytes, subtitles_json, waiting_component FROM inbox_items WHERE id=?1",
        params![id], row_to_item,
    ).map_err(|error| format!("读取条目详情失败：{error}"))
}

#[tauri::command]
fn open_source_page(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let page_url: String = connection
        .query_row(
            "SELECT page_url FROM inbox_items WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|_| "找不到该来源页面。".to_string())?;
    let (validated, _) = validate_page_url(&page_url)?;
    Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(validated)
        .spawn()
        .map_err(|error| format!("无法打开来源页面：{error}"))?;
    Ok(())
}

fn resolver_error(stderr: &[u8]) -> String {
    let raw = String::from_utf8_lossy(stderr);
    let lower = raw.to_ascii_lowercase();
    if lower.contains("no space left")
        || lower.contains("disk full")
        || lower.contains("not enough space")
    {
        return "磁盘空间不足，任务已停止。请释放下载目录所在磁盘的空间后重试。".into();
    }
    if lower.contains("http error 429")
        || lower.contains("too many requests")
        || lower.contains("rate limit")
    {
        return "来源暂时限制请求；有限重试仍未成功。请稍后再试；若页面需要登录，可在设置中打开独立登录窗口。".into();
    }
    if lower.contains("timed out")
        || lower.contains("connection reset")
        || lower.contains("network is unreachable")
    {
        return "网络连接中断或超时；有限重试仍未成功。网络恢复后可继续下载。".into();
    }
    if lower.contains("no video formats found") {
        return "该页面没有找到可下载的视频。若来自小红书，请从分享按钮复制包含访问参数的完整链接；若页面需要登录，可在设置中打开独立登录窗口后重试。".into();
    }
    if lower.contains("could not copy") && lower.contains("cookie") {
        return "登录窗口的数据仍被占用。请回到设置重新完成独立登录，再按原参数重试。".into();
    }
    if lower.contains("login required")
        || lower.contains("sign in")
        || lower.contains("logged-in")
        || lower.contains("logged in")
        || lower.contains("account credentials")
        || lower.contains("username and password")
        || lower.contains("cookies")
    {
        return "来源要求登录或验证。请在设置中打开独立登录窗口，完成该网站登录后重试；也可以改用公开内容。".into();
    }
    if lower.contains("video is unavailable") || lower.contains("content is not available") {
        return "该内容已删除、设为私密或当前地区不可访问。".into();
    }
    if lower.contains("requested format is not available") {
        return "来源没有符合当前清晰度的格式，请改选其他清晰度后重试。".into();
    }
    let message = raw
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("解析器没有返回错误详情。")
        .trim();
    message.chars().take(1000).collect()
}

fn task_error_code(message: &str, processing: bool) -> &'static str {
    let lower = message.to_lowercase();
    let contains_any = |values: &[&str]| values.iter().any(|value| lower.contains(value));
    if contains_any(&["磁盘空间不足", "disk full", "no space left"]) {
        "DISK_FULL"
    } else if contains_any(&[
        "限制请求",
        "限流",
        "rate limit",
        "too many requests",
        "http error 429",
    ]) {
        "RATE_LIMITED"
    } else if contains_any(&["登录", "授权", "cookie", "sign in"]) {
        "AUTH_REQUIRED"
    } else if contains_any(&[
        "已删除",
        "不可访问",
        "设为私密",
        "not available",
        "unavailable",
    ]) {
        "SOURCE_GONE"
    } else if contains_any(&[
        "当前不支持",
        "没有找到可下载",
        "no video formats",
        "unsupported",
    ]) {
        "UNSUPPORTED_SOURCE"
    } else if contains_any(&["网络", "连接中断", "超时", "timed out", "connection reset"]) {
        "NETWORK_UNREACHABLE"
    } else if contains_any(&[
        "权限",
        "拒绝访问",
        "permission denied",
        "access is denied",
        "被占用",
    ]) {
        "PERMISSION_DENIED"
    } else if contains_any(&["缺少", "尚未安装", "找不到 ffmpeg", "找不到 yt-dlp"]) {
        "COMPONENT_MISSING"
    } else if contains_any(&["校验未通过", "没有可识别", "零字节", "时长偏差"]) {
        "OUTPUT_INVALID"
    } else if contains_any(&["已停止", "已取消", "取消。"]) {
        "CANCELLED_BY_USER"
    } else if processing {
        "PROCESS_FAILED"
    } else {
        "PROCESS_FAILED"
    }
}

#[tauri::command]
fn source_auth_status(state: State<'_, AppState>) -> Result<SourceAuthStatus, String> {
    let browser_spec = state
        .source_browser
        .lock()
        .map_err(|_| "浏览器登录状态不可用。".to_string())?
        .clone();
    let browser = browser_spec
        .as_deref()
        .and_then(|value| value.split(':').next())
        .map(str::to_string);
    let login_open = state
        .source_login
        .lock()
        .map_err(|_| "登录窗口状态不可用。".to_string())?
        .is_some();
    Ok(SourceAuthStatus {
        configured: browser_spec.is_some(),
        browser,
        login_open,
    })
}

fn login_browser_executable(browser: &str) -> Option<PathBuf> {
    let app_name = if browser == "edge" {
        "msedge.exe"
    } else {
        "chrome.exe"
    };
    let registry_keys = if browser == "edge" {
        [
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
        ]
    } else {
        [
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
        ]
    };
    for key in registry_keys {
        if let Some(path) =
            registry_value(key, None).and_then(|value| executable_from_registry_value(&value))
        {
            if path.is_file() {
                return path.canonicalize().ok();
            }
        }
    }
    let mut roots = Vec::new();
    if let Some(value) = std::env::var_os("PROGRAMFILES") {
        roots.push(PathBuf::from(value));
    }
    if let Some(value) = std::env::var_os("PROGRAMFILES(X86)") {
        roots.push(PathBuf::from(value));
    }
    if let Some(value) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(value));
    }
    let relative = if browser == "edge" {
        PathBuf::from(r"Microsoft\Edge\Application").join(app_name)
    } else {
        PathBuf::from(r"Google\Chrome\Application").join(app_name)
    };
    roots
        .into_iter()
        .map(|root| root.join(&relative))
        .find(|path| path.is_file())
}

fn browser_cookie_database(profile_dir: &std::path::Path) -> Option<PathBuf> {
    [
        profile_dir.join(r"Default\Network\Cookies"),
        profile_dir.join(r"Default\Cookies"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn browser_profile_ready(profile_dir: &std::path::Path) -> bool {
    let Some(cookie_database) = browser_cookie_database(profile_dir) else {
        return false;
    };
    let probe = profile_dir.join(".clipcargo-cookie-read-probe");
    let copied = fs::copy(cookie_database, &probe).is_ok();
    let _ = fs::remove_file(probe);
    copied
}

fn source_login_root(components_dir: &std::path::Path) -> Result<PathBuf, String> {
    components_dir
        .parent()
        .map(|path| path.join("login-profiles"))
        .ok_or_else(|| "无法确定登录数据目录。".to_string())
}

fn source_auth_config_path(components_dir: &std::path::Path) -> Result<PathBuf, String> {
    components_dir
        .parent()
        .map(|path| path.join("source-login.txt"))
        .ok_or_else(|| "无法确定登录设置位置。".to_string())
}

fn source_browser_spec(components_dir: &std::path::Path, browser: &str) -> Result<String, String> {
    if !matches!(browser, "chrome" | "edge") {
        return Err("登录浏览器设置无效。".into());
    }
    let profile_dir = source_login_root(components_dir)?.join(browser);
    if !browser_profile_ready(&profile_dir) {
        return Err("登录数据不存在或仍被占用，请重新完成登录。".into());
    }
    Ok(format!("{browser}:{}", profile_dir.to_string_lossy()))
}

fn read_configured_source_browser(components_dir: &std::path::Path) -> Option<String> {
    let config = source_auth_config_path(components_dir).ok()?;
    let browser = fs::read_to_string(config).ok()?.trim().to_ascii_lowercase();
    source_browser_spec(components_dir, &browser).ok()
}

fn save_configured_source_browser(
    components_dir: &std::path::Path,
    browser: &str,
) -> Result<(), String> {
    let config = source_auth_config_path(components_dir)?;
    let temporary = config.with_extension("txt.tmp");
    fs::write(&temporary, browser.as_bytes())
        .map_err(|error| format!("保存登录设置失败：{error}"))?;
    fs::rename(&temporary, &config).map_err(|error| format!("启用登录设置失败：{error}"))
}

fn clear_configured_source_browser(components_dir: &std::path::Path) -> Result<(), String> {
    let config = source_auth_config_path(components_dir)?;
    if config.exists() {
        fs::remove_file(&config).map_err(|error| format!("清除登录设置失败：{error}"))?;
    }
    let root = source_login_root(components_dir)?;
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("清除独立浏览器登录数据失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn open_source_login(
    browser: String,
    job_id: Option<i64>,
    state: State<'_, AppState>,
) -> Result<SourceAuthStatus, String> {
    let browser = browser.trim().to_ascii_lowercase();
    if !matches!(browser.as_str(), "chrome" | "edge") {
        return Err("请选择 Chrome 或 Edge。".into());
    }
    let executable = login_browser_executable(&browser).ok_or_else(|| {
        format!(
            "没有找到{}，请先安装浏览器。",
            if browser == "edge" { "Edge" } else { "Chrome" }
        )
    })?;
    let login_url = if let Some(job_id) = job_id {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        let page_url: String = connection
            .query_row(
                "SELECT i.page_url FROM download_jobs j JOIN inbox_items i ON i.id=j.item_id WHERE j.id=?1",
                params![job_id],
                |row| row.get(0),
            )
            .map_err(|_| "找不到需要登录重试的下载任务。".to_string())?;
        validate_page_url(&page_url)?.0
    } else {
        "https://www.youtube.com/".to_string()
    };
    let profile_dir = source_login_root(&state.components_dir)?.join(&browser);
    fs::create_dir_all(&profile_dir).map_err(|error| format!("创建登录数据目录失败：{error}"))?;
    let mut sessions = state
        .source_login
        .lock()
        .map_err(|_| "登录窗口状态不可用。".to_string())?;
    if let Some(mut previous) = sessions.take() {
        terminate_child_tree(&mut previous.child);
        let _ = previous.child.wait();
    }
    let child = Command::new(executable)
        .arg(format!("--user-data-dir={}", profile_dir.to_string_lossy()))
        .args(["--no-first-run", "--no-default-browser-check", &login_url])
        .spawn()
        .map_err(|error| external_tool_start_error("登录浏览器", &error))?;
    *state
        .source_browser
        .lock()
        .map_err(|_| "浏览器登录状态不可用。".to_string())? = None;
    *sessions = Some(SourceLoginSession {
        browser: browser.clone(),
        profile_dir,
        child,
    });
    Ok(SourceAuthStatus {
        configured: false,
        browser: Some(browser),
        login_open: true,
    })
}

#[tauri::command]
fn finish_source_login(state: State<'_, AppState>) -> Result<SourceAuthStatus, String> {
    let mut session = state
        .source_login
        .lock()
        .map_err(|_| "登录窗口状态不可用。".to_string())?
        .take()
        .ok_or("请先打开登录窗口。")?;
    terminate_child_tree(&mut session.child);
    let _ = session.child.wait();
    for _ in 0..20 {
        if browser_profile_ready(&session.profile_dir) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if !browser_profile_ready(&session.profile_dir) {
        return Err("没有检测到登录数据。请在登录窗口中进入网站并完成登录后再试。".into());
    }
    let browser_spec = source_browser_spec(&state.components_dir, &session.browser)?;
    save_configured_source_browser(&state.components_dir, &session.browser)?;
    *state
        .source_browser
        .lock()
        .map_err(|_| "浏览器登录状态不可用。".to_string())? = Some(browser_spec);
    Ok(SourceAuthStatus {
        configured: true,
        browser: Some(session.browser),
        login_open: false,
    })
}

#[tauri::command]
fn set_source_browser(
    browser: Option<String>,
    state: State<'_, AppState>,
) -> Result<SourceAuthStatus, String> {
    let browser = browser
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    if browser.is_some() {
        return Err("请使用“打开登录窗口”，登录完成后再确认。".into());
    }
    if let Some(mut session) = state
        .source_login
        .lock()
        .map_err(|_| "登录窗口状态不可用。".to_string())?
        .take()
    {
        terminate_child_tree(&mut session.child);
        let _ = session.child.wait();
    }
    clear_configured_source_browser(&state.components_dir)?;
    *state
        .source_browser
        .lock()
        .map_err(|_| "浏览器登录状态不可用。".to_string())? = browser.clone();
    Ok(SourceAuthStatus {
        configured: browser.is_some(),
        browser,
        login_open: false,
    })
}

#[derive(Debug, PartialEq)]
struct ResolverCapabilities {
    has_video: bool,
    has_audio: bool,
    max_height: Option<i64>,
    available_heights: Vec<i64>,
    quality_format_ids: BTreeMap<i64, String>,
    compatible_mp4: bool,
}

fn format_quality_dimension(width: Option<i64>, height: Option<i64>) -> Option<i64> {
    match (
        width.filter(|value| *value > 0),
        height.filter(|value| *value > 0),
    ) {
        (Some(width), Some(height)) => Some(width.min(height)),
        (Some(width), None) => Some(width),
        (None, Some(height)) => Some(height),
        (None, None) => None,
    }
}

fn resolver_capabilities(metadata: &ResolverOutput) -> ResolverCapabilities {
    let mut has_video = false;
    let mut has_audio = false;
    let mut max_height = None;
    let mut available_heights = BTreeSet::new();
    let mut has_h264_mp4 = false;
    let mut has_aac_mp4 = false;
    let mut inspect = |vcodec: Option<&str>,
                       acodec: Option<&str>,
                       width: Option<i64>,
                       height: Option<i64>,
                       extension: Option<&str>| {
        let video_codec = vcodec.unwrap_or("none").to_ascii_lowercase();
        let audio_codec = acodec.unwrap_or("none").to_ascii_lowercase();
        let extension = extension.unwrap_or_default().to_ascii_lowercase();
        let video_container = matches!(
            extension.as_str(),
            "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "flv" | "ts"
        );
        let audio_container = matches!(
            extension.as_str(),
            "m4a" | "mp3" | "aac" | "opus" | "ogg" | "wav" | "flac"
        );
        // Some extractors expose a playable single-file format without codec fields.
        // Treat a known media container as evidence, while respecting an explicit
        // `"none"` codec so audio-only and video-only formats stay distinguishable.
        let video = vcodec
            .map(|codec| !codec.is_empty() && !codec.eq_ignore_ascii_case("none"))
            .unwrap_or(video_container);
        let audio = acodec
            .map(|codec| !codec.is_empty() && !codec.eq_ignore_ascii_case("none"))
            .unwrap_or(audio_container || video_container);
        has_video |= video;
        has_audio |= audio;
        if video {
            if let Some(quality) = format_quality_dimension(width, height) {
                max_height = Some(max_height.map_or(quality, |current: i64| current.max(quality)));
            }
        }
        let mp4_family = matches!(extension.as_str(), "mp4" | "m4v" | "m4a");
        if video && mp4_family && (video_codec.starts_with("avc1") || video_codec == "h264") {
            has_h264_mp4 = true;
        }
        if audio && mp4_family && (audio_codec.starts_with("mp4a") || audio_codec == "aac") {
            has_aac_mp4 = true;
        }
    };
    inspect(
        metadata.vcodec.as_deref(),
        metadata.acodec.as_deref(),
        metadata.width,
        metadata.height,
        metadata.ext.as_deref(),
    );
    for format in &metadata.formats {
        inspect(
            format.vcodec.as_deref(),
            format.acodec.as_deref(),
            format.width,
            format.height,
            format.ext.as_deref(),
        );
    }
    let mut quality_candidates = BTreeMap::<i64, (u8, String)>::new();
    for format in &metadata.formats {
        let Some(format_id) = format
            .format_id
            .as_deref()
            .filter(|value| !value.is_empty() && value.len() <= 64)
            .filter(|value| {
                value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
                })
            })
        else {
            continue;
        };
        let vcodec = format
            .vcodec
            .as_deref()
            .unwrap_or("none")
            .to_ascii_lowercase();
        if vcodec.is_empty() || vcodec == "none" {
            continue;
        }
        let Some(quality) = format_quality_dimension(format.width, format.height) else {
            continue;
        };
        let codec_score = if vcodec.starts_with("avc1") || vcodec == "h264" {
            4
        } else if vcodec.starts_with("hvc1") || vcodec.starts_with("hev1") || vcodec == "hevc" {
            3
        } else if vcodec.starts_with("vp9") || vcodec.starts_with("vp09") {
            2
        } else if vcodec.starts_with("av01") || vcodec == "av1" {
            1
        } else {
            0
        };
        let combined_score = codec_score
            + u8::from(
                format
                    .acodec
                    .as_deref()
                    .is_some_and(|codec| !codec.is_empty() && !codec.eq_ignore_ascii_case("none")),
            );
        let replace = quality_candidates
            .get(&quality)
            .map(|(score, _)| combined_score > *score)
            .unwrap_or(true);
        if replace {
            quality_candidates.insert(quality, (combined_score, format_id.to_string()));
        }
    }
    available_heights.extend(quality_candidates.keys().copied());
    let quality_format_ids = quality_candidates
        .into_iter()
        .map(|(quality, (_, format_id))| (quality, format_id))
        .collect();
    ResolverCapabilities {
        has_video,
        has_audio,
        max_height,
        available_heights: available_heights.into_iter().rev().collect(),
        quality_format_ids,
        compatible_mp4: has_h264_mp4 && (!has_audio || has_aac_mp4),
    }
}

fn resolver_subtitle_options(metadata: &ResolverOutput) -> Vec<SubtitleOption> {
    let mut options = metadata
        .subtitles
        .keys()
        .map(|language| SubtitleOption {
            language: language.clone(),
            automatic: false,
        })
        .chain(
            metadata
                .automatic_captions
                .keys()
                .map(|language| SubtitleOption {
                    language: language.clone(),
                    automatic: true,
                }),
        )
        .filter(|option| !option.language.trim().is_empty())
        .collect::<Vec<_>>();
    options.sort_by(|left, right| {
        let rank = |language: &str| {
            if language.starts_with("zh") {
                0
            } else if language.starts_with("en") {
                1
            } else {
                2
            }
        };
        rank(&left.language)
            .cmp(&rank(&right.language))
            .then(left.language.cmp(&right.language))
            .then(left.automatic.cmp(&right.automatic))
    });
    options.dedup();
    options
}

#[tauri::command]
async fn resolve_inbox_item(id: i64, state: State<'_, AppState>) -> Result<InboxItem, String> {
    let component = state.components_dir.join("yt-dlp.exe");
    if !component.is_file() {
        let message = "需要下载引擎才能识别；链接已保留，安装后可继续。";
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        connection.execute(
            "UPDATE inbox_items SET status='captured',waiting_component=1,error_message=?1 WHERE id=?2",
            params![message, id],
        ).map_err(|error| format!("保存工具等待状态失败：{error}"))?;
        return Err(message.into());
    }
    let page_url = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        let page_url = connection
            .query_row(
                "SELECT page_url FROM inbox_items WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| "找不到该收集箱条目。".to_string())?;
        connection.execute(
            "UPDATE inbox_items SET status = 'resolving', waiting_component=0, error_message = NULL WHERE id = ?1", params![id],
        ).map_err(|error| format!("更新识别状态失败：{error}"))?;
        page_url
    };
    if let Err(message) = validate_network_destination(&page_url) {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        connection.execute("UPDATE inbox_items SET status='failed',waiting_component=0,error_message=?1 WHERE id=?2", params![message, id])
            .map_err(|error| format!("保存网络安全错误失败：{error}"))?;
        return Err(message);
    }

    let source_browser = state
        .source_browser
        .lock()
        .map_err(|_| "浏览器登录状态不可用。".to_string())?
        .clone();
    let cookie_directory = state.components_dir.clone();
    let output_result = tauri::async_runtime::spawn_blocking(move || {
        let run = |browser: Option<&str>| {
            let mut command = Command::new(&component);
            command.args([
                "--ignore-config",
                "--dump-single-json",
                "--skip-download",
                "--no-playlist",
                "--impersonate",
                "chrome",
                "--referer",
                &page_url,
                "--socket-timeout",
                "20",
            ]);
            if page_url.contains("youtube.com/") || page_url.contains("youtu.be/") {
                command.args(["--extractor-args", "youtube:player_client=default,android"]);
            }
            let deno = cookie_directory.join("deno.exe");
            if deno.is_file() {
                command
                    .arg("--js-runtimes")
                    .arg(format!("deno:{}", deno.to_string_lossy()));
            }
            if let Some(browser) = browser {
                command.arg("--cookies-from-browser").arg(browser);
            }
            command
                .args(["--", &page_url])
                .output()
                .map_err(|error| external_tool_start_error("下载引擎", &error))
        };
        let public_output = run(None)?;
        if public_output.status.success() {
            return Ok((public_output, false));
        }
        let public_error = resolver_error(&public_output.stderr);
        if task_error_code(&public_error, false) == "AUTH_REQUIRED" {
            if let Some(browser) = source_browser.as_deref() {
                return run(Some(browser)).map(|output| (output, true));
            }
        }
        Ok((public_output, false))
    })
    .await;

    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let (output, auth_used) = match output_result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            let message = error;
            connection.execute("UPDATE inbox_items SET status = 'failed', waiting_component=0, error_message = ?1 WHERE id = ?2", params![message, id])
                .map_err(|db_error| format!("保存识别错误失败：{db_error}"))?;
            return Err(message);
        }
        Err(error) => {
            let message = format!("识别任务异常结束：{error}");
            connection.execute("UPDATE inbox_items SET status = 'failed', waiting_component=0, error_message = ?1 WHERE id = ?2", params![message, id])
                .map_err(|db_error| format!("保存识别错误失败：{db_error}"))?;
            return Err(message);
        }
    };
    if output.status.success() {
        match serde_json::from_slice::<ResolverOutput>(&output.stdout) {
            Ok(metadata) => {
                let capabilities = resolver_capabilities(&metadata);
                let subtitle_options = resolver_subtitle_options(&metadata);
                let subtitles_json = serde_json::to_string(&subtitle_options)
                    .map_err(|error| format!("保存字幕清单失败：{error}"))?;
                let available_heights_json = serde_json::to_string(&capabilities.available_heights)
                    .map_err(|error| format!("保存清晰度清单失败：{error}"))?;
                let quality_format_ids_json =
                    serde_json::to_string(&capabilities.quality_format_ids)
                        .map_err(|error| format!("保存下载格式映射失败：{error}"))?;
                let source_id = metadata
                    .id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.chars().take(128).collect::<String>());
                let title = metadata
                    .title
                    .unwrap_or_else(|| "未命名视频".into())
                    .trim()
                    .chars()
                    .take(512)
                    .collect::<String>();
                let duration = metadata
                    .duration
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .map(|value| value.round() as i64);
                let thumbnail = metadata
                    .thumbnail
                    .filter(|value| value.starts_with("https://") || value.starts_with("http://"));
                connection.execute(
                    "UPDATE inbox_items SET status='ready',waiting_component=0,auth_required=?1,title=?2,duration_seconds=?3,thumbnail_url=?4,error_message=NULL,source_id=?5,has_video=?6,has_audio=?7,max_height=?8,available_heights_json=?9,quality_format_ids_json=?10,compatible_mp4=?11,estimated_bytes=?12,resolved_at=?13,subtitles_json=?14 WHERE id=?15",
                    params![auth_used as i64, title, duration, thumbnail, source_id, capabilities.has_video as i64, capabilities.has_audio as i64, capabilities.max_height, available_heights_json, quality_format_ids_json, capabilities.compatible_mp4 as i64, metadata.filesize.or(metadata.filesize_approx), unix_seconds(), subtitles_json, id],
                ).map_err(|error| format!("保存识别结果失败：{error}"))?;
            }
            Err(error) => {
                let message = format!("解析器返回了无法读取的数据：{error}");
                connection.execute("UPDATE inbox_items SET status = 'failed', waiting_component=0, error_message = ?1 WHERE id = ?2", params![message, id])
                    .map_err(|db_error| format!("保存识别错误失败：{db_error}"))?;
            }
        }
    } else {
        let message = resolver_error(&output.stderr);
        connection.execute(
            "UPDATE inbox_items SET status = 'failed', waiting_component=0, auth_required=0, error_message = ?1 WHERE id = ?2", params![message, id],
        ).map_err(|error| format!("保存识别错误失败：{error}"))?;
    }
    connection.query_row(
        "SELECT id, request_id, page_url, COALESCE(display_title,title), title, source_host, project_name, status, capture_method, created_at, resolved_at, duration_seconds, thumbnail_url, error_message, source_id, has_video, has_audio, max_height, available_heights_json, compatible_mp4, estimated_bytes, subtitles_json, waiting_component FROM inbox_items WHERE id = ?1",
        params![id], row_to_item,
    ).map_err(|error| format!("读取识别结果失败：{error}"))
}

#[tauri::command]
fn list_download_jobs(state: State<'_, AppState>) -> Result<Vec<DownloadJob>, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let mut statement = connection.prepare(
        "SELECT j.id, j.item_id, COALESCE(j.display_title,i.display_title,i.title), i.source_host, j.status, j.file_path, j.error_message, j.progress_percent, i.duration_seconds, i.thumbnail_url, j.quality, j.output_preset, j.created_at, j.updated_at, j.library_hidden, i.project_name, j.warning_message, j.save_subtitles, j.subtitle_languages_json, j.save_cover, j.save_source_record, j.retain_source, j.managed_file, j.error_code, j.stage, j.downloaded_bytes, j.total_bytes, j.speed_bytes_per_second, j.eta_seconds
         FROM download_jobs j JOIN inbox_items i ON i.id = j.item_id ORDER BY j.updated_at DESC, j.id DESC"
    ).map_err(|error| format!("读取下载任务失败：{error}"))?;
    let rows = statement
        .query_map([], row_to_download_job)
        .map_err(|error| format!("读取下载任务失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取下载任务失败：{error}"))
}

#[tauri::command]
fn list_media_derivatives(state: State<'_, AppState>) -> Result<Vec<MediaDerivative>, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let mut statement = connection.prepare(
        "SELECT d.id, d.parent_job_id, COALESCE(d.display_title,d.title), d.kind, d.status, d.file_path, d.error_message, d.progress_percent, d.created_at, d.updated_at, d.library_hidden, i.project_name, d.error_code FROM media_derivatives d JOIN download_jobs j ON j.id=d.parent_job_id JOIN inbox_items i ON i.id=j.item_id ORDER BY d.updated_at DESC, d.id DESC"
    ).map_err(|error| format!("读取处理结果失败：{error}"))?;
    let rows = statement
        .query_map([], row_to_derivative)
        .map_err(|error| format!("读取处理结果失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取处理结果失败：{error}"))
}

fn select_derivative(connection: &Connection, id: i64) -> Result<MediaDerivative, String> {
    connection.query_row(
        "SELECT d.id, d.parent_job_id, COALESCE(d.display_title,d.title), d.kind, d.status, d.file_path, d.error_message, d.progress_percent, d.created_at, d.updated_at, d.library_hidden, i.project_name, d.error_code FROM media_derivatives d JOIN download_jobs j ON j.id=d.parent_job_id JOIN inbox_items i ON i.id=j.item_id WHERE d.id=?1",
        params![id], row_to_derivative,
    ).map_err(|error| format!("读取处理结果失败：{error}"))
}

fn crop_filter(x: Option<f64>, y: Option<f64>, scale: Option<f64>) -> Result<String, String> {
    let x = x.unwrap_or(0.5);
    let y = y.unwrap_or(0.5);
    let scale = scale.unwrap_or(1.0);
    if !x.is_finite()
        || !y.is_finite()
        || !scale.is_finite()
        || !(0.0..=1.0).contains(&x)
        || !(0.0..=1.0).contains(&y)
        || !(1.0..=2.0).contains(&scale)
    {
        return Err("裁剪位置或缩放参数无效。".into());
    }
    Ok(format!(
        "crop=w='trunc((if(gt(iw/ih,9/16),ih*9/16,iw)/{scale:.4})/2)*2':h='trunc((if(gt(iw/ih,9/16),ih,iw*16/9)/{scale:.4})/2)*2':x='(iw-ow)*{x:.4}':y='(ih-oh)*{y:.4}',scale=720:1280"
    ))
}

#[cfg(test)]
fn execute_processing(
    ffmpeg: &PathBuf,
    input: &PathBuf,
    output: &PathBuf,
    mode: &str,
    start: Option<f64>,
    end: Option<f64>,
    crop_x: Option<f64>,
    crop_y: Option<f64>,
    crop_scale: Option<f64>,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(input);
    match mode {
        "convert" => {
            command.args([
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ]);
        }
        "clip" => {
            let start = start.ok_or("截取缺少开始时间。")?;
            let end = end.ok_or("截取缺少结束时间。")?;
            if !start.is_finite()
                || !end.is_finite()
                || start < 0.0
                || end <= start
                || end > 86_400.0
            {
                return Err("截取时间范围无效。".into());
            }
            command.args([
                "-ss",
                &format!("{start:.3}"),
                "-t",
                &format!("{:.3}", end - start),
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ]);
        }
        "audio" => {
            command.args(["-vn", "-c:a", "libmp3lame", "-q:a", "2"]);
        }
        "crop-vertical" => {
            command
                .arg("-vf")
                .arg(crop_filter(crop_x, crop_y, crop_scale)?)
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "22",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                ]);
        }
        "rotate-left" | "rotate-right" => {
            command
                .args([
                    "-vf",
                    if mode == "rotate-left" {
                        "transpose=2"
                    } else {
                        "transpose=1"
                    },
                ])
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "22",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                ]);
        }
        "mute" => {
            command.args([
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-movflags",
                "+faststart",
            ]);
        }
        "speed-2x" => {
            command.args([
                "-vf",
                "setpts=0.5*PTS",
                "-af",
                "atempo=2.0",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ]);
        }
        "compress" => {
            command.args([
                "-vf",
                "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease",
                "-c:v",
                "libx264",
                "-preset",
                "slow",
                "-crf",
                "28",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ]);
        }
        _ => return Err("不支持的处理方式。".into()),
    }
    let result = command
        .arg(output)
        .output()
        .map_err(|error| external_tool_start_error("FFmpeg", &error))?;
    if !result.status.success() {
        let _ = fs::remove_file(output);
        return Err(resolver_error(&result.stderr));
    }
    let valid = output
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if !valid {
        let _ = fs::remove_file(output);
        return Err("FFmpeg 没有生成有效文件。".into());
    }
    let actual_duration = match validate_media_streams(
        &ffmpeg.with_file_name("ffprobe.exe"),
        output,
        mode != "audio",
        mode == "audio",
    ) {
        Ok(duration) => duration,
        Err(error) => {
            let _ = fs::remove_file(output);
            return Err(error);
        }
    };
    if mode == "clip" {
        let requested_duration = end.unwrap_or_default() - start.unwrap_or_default();
        if let Err(error) = validate_clip_output_duration(requested_duration, actual_duration) {
            let _ = fs::remove_file(output);
            return Err(error);
        }
    }
    Ok(())
}

fn execute_processing_cancellable(
    ffmpeg: &PathBuf,
    input: &PathBuf,
    output: &PathBuf,
    mode: &str,
    start: Option<f64>,
    end: Option<f64>,
    crop_x: Option<f64>,
    crop_y: Option<f64>,
    crop_scale: Option<f64>,
    target_duration: Option<f64>,
    db_path: PathBuf,
    derivative_id: i64,
    cancelled: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(input);
    match mode {
        "convert" => {
            command.args([
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ]);
        }
        "clip" => {
            let start = start.ok_or("截取缺少开始时间。")?;
            let end = end.ok_or("截取缺少结束时间。")?;
            if !start.is_finite()
                || !end.is_finite()
                || start < 0.0
                || end <= start
                || end > 86_400.0
            {
                return Err("截取时间范围无效。".into());
            }
            command.args([
                "-ss",
                &format!("{start:.3}"),
                "-t",
                &format!("{:.3}", end - start),
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ]);
        }
        "audio" => {
            command.args(["-vn", "-c:a", "libmp3lame", "-q:a", "2"]);
        }
        "crop-vertical" => {
            command
                .arg("-vf")
                .arg(crop_filter(crop_x, crop_y, crop_scale)?)
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "22",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                ]);
        }
        "rotate-left" | "rotate-right" => {
            command
                .args([
                    "-vf",
                    if mode == "rotate-left" {
                        "transpose=2"
                    } else {
                        "transpose=1"
                    },
                ])
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "22",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                ]);
        }
        "mute" => {
            command.args([
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-movflags",
                "+faststart",
            ]);
        }
        "speed-2x" => {
            command.args([
                "-vf",
                "setpts=0.5*PTS",
                "-af",
                "atempo=2.0",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ]);
        }
        "compress" => {
            command.args([
                "-vf",
                "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease",
                "-c:v",
                "libx264",
                "-preset",
                "slow",
                "-crf",
                "28",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ]);
        }
        _ => return Err("不支持的处理方式。".into()),
    }
    let mut child = command
        .args(["-progress", "pipe:1", "-nostats"])
        .arg(output)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| external_tool_start_error("FFmpeg", &error))?;
    let stdout = child.stdout.take().ok_or("无法读取 FFmpeg 进度。")?;
    let stderr = child.stderr.take().ok_or("无法读取 FFmpeg 错误。")?;
    let (line_sender, line_receiver) = mpsc::channel();
    let stdout_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = line_sender.send(line);
        }
    });
    let stderr_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let connection =
        Connection::open(db_path).map_err(|error| format!("打开处理任务数据库失败：{error}"))?;
    let status = loop {
        for line in line_receiver.try_iter() {
            if let Some(microseconds) = line
                .strip_prefix("out_time_us=")
                .and_then(|value| value.parse::<f64>().ok())
            {
                if let Some(duration) =
                    target_duration.filter(|value| value.is_finite() && *value > 0.0)
                {
                    let percent =
                        ((microseconds / 1_000_000.0) / duration * 100.0).clamp(0.0, 99.0);
                    let _ = connection.execute("UPDATE media_derivatives SET progress_percent=?1,updated_at=?2 WHERE id=?3", params![percent, unix_seconds(), derivative_id]);
                }
            }
        }
        if cancelled.load(Ordering::Acquire) {
            terminate_child_tree(&mut child);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            let _ = fs::remove_file(output);
            return Err("处理已取消。".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                terminate_child_tree(&mut child);
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                let _ = fs::remove_file(output);
                return Err(format!("读取 FFmpeg 状态失败：{error}"));
            }
        }
    };
    let _ = stdout_thread.join();
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        let _ = fs::remove_file(output);
        return Err(resolver_error(&stderr));
    }
    let valid = output
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if !valid {
        let _ = fs::remove_file(output);
        return Err("FFmpeg 没有生成有效文件。".into());
    }
    let actual_duration = match validate_media_streams(
        &ffmpeg.with_file_name("ffprobe.exe"),
        output,
        mode != "audio",
        mode == "audio",
    ) {
        Ok(duration) => duration,
        Err(error) => {
            let _ = fs::remove_file(output);
            return Err(error);
        }
    };
    if mode == "clip" {
        let requested_duration = end.unwrap_or_default() - start.unwrap_or_default();
        if let Err(error) = validate_clip_output_duration(requested_duration, actual_duration) {
            let _ = fs::remove_file(output);
            return Err(error);
        }
    } else if mode == "speed-2x" {
        if let Some(requested_duration) = target_duration {
            if let Err(error) = validate_clip_output_duration(requested_duration, actual_duration) {
                let _ = fs::remove_file(output);
                return Err(error.replace("截取结果", "变速结果"));
            }
        }
    }
    Ok(())
}

fn validate_clip_range(
    start: Option<f64>,
    end: Option<f64>,
    source_duration: Option<i64>,
) -> Result<f64, String> {
    let start = start.ok_or("请输入截取开始时间。")?;
    let end = end.ok_or("请输入截取结束时间。")?;
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start || end > 86_400.0 {
        return Err("截取范围无效：开始时间需不小于 0，结束时间必须大于开始时间。".into());
    }
    if let Some(duration) = source_duration.filter(|value| *value > 0) {
        if end > duration as f64 + 0.05 {
            return Err(format!("结束时间超过素材时长（{duration} 秒）。"));
        }
    }
    Ok(end - start)
}

fn validate_clip_output_duration(
    requested_duration: f64,
    actual_duration: f64,
) -> Result<(), String> {
    if !requested_duration.is_finite()
        || !actual_duration.is_finite()
        || requested_duration <= 0.0
        || actual_duration <= 0.0
    {
        return Err("截取结果缺少有效时长。".into());
    }
    if (actual_duration - requested_duration).abs() > 0.1 {
        return Err(format!(
            "截取结果时长异常：请求 {requested_duration:.3} 秒，实际 {actual_duration:.3} 秒。"
        ));
    }
    Ok(())
}

fn matching_active_derivative_id(
    connection: &Connection,
    parent_job_id: i64,
    mode: &str,
    start: Option<f64>,
    end: Option<f64>,
    crop_x: Option<f64>,
    crop_y: Option<f64>,
    crop_scale: Option<f64>,
) -> Result<Option<i64>, String> {
    connection
        .query_row(
            "SELECT id FROM media_derivatives
         WHERE parent_job_id=?1 AND kind=?2 AND status IN ('queued','processing')
           AND ((start_seconds IS NULL AND ?3 IS NULL) OR start_seconds=?3)
           AND ((end_seconds IS NULL AND ?4 IS NULL) OR end_seconds=?4)
           AND ((crop_position_x IS NULL AND ?5 IS NULL) OR crop_position_x=?5)
           AND ((crop_position_y IS NULL AND ?6 IS NULL) OR crop_position_y=?6)
           AND ((crop_scale IS NULL AND ?7 IS NULL) OR crop_scale=?7)
         ORDER BY id LIMIT 1",
            params![parent_job_id, mode, start, end, crop_x, crop_y, crop_scale],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("检查重复处理任务失败：{error}"))
}

#[tauri::command]
async fn process_media(
    input: ProcessMediaInput,
    state: State<'_, AppState>,
) -> Result<MediaDerivative, String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let ffmpeg = state.components_dir.join("ffmpeg.exe");
    if !ffmpeg.is_file() || !ffmpeg.with_file_name("ffprobe.exe").is_file() {
        return Err("请先在“设置”安装或修复视频处理工具。".into());
    }
    if !matches!(
        input.mode.as_str(),
        "convert"
            | "clip"
            | "audio"
            | "crop-vertical"
            | "rotate-left"
            | "rotate-right"
            | "mute"
            | "speed-2x"
            | "compress"
    ) {
        return Err("不支持的处理方式。".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let active = state
        .active_processing
        .lock()
        .map_err(|_| "任务状态不可用。".to_string())?;
    let mut queued = state
        .queued_processing
        .lock()
        .map_err(|_| "排队状态不可用。".to_string())?;
    let (
        source,
        derivative_id,
        output,
        mode,
        start,
        end,
        crop_x,
        crop_y,
        crop_scale,
        target_duration,
    ) = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        let source = validated_media_path(&connection, &downloads_dir, input.job_id)?;
        let (has_video, has_audio, _) =
            inspect_compatible_mp4(&ffmpeg.with_file_name("ffprobe.exe"), &source)?;
        if input.mode == "audio" && !has_audio {
            return Err("该素材没有音频轨，无法提取 MP3。".into());
        }
        if input.mode == "speed-2x" && !has_audio {
            return Err("该素材没有音频轨，当前无法生成同步的 2 倍速副本。".into());
        }
        if input.mode != "audio" && !has_video {
            return Err("该素材没有视频轨，无法执行当前处理。".into());
        }
        let source_bytes = source
            .metadata()
            .map_err(|error| format!("读取原始素材大小失败：{error}"))?
            .len();
        let required = source_bytes
            .saturating_mul(2)
            .saturating_add(128 * 1_048_576);
        ensure_free_space(&downloads_dir, required, "处理该素材")?;
        let (title, source_duration): (String, Option<i64>) = connection.query_row("SELECT i.title,i.duration_seconds FROM download_jobs j JOIN inbox_items i ON i.id=j.item_id WHERE j.id=?1", params![input.job_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|_| "找不到原始素材。".to_string())?;
        let (start, end, target_duration) = if input.mode == "clip" {
            (
                input.start_seconds,
                input.end_seconds,
                Some(validate_clip_range(
                    input.start_seconds,
                    input.end_seconds,
                    source_duration,
                )?),
            )
        } else if input.mode == "speed-2x" {
            (None, None, source_duration.map(|value| value as f64 / 2.0))
        } else {
            (None, None, source_duration.map(|value| value as f64))
        };
        let (crop_x, crop_y, crop_scale) = if input.mode == "crop-vertical" {
            let values = (
                input.crop_position_x.unwrap_or(0.5),
                input.crop_position_y.unwrap_or(0.5),
                input.crop_scale.unwrap_or(1.0),
            );
            crop_filter(Some(values.0), Some(values.1), Some(values.2))?;
            (Some(values.0), Some(values.1), Some(values.2))
        } else {
            (None, None, None)
        };
        if let Some(existing_id) = matching_active_derivative_id(
            &connection,
            input.job_id,
            &input.mode,
            start,
            end,
            crop_x,
            crop_y,
            crop_scale,
        )? {
            return select_derivative(&connection, existing_id);
        }
        let now = unix_seconds();
        connection.execute("INSERT INTO media_derivatives(parent_job_id,title,kind,status,progress_percent,start_seconds,end_seconds,crop_position_x,crop_position_y,crop_scale,created_at,updated_at) VALUES(?1,?2,?3,'queued',0,?4,?5,?6,?7,?8,?9,?9)", params![input.job_id, title, input.mode, start, end, crop_x, crop_y, crop_scale, now])
            .map_err(|error| format!("创建处理任务失败：{error}"))?;
        let derivative_id = connection.last_insert_rowid();
        let extension = if input.mode == "audio" { "mp3" } else { "mp4" };
        let output_directory = asset_type_directory(
            &source,
            if input.mode == "audio" {
                "audio"
            } else {
                "video"
            },
        );
        fs::create_dir_all(&output_directory)
            .map_err(|error| format!("创建处理结果目录失败：{error}"))?;
        let output = output_directory.join(format!(
            "derived-{derivative_id}-{}.{}",
            input.mode, extension
        ));
        (
            source,
            derivative_id,
            output,
            input.mode,
            start,
            end,
            crop_x,
            crop_y,
            crop_scale,
            target_duration,
        )
    };
    queued.insert(derivative_id, cancelled.clone());
    drop(active);
    drop(queued);
    let output_for_task = output.clone();
    let db_path = state.db_path.clone();
    let progress_db_path = db_path.clone();
    let active_processing = state.active_processing.clone();
    let queued_processing = state.queued_processing.clone();
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            if cancelled.load(Ordering::Acquire) {
                if let Ok(mut queued) = queued_processing.lock() {
                    queued.remove(&derivative_id);
                }
                if let Ok(connection) = Connection::open(&db_path) {
                    let _ = connection.execute("UPDATE media_derivatives SET status='failed',error_message='排队处理已取消。',error_code='CANCELLED_BY_USER',updated_at=?1 WHERE id=?2", params![unix_seconds(), derivative_id]);
                }
                return;
            }
            let claimed = if let Ok(mut active) = active_processing.lock() {
                if let Ok(mut queued) = queued_processing.lock() {
                    try_claim_queued_task(&mut active, &mut queued, derivative_id, 1)
                } else {
                    false
                }
            } else {
                false
            };
            if claimed {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if let Ok(connection) = Connection::open(&db_path) {
            let _ = connection.execute(
                "UPDATE media_derivatives SET status='processing',updated_at=?1 WHERE id=?2",
                params![unix_seconds(), derivative_id],
            );
        }
        let result = execute_processing_cancellable(
            &ffmpeg,
            &source,
            &output_for_task,
            &mode,
            start,
            end,
            crop_x,
            crop_y,
            crop_scale,
            target_duration,
            progress_db_path,
            derivative_id,
            cancelled,
        );
        if let Ok(connection) = Connection::open(&db_path) {
            let now = unix_seconds();
            match result {
                Ok(()) => {
                    let _ = connection.execute("UPDATE media_derivatives SET status='completed',file_path=?1,error_message=NULL,error_code=NULL,progress_percent=100,updated_at=?2 WHERE id=?3", params![output.to_string_lossy(), now, derivative_id]);
                }
                Err(message) => {
                    let code = task_error_code(&message, true);
                    let _ = connection.execute("UPDATE media_derivatives SET status='failed',error_message=?1,error_code=?2,updated_at=?3 WHERE id=?4", params![message, code, now, derivative_id]);
                }
            }
        }
        if let Ok(mut active) = active_processing.lock() {
            active.remove(&derivative_id);
        }
    });
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    select_derivative(&connection, derivative_id)
}

fn processing_retry_input(
    connection: &Connection,
    derivative_id: i64,
) -> Result<ProcessMediaInput, String> {
    connection.query_row(
        "SELECT parent_job_id,kind,start_seconds,end_seconds,crop_position_x,crop_position_y,crop_scale FROM media_derivatives WHERE id=?1 AND status='failed'",
        params![derivative_id],
        |row| Ok(ProcessMediaInput { job_id: row.get(0)?, mode: row.get(1)?, start_seconds: row.get(2)?, end_seconds: row.get(3)?, crop_position_x: row.get(4)?, crop_position_y: row.get(5)?, crop_scale: row.get(6)? }),
    ).map_err(|_| "只能重试失败的处理任务。".to_string())
}

#[tauri::command]
async fn retry_processing(
    derivative_id: i64,
    state: State<'_, AppState>,
) -> Result<MediaDerivative, String> {
    let input = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        processing_retry_input(&connection, derivative_id)?
    };
    process_media(input, state).await
}

#[tauri::command]
fn cancel_processing(derivative_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancelled) = state
        .active_processing
        .lock()
        .map_err(|_| "任务状态不可用。".to_string())?
        .get(&derivative_id)
    {
        cancelled.store(true, Ordering::Release);
        return Ok(());
    }
    if let Some(cancelled) = state
        .queued_processing
        .lock()
        .map_err(|_| "排队状态不可用。".to_string())?
        .get(&derivative_id)
    {
        cancelled.store(true, Ordering::Release);
        return Ok(());
    }
    Err("该处理任务当前未运行或排队。".into())
}

fn select_download_job(connection: &Connection, item_id: i64) -> Result<DownloadJob, String> {
    connection.query_row(
        "SELECT j.id, j.item_id, COALESCE(j.display_title,i.display_title,i.title), i.source_host, j.status, j.file_path, j.error_message, j.progress_percent, i.duration_seconds, i.thumbnail_url, j.quality, j.output_preset, j.created_at, j.updated_at, j.library_hidden, i.project_name, j.warning_message, j.save_subtitles, j.subtitle_languages_json, j.save_cover, j.save_source_record, j.retain_source, j.managed_file, j.error_code, j.stage, j.downloaded_bytes, j.total_bytes, j.speed_bytes_per_second, j.eta_seconds
         FROM download_jobs j JOIN inbox_items i ON i.id = j.item_id WHERE j.item_id = ?1",
        params![item_id], row_to_download_job,
    ).map_err(|error| format!("读取下载任务失败：{error}"))
}

fn validate_media_signature(path: &PathBuf, extension: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|error| format!("读取本地媒体失败：{error}"))?;
    let mut header = [0_u8; 16];
    let read = file
        .read(&mut header)
        .map_err(|error| format!("读取本地媒体失败：{error}"))?;
    let header = &header[..read];
    let matches = match extension {
        "mp4" | "mov" | "m4v" | "m4a" => header.get(4..8) == Some(b"ftyp"),
        "mkv" | "webm" => header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "avi" => header.starts_with(b"RIFF") && header.get(8..12) == Some(b"AVI "),
        "wav" => header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WAVE"),
        "mp3" => {
            header.starts_with(b"ID3")
                || (header.len() >= 2 && header[0] == 0xff && header[1] & 0xe0 == 0xe0)
        }
        "flac" => header.starts_with(b"fLaC"),
        _ => false,
    };
    if matches {
        Ok(())
    } else {
        Err(format!("文件内容与 .{extension} 媒体格式不匹配，未导入。"))
    }
}

fn validate_local_media_with_probe(
    raw_path: &str,
    ffprobe: &PathBuf,
) -> Result<(PathBuf, u64), String> {
    if !ffprobe.is_file() {
        return Err("导入本地素材前需要视频处理工具，用于确认文件是可读取的真实媒体。".into());
    }
    let path = PathBuf::from(raw_path)
        .canonicalize()
        .map_err(|_| "选择的本地文件不存在。".to_string())?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let allowed = [
        "mp4", "mov", "mkv", "webm", "m4v", "avi", "mp3", "m4a", "wav", "flac",
    ];
    if !allowed.contains(&extension.as_str()) {
        return Err(format!("不支持导入 .{extension} 文件。"));
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("读取本地文件失败：{error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("只能导入非空本地媒体文件。".into());
    }
    validate_media_signature(&path, &extension)?;
    let (has_video, has_audio, _) = inspect_compatible_mp4(ffprobe, &path)
        .map_err(|error| format!("文件无法作为媒体读取：{error}"))?;
    if !has_video && !has_audio {
        return Err("文件没有可识别的音频或视频轨，未导入。".into());
    }
    validate_media_streams(ffprobe, &path, has_video, has_audio)
        .map_err(|error| format!("文件媒体校验未通过：{error}"))?;
    Ok((path, metadata.len()))
}

fn validate_probe_json(
    raw: &[u8],
    require_video: bool,
    require_audio: bool,
) -> Result<f64, String> {
    let value: serde_json::Value =
        serde_json::from_slice(raw).map_err(|_| "媒体探测结果无法解析。".to_string())?;
    let streams = value
        .get("streams")
        .and_then(|item| item.as_array())
        .ok_or("媒体探测结果缺少轨道信息。")?;
    let has_video = streams
        .iter()
        .any(|stream| stream.get("codec_type").and_then(|item| item.as_str()) == Some("video"));
    let has_audio = streams
        .iter()
        .any(|stream| stream.get("codec_type").and_then(|item| item.as_str()) == Some("audio"));
    if require_video && !has_video {
        return Err("输出文件没有可识别的视频轨。".into());
    }
    if require_audio && !has_audio {
        return Err("输出文件没有可识别的音频轨。".into());
    }
    let duration = value
        .get("format")
        .and_then(|item| item.get("duration"))
        .and_then(|item| item.as_str())
        .and_then(|item| item.parse::<f64>().ok())
        .filter(|item| item.is_finite() && *item > 0.0)
        .ok_or("输出文件没有有效时长。")?;
    Ok(duration)
}

fn validate_media_streams(
    ffprobe: &PathBuf,
    path: &PathBuf,
    require_video: bool,
    require_audio: bool,
) -> Result<f64, String> {
    if !ffprobe.is_file() {
        return Err("缺少 FFprobe，无法校验输出媒体。".into());
    }
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            "--",
        ])
        .arg(path)
        .output()
        .map_err(|error| external_tool_start_error("视频校验工具", &error))?;
    if !output.status.success() {
        return Err(format!("媒体校验失败：{}", resolver_error(&output.stderr)));
    }
    validate_probe_json(&output.stdout, require_video, require_audio)
}

fn derivative_output_path(downloads_dir: &PathBuf, derivative_id: i64, kind: &str) -> PathBuf {
    let extension = if kind == "audio" { "mp3" } else { "mp4" };
    downloads_dir.join(format!("derived-{derivative_id}-{kind}.{extension}"))
}

fn recover_interrupted_jobs(
    connection: &Connection,
    downloads_dir: &PathBuf,
    ffprobe: &PathBuf,
) -> Result<(), String> {
    connection.execute(
        "UPDATE download_jobs SET status='failed', stage='failed', speed_bytes_per_second=NULL, eta_seconds=NULL, error_message='应用上次退出时下载或排队尚未完成，可重新开始。', error_code='PROCESS_FAILED' WHERE status IN ('downloading','queued')",
        [],
    ).map_err(|error| format!("恢复下载任务失败：{error}"))?;

    let interrupted = {
        let mut statement = connection.prepare(
            "SELECT d.id,d.kind,j.file_path FROM media_derivatives d JOIN download_jobs j ON j.id=d.parent_job_id WHERE d.status IN ('processing','queued') ORDER BY d.id",
        ).map_err(|error| format!("读取中断处理任务失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| format!("读取中断处理任务失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取中断处理任务失败：{error}"))?;
        rows
    };

    for (derivative_id, kind, source_path) in interrupted {
        let output_directory = source_path
            .as_ref()
            .map(PathBuf::from)
            .map(|source| {
                asset_type_directory(&source, if kind == "audio" { "audio" } else { "video" })
            })
            .unwrap_or_else(|| downloads_dir.clone());
        let output = derivative_output_path(&output_directory, derivative_id, &kind);
        let output_metadata = output.metadata().ok();
        if output_metadata
            .as_ref()
            .is_some_and(|metadata| metadata.is_file() && metadata.len() == 0)
        {
            let _ = fs::remove_file(&output);
        }
        let has_output =
            output_metadata.is_some_and(|metadata| metadata.is_file() && metadata.len() > 0);
        if has_output && ffprobe.is_file() {
            let validation =
                validate_media_streams(ffprobe, &output, kind != "audio", kind == "audio");
            if validation.is_ok() {
                connection.execute(
                    "UPDATE media_derivatives SET status='completed',file_path=?1,error_message=NULL,error_code=NULL,progress_percent=100,updated_at=?2 WHERE id=?3 AND status IN ('processing','queued')",
                    params![output.to_string_lossy(), unix_seconds(), derivative_id],
                ).map_err(|error| format!("补登记已完成处理文件失败：{error}"))?;
                continue;
            }
            let reason = validation.unwrap_err();
            let cleanup_note = match fs::remove_file(&output) {
                Ok(()) => "已清理未完成输出。".to_string(),
                Err(error) => format!(
                    "未完成输出保留在 {}（清理失败：{error}）。",
                    output.to_string_lossy()
                ),
            };
            let message =
                format!("应用上次退出时处理未完成；恢复校验未通过：{reason} {cleanup_note}");
            connection.execute(
                "UPDATE media_derivatives SET status='failed',error_message=?1,error_code=?2,updated_at=?3 WHERE id=?4",
                params![message, task_error_code(&message, true), unix_seconds(), derivative_id],
            ).map_err(|error| format!("记录处理恢复失败：{error}"))?;
            continue;
        }

        let message = if has_output {
            format!("应用上次退出时处理未完成；当前缺少视频校验工具，可能的输出已保留在 {}，安装视频处理工具后可重试。", output.to_string_lossy())
        } else {
            "应用上次退出时处理或排队尚未完成，可按原参数重试。".to_string()
        };
        connection.execute(
            "UPDATE media_derivatives SET status='failed',error_message=?1,error_code=?2,updated_at=?3 WHERE id=?4",
            params![message, task_error_code(&message, true), unix_seconds(), derivative_id],
        ).map_err(|error| format!("记录处理恢复失败：{error}"))?;
    }
    Ok(())
}

fn copy_local_media_atomically(
    source: &PathBuf,
    destination: &PathBuf,
    expected_bytes: u64,
) -> Result<(), String> {
    let temporary = destination.with_extension(format!(
        "{}.importing",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("media")
    ));
    let copy_result = (|| -> Result<(), String> {
        let copied =
            fs::copy(source, &temporary).map_err(|error| format!("复制本地素材失败：{error}"))?;
        if copied != expected_bytes {
            return Err(format!(
                "复制本地素材不完整：期望 {expected_bytes} 字节，实际 {copied} 字节。"
            ));
        }
        fs::rename(&temporary, destination)
            .map_err(|error| format!("启用本地素材副本失败：{error}"))?;
        Ok(())
    })();
    if copy_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    copy_result
}

fn import_local_media_records(
    connection: &mut Connection,
    downloads_dir: &PathBuf,
    paths: Vec<String>,
    project_name: String,
    import_mode: &str,
) -> Result<Vec<DownloadJob>, String> {
    if paths.is_empty() {
        return Err("没有收到本地媒体文件。".into());
    }
    if paths.len() > 100 {
        return Err("单次最多导入 100 个本地文件。".into());
    }
    let project_name = project_name.trim().chars().take(50).collect::<String>();
    let project_name = if project_name.is_empty() {
        "未分类".into()
    } else {
        project_name
    };
    if !matches!(import_mode, "copy" | "reference") {
        return Err("未知的本地导入方式。".into());
    }
    let allowed = [
        "mp4", "mov", "mkv", "webm", "m4v", "avi", "mp3", "m4a", "wav", "flac",
    ];
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始本地导入事务失败：{error}"))?;
    let mut copied_paths = Vec::new();
    let operation = (|| -> Result<Vec<DownloadJob>, String> {
        let mut imported = Vec::new();
        for (index, raw_path) in paths.into_iter().enumerate() {
            let source = PathBuf::from(raw_path)
                .canonicalize()
                .map_err(|_| "选择的本地文件不存在。".to_string())?;
            if !source.is_file() {
                return Err("只能导入本地媒体文件。".into());
            }
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !allowed.contains(&extension.as_str()) {
                return Err(format!("不支持导入 .{extension} 文件。"));
            }
            let bytes = source
                .metadata()
                .map_err(|error| format!("读取本地文件失败：{error}"))?
                .len();
            if bytes == 0 {
                return Err("不能导入空文件。".into());
            }
            validate_media_signature(&source, &extension)?;
            if import_mode == "copy" {
                ensure_free_space(
                    downloads_dir,
                    bytes.saturating_add(64 * 1_048_576),
                    "导入本地素材",
                )?;
            }
            let request_id = new_request_id();
            let title = source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("本地素材")
                .chars()
                .take(512)
                .collect::<String>();
            let destination =
                downloads_dir.join(format!("local-{}-{index}.{extension}", request_id));
            let local_reference = format!("https://local.clipcargo.invalid/{request_id}");
            if import_mode == "copy" {
                copied_paths.push(destination.clone());
                copy_local_media_atomically(&source, &destination, bytes)?;
            }
            let stored_path = if import_mode == "copy" {
                &destination
            } else {
                &source
            };
            let now = unix_seconds();
            transaction.execute(
                "INSERT INTO inbox_items(request_id,page_url,title,source_host,project_name,status,capture_method,created_at) VALUES(?1,?2,?3,'本地文件',?4,'ready','local-import',?5)",
                params![request_id, local_reference, title, project_name, now],
            ).map_err(|error| format!("保存本地素材索引失败：{error}"))?;
            let item_id = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO download_jobs(item_id,status,file_path,quality,progress_percent,managed_file,created_at,updated_at) VALUES(?1,'completed',?2,'local',100,?3,?4,?4)",
                params![item_id, stored_path.to_string_lossy(), (import_mode == "copy") as i64, now],
            ).map_err(|error| format!("保存本地素材记录失败：{error}"))?;
            imported.push(select_download_job(&transaction, item_id)?);
        }
        Ok(imported)
    })();
    match operation {
        Ok(imported) => {
            if let Err(error) = transaction.commit() {
                for path in copied_paths {
                    let _ = fs::remove_file(path);
                }
                return Err(format!("提交本地导入事务失败：{error}"));
            }
            Ok(imported)
        }
        Err(error) => {
            drop(transaction);
            for path in copied_paths {
                let _ = fs::remove_file(path);
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn import_local_media(
    paths: Vec<String>,
    project_name: Option<String>,
    import_mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<DownloadJob>, String> {
    let downloads_dir = current_downloads_dir(&state)?;
    fs::create_dir_all(&downloads_dir).map_err(|error| format!("创建素材目录失败：{error}"))?;
    let ffprobe = state.components_dir.join("ffprobe.exe");
    for path in &paths {
        validate_local_media_with_probe(path, &ffprobe)?;
    }
    let mut connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    import_local_media_records(
        &mut connection,
        &downloads_dir,
        paths,
        project_name.unwrap_or_else(|| "未分类".into()),
        import_mode.as_deref().unwrap_or("copy"),
    )
}

#[tauri::command]
fn inspect_local_media(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<LocalImportPreview, String> {
    if paths.is_empty() || paths.len() > 100 {
        return Err("请选择 1–100 个本地媒体文件。".into());
    }
    let mut total_bytes = 0_u64;
    let ffprobe = state.components_dir.join("ffprobe.exe");
    for raw_path in &paths {
        let (_, bytes) = validate_local_media_with_probe(raw_path, &ffprobe)?;
        total_bytes = total_bytes.saturating_add(bytes);
    }
    Ok(LocalImportPreview {
        count: paths.len(),
        total_bytes,
    })
}

fn relink_media_record(
    connection: &Connection,
    downloads_dir: &PathBuf,
    asset_type: &str,
    asset_id: i64,
    raw_path: &str,
) -> Result<(), String> {
    let source = PathBuf::from(raw_path)
        .canonicalize()
        .map_err(|_| "选择的替代文件不存在。".to_string())?;
    if !source.is_file() {
        return Err("只能使用本地媒体文件重新定位素材。".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let allowed = [
        "mp4", "mov", "mkv", "webm", "m4v", "avi", "mp3", "m4a", "wav", "flac",
    ];
    if !allowed.contains(&extension.as_str()) {
        return Err(format!("不支持使用 .{extension} 文件替代素材。"));
    }
    let bytes = source
        .metadata()
        .map_err(|error| format!("读取替代文件失败：{error}"))?
        .len();
    if bytes == 0 {
        return Err("不能使用空文件替代素材。".into());
    }
    validate_media_signature(&source, &extension)?;
    let managed_file = match asset_type {
        "original" => connection
            .query_row(
                "SELECT managed_file FROM download_jobs WHERE id=?1 AND status='completed'",
                params![asset_id],
                |row| row.get::<_, i64>(0),
            )
            .optional(),
        "derivative" => connection
            .query_row(
                "SELECT 1 FROM media_derivatives WHERE id=?1 AND status='completed'",
                params![asset_id],
                |row| row.get::<_, i64>(0),
            )
            .optional(),
        _ => return Err("未知的素材类型。".into()),
    }
    .map_err(|error| format!("检查素材失败：{error}"))?
    .ok_or("找不到需要重新定位的素材。")?
        != 0;

    if asset_type == "original" && !managed_file {
        let updated = connection.execute(
            "UPDATE download_jobs SET file_path=?1, library_hidden=0, updated_at=?2 WHERE id=?3 AND status='completed' AND managed_file=0",
            params![source.to_string_lossy(), unix_seconds(), asset_id],
        ).map_err(|error| format!("保存外部引用新路径失败：{error}"))?;
        return if updated == 1 {
            Ok(())
        } else {
            Err("素材已不存在，未更新外部引用。".into())
        };
    }

    fs::create_dir_all(downloads_dir).map_err(|error| format!("创建素材目录失败：{error}"))?;
    ensure_free_space(
        downloads_dir,
        bytes.saturating_add(64 * 1_048_576),
        "重新定位素材",
    )?;

    let destination = downloads_dir.join(format!(
        "relinked-{}-{asset_id}.{extension}",
        new_request_id()
    ));
    copy_local_media_atomically(&source, &destination, bytes)
        .map_err(|error| format!("复制替代素材失败：{error}"))?;
    let updated = match asset_type {
        "original" => connection.execute("UPDATE download_jobs SET file_path=?1, managed_file=1, library_hidden=0, updated_at=?2 WHERE id=?3 AND status='completed'", params![destination.to_string_lossy(), unix_seconds(), asset_id]),
        "derivative" => connection.execute("UPDATE media_derivatives SET file_path=?1, library_hidden=0, updated_at=?2 WHERE id=?3 AND status='completed'", params![destination.to_string_lossy(), unix_seconds(), asset_id]),
        _ => unreachable!(),
    };
    match updated {
        Ok(1) => Ok(()),
        Ok(_) => {
            let _ = fs::remove_file(&destination);
            Err("素材已不存在，未保存替代文件。".into())
        }
        Err(error) => {
            let _ = fs::remove_file(&destination);
            Err(format!("保存替代素材失败：{error}"))
        }
    }
}

#[tauri::command]
fn relink_media(
    asset_type: String,
    asset_id: i64,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let downloads_dir = current_downloads_dir(&state)?;
    validate_local_media_with_probe(&path, &state.components_dir.join("ffprobe.exe"))?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    relink_media_record(&connection, &downloads_dir, &asset_type, asset_id, &path)
}

fn validated_media_path(
    connection: &Connection,
    downloads_dir: &PathBuf,
    job_id: i64,
) -> Result<PathBuf, String> {
    let (raw_path, managed_file, capture_method): (String, i64, String) = connection.query_row(
        "SELECT j.file_path,j.managed_file,i.capture_method FROM download_jobs j JOIN inbox_items i ON i.id=j.item_id WHERE j.id=?1 AND j.status='completed' AND j.file_path IS NOT NULL",
        params![job_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "找不到已完成的本地素材。".to_string())?;
    let stored_file = PathBuf::from(raw_path);
    let canonical_file = stored_file
        .canonicalize()
        .map_err(|_| "本地文件已移动或不存在。".to_string())?;
    if !canonical_file.is_file() {
        return Err("本地文件已移动或不存在。".into());
    }
    if managed_file != 0 {
        validate_managed_path(connection, downloads_dir, &stored_file, &canonical_file)?;
    } else if capture_method != "local-import" {
        return Err("外部素材引用缺少用户导入记录。".into());
    }
    Ok(canonical_file)
}

fn validate_managed_path(
    connection: &Connection,
    current_downloads_dir: &PathBuf,
    stored_file: &PathBuf,
    canonical_file: &PathBuf,
) -> Result<(), String> {
    if stored_file
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("素材路径包含不安全的父目录引用。".into());
    }
    let mut roots = vec![current_downloads_dir.clone()];
    let mut statement = connection
        .prepare("SELECT path FROM managed_roots")
        .map_err(|error| format!("读取素材目录授权失败：{error}"))?;
    let stored_roots = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("读取素材目录授权失败：{error}"))?;
    for root in stored_roots.flatten() {
        roots.push(PathBuf::from(root));
    }
    let allowed = roots.into_iter().any(|root| {
        let canonical_root = root.canonicalize().unwrap_or(root);
        path_is_within_root(canonical_file, &canonical_root)
            || path_is_within_root(stored_file, &canonical_root)
    });
    if allowed {
        Ok(())
    } else {
        Err("素材路径不在 ClipCargo 授权的保存目录内。".into())
    }
}

fn path_is_within_root(path: &PathBuf, root: &PathBuf) -> bool {
    if path.starts_with(root) {
        return true;
    }
    #[cfg(windows)]
    {
        fn normalized_windows_path(path: &PathBuf) -> String {
            path.to_string_lossy()
                .trim_start_matches(r"\\?\")
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase()
        }
        let normalized_path = normalized_windows_path(path);
        let normalized_root = normalized_windows_path(root);
        return normalized_path == normalized_root
            || normalized_path.starts_with(&format!("{normalized_root}\\"));
    }
    #[cfg(not(windows))]
    false
}

fn validated_derivative_path(
    connection: &Connection,
    downloads_dir: &PathBuf,
    derivative_id: i64,
) -> Result<PathBuf, String> {
    let raw_path: String = connection.query_row(
        "SELECT file_path FROM media_derivatives WHERE id=?1 AND status='completed' AND file_path IS NOT NULL",
        params![derivative_id], |row| row.get(0),
    ).map_err(|_| "找不到已完成的派生素材。".to_string())?;
    let stored_file = PathBuf::from(raw_path);
    let file = stored_file
        .canonicalize()
        .map_err(|_| "派生文件已移动或不存在。".to_string())?;
    if !file.is_file() {
        return Err("派生素材路径无效。".into());
    }
    validate_managed_path(connection, downloads_dir, &stored_file, &file)?;
    Ok(file)
}

fn asset_path(
    connection: &Connection,
    downloads_dir: &PathBuf,
    asset_type: &str,
    asset_id: i64,
) -> Result<PathBuf, String> {
    match asset_type {
        "original" => validated_media_path(connection, downloads_dir, asset_id),
        "derivative" => validated_derivative_path(connection, downloads_dir, asset_id),
        _ => Err("未知的素材类型。".into()),
    }
}

fn discover_sidecar_subtitles(media_path: &PathBuf) -> Result<Vec<SubtitleTrack>, String> {
    let directory = media_path.parent().ok_or("素材路径缺少父目录。")?;
    let stem = media_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("素材文件名无效。")?;
    let prefix = format!("{stem}.");
    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    let mut directories = vec![directory.to_path_buf()];
    let organized = asset_root_for_media(media_path).join("subtitles");
    if organized != directory {
        directories.push(organized);
    }
    for directory in directories {
        if !directory.is_dir() {
            continue;
        }
        let canonical_directory = directory
            .canonicalize()
            .map_err(|error| format!("校验字幕目录失败：{error}"))?;
        for entry in
            fs::read_dir(&directory).map_err(|error| format!("读取字幕目录失败：{error}"))?
        {
            let entry = entry.map_err(|error| format!("读取字幕文件失败：{error}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Ok(path) = path.canonicalize() else {
                continue;
            };
            if !path.starts_with(&canonical_directory) || !seen.insert(path.clone()) {
                continue;
            }
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(extension.as_str(), "vtt" | "srt") {
                continue;
            }
            let file_stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            let Some(language) = file_stem.strip_prefix(&prefix) else {
                continue;
            };
            let language = language.trim().to_string();
            if language.is_empty() || language.chars().count() > 40 {
                continue;
            }
            tracks.push(SubtitleTrack {
                path: path.to_string_lossy().to_string(),
                label: language.clone(),
                language,
            });
        }
    }
    tracks.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(tracks)
}

#[tauri::command]
fn get_media_subtitles(
    asset_type: String,
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<SubtitleTrack>, String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let media_path = asset_path(&connection, &downloads_dir, &asset_type, asset_id)?;
    discover_sidecar_subtitles(&media_path)
}

#[tauri::command]
fn open_media_external(
    asset_type: String,
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let file_path = asset_path(&connection, &downloads_dir, &asset_type, asset_id)?;
    Command::new("explorer.exe")
        .arg(file_path)
        .spawn()
        .map_err(|error| format!("无法调用系统播放器：{error}"))?;
    Ok(())
}

#[tauri::command]
fn reveal_media(
    asset_type: String,
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let file_path = asset_path(&connection, &downloads_dir, &asset_type, asset_id)?;
    Command::new("explorer.exe")
        .arg(format!("/select,{}", file_path.to_string_lossy()))
        .spawn()
        .map_err(|error| format!("无法打开文件位置：{error}"))?;
    Ok(())
}

#[tauri::command]
fn open_components_directory(state: State<'_, AppState>) -> Result<(), String> {
    let directory = prepare_directory_for_open(&state.components_dir, "工具")?;
    Command::new("explorer.exe")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开工具与许可文件目录：{error}"))?;
    Ok(())
}

#[tauri::command]
fn open_downloads_directory(state: State<'_, AppState>) -> Result<(), String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let directory = prepare_directory_for_open(&downloads_dir, "下载")?;
    Command::new("explorer.exe")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开下载目录：{error}"))?;
    Ok(())
}

#[tauri::command]
fn set_downloads_directory(
    directory: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PathBuf, String> {
    if !state
        .active_downloads
        .lock()
        .map_err(|_| "下载任务状态不可用。".to_string())?
        .is_empty()
        || !state
            .queued_downloads
            .lock()
            .map_err(|_| "下载排队状态不可用。".to_string())?
            .is_empty()
        || !state
            .active_processing
            .lock()
            .map_err(|_| "处理任务状态不可用。".to_string())?
            .is_empty()
        || !state
            .queued_processing
            .lock()
            .map_err(|_| "处理排队状态不可用。".to_string())?
            .is_empty()
    {
        return Err("请等待当前下载或处理任务结束后再更改保存位置。".into());
    }
    let requested = PathBuf::from(directory.trim());
    if !requested.is_absolute() || requested.to_string_lossy().len() > 2048 {
        return Err("请选择有效的本地文件夹。".into());
    }
    fs::create_dir_all(&requested).map_err(|error| format!("无法创建所选文件夹：{error}"))?;
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("无法使用所选文件夹：{error}"))?;
    if !canonical.is_dir() {
        return Err("所选位置不是文件夹。".into());
    }
    ensure_free_space(&canonical, 256 * 1_048_576, "更改保存位置")?;
    let temporary = state.downloads_config_path.with_extension("txt.tmp");
    fs::write(&temporary, canonical.to_string_lossy().as_bytes())
        .map_err(|error| format!("保存下载位置失败：{error}"))?;
    fs::rename(&temporary, &state.downloads_config_path)
        .map_err(|error| format!("启用下载位置失败：{error}"))?;
    {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        connection
            .execute(
                "INSERT OR IGNORE INTO managed_roots(path,created_at) VALUES(?1,?2)",
                params![canonical.to_string_lossy(), unix_seconds()],
            )
            .map_err(|error| format!("保存素材目录授权失败：{error}"))?;
    }
    app.asset_protocol_scope()
        .allow_directory(&canonical, true)
        .map_err(|error| format!("允许应用读取所选目录失败：{error}"))?;
    *state
        .downloads_dir
        .lock()
        .map_err(|_| "下载目录状态不可用。".to_string())? = canonical.clone();
    Ok(canonical)
}

fn prepare_directory_for_open(path: &PathBuf, label: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|error| format!("无法创建{label}目录：{error}"))?;
    let directory =
        fs::canonicalize(path).map_err(|error| format!("无法确认{label}目录：{error}"))?;
    if !directory.is_dir() {
        return Err(format!("{label}目录不可用：{}", directory.display()));
    }
    Ok(directory)
}

const EMBEDDED_EXTENSION_FILES: [(&str, &[u8]); 11] = [
    (
        "manifest.json",
        include_bytes!("../../extension/manifest.json"),
    ),
    (
        "background.js",
        include_bytes!("../../extension/background.js"),
    ),
    ("content.js", include_bytes!("../../extension/content.js")),
    ("popup.html", include_bytes!("../../extension/popup.html")),
    ("popup.css", include_bytes!("../../extension/popup.css")),
    ("popup.js", include_bytes!("../../extension/popup.js")),
    (
        "icons/32.png",
        include_bytes!("../../extension/icons/32.png"),
    ),
    (
        "icons/64.png",
        include_bytes!("../../extension/icons/64.png"),
    ),
    (
        "icons/128.png",
        include_bytes!("../../extension/icons/128.png"),
    ),
    (
        "icons/download.svg",
        include_bytes!("../../extension/icons/download.svg"),
    ),
    (
        "icons/folder.svg",
        include_bytes!("../../extension/icons/folder.svg"),
    ),
];

const DEVELOPMENT_EXTENSION_ID: &str = "dpogajmenckmdbpacaoilnhhdcjpbheb";
const STORE_EXTENSION_ID: &str = "maenmnckhgckmkcaijmpeghkcfhchiha";
const TRUSTED_EXTENSION_IDS: [&str; 2] = [DEVELOPMENT_EXTENSION_ID, STORE_EXTENSION_ID];

fn materialize_embedded_extension(extension_dir: &PathBuf) -> Result<PathBuf, String> {
    fs::create_dir_all(extension_dir).map_err(|error| format!("无法创建扩展目录：{error}"))?;
    for (relative, content) in EMBEDDED_EXTENSION_FILES {
        let destination = extension_dir.join(relative);
        let parent = destination.parent().ok_or("扩展文件路径无效。")?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建扩展目录：{error}"))?;
        let temporary = destination.with_extension("clipcargo.tmp");
        fs::write(&temporary, content).map_err(|error| format!("无法释放扩展文件：{error}"))?;
        if destination.exists() {
            fs::remove_file(&destination).map_err(|error| format!("无法更新扩展文件：{error}"))?;
        }
        fs::rename(&temporary, &destination)
            .map_err(|error| format!("无法启用扩展文件：{error}"))?;
        let written =
            fs::metadata(&destination).map_err(|error| format!("无法检查扩展文件：{error}"))?;
        if !written.is_file() || written.len() != content.len() as u64 {
            return Err(format!("扩展文件释放不完整：{}", destination.display()));
        }
    }
    let directory = prepare_directory_for_open(extension_dir, "浏览器扩展")?;
    let manifest = directory.join("manifest.json");
    if !manifest.is_file() {
        return Err("浏览器扩展文件不完整，请重试。".into());
    }
    Ok(directory)
}

#[tauri::command]
fn open_extension_directory(state: State<'_, AppState>) -> Result<String, String> {
    let directory = prepare_directory_for_open(&state.extension_dir, "浏览器扩展")?;
    if !directory.join("manifest.json").is_file() {
        return Err("随软件安装的浏览器扩展文件不完整，请重新安装 ClipCargo。".into());
    }
    register_extension_bridge(&state)?;
    Command::new("explorer.exe")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开扩展目录：{error}"))?;
    Ok(directory.to_string_lossy().to_string())
}

fn normalize_extension_id(extension_id: &str) -> Result<String, String> {
    let extension_id = extension_id.trim().to_ascii_lowercase();
    if extension_id.len() != 32
        || !extension_id
            .bytes()
            .all(|byte| (b'a'..=b'p').contains(&byte))
    {
        return Err("扩展 ID 应为 32 位小写字母（a–p），请从浏览器扩展页复制。".into());
    }
    Ok(extension_id)
}

fn register_extension_bridge(state: &AppState) -> Result<(), String> {
    let extension_ids = TRUSTED_EXTENSION_IDS
        .iter()
        .map(|extension_id| normalize_extension_id(extension_id))
        .collect::<Result<Vec<_>, _>>()?;
    let current_exe =
        std::env::current_exe().map_err(|error| format!("无法确定程序位置：{error}"))?;
    let host_exe = current_exe.with_file_name("clipcargo-native-host.exe");
    if !host_exe.is_file() {
        return Err("本地桥接程序未安装，当前构建不能连接浏览器扩展。".into());
    }
    let app_data = state
        .components_dir
        .parent()
        .ok_or("无法确定应用数据目录。")?;
    let manifest_dir = app_data.join("native-messaging");
    fs::create_dir_all(&manifest_dir).map_err(|error| format!("无法创建桥接配置目录：{error}"))?;
    let manifest_path = manifest_dir.join("net.clipcargo.native.json");
    let manifest = serde_json::json!({
        "name": "net.clipcargo.native",
        "description": "ClipCargo browser bridge",
        "path": host_exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": extension_ids
            .iter()
            .map(|extension_id| format!("chrome-extension://{extension_id}/"))
            .collect::<Vec<_>>(),
    });
    let temporary = manifest_path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("无法生成桥接配置：{error}"))?,
    )
    .map_err(|error| format!("无法写入桥接配置：{error}"))?;
    if manifest_path.exists() {
        fs::remove_file(&manifest_path).map_err(|error| format!("无法更新桥接配置：{error}"))?;
    }
    fs::rename(&temporary, &manifest_path).map_err(|error| format!("无法启用桥接配置：{error}"))?;
    for key in [
        r"HKCU\Software\Google\Chrome\NativeMessagingHosts\net.clipcargo.native",
        r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\net.clipcargo.native",
    ] {
        let result = Command::new("reg.exe")
            .args(["ADD", key, "/ve", "/t", "REG_SZ", "/d"])
            .arg(&manifest_path)
            .arg("/f")
            .output()
            .map_err(|error| format!("无法登记浏览器桥接：{error}"))?;
        if !result.status.success() {
            return Err(format!(
                "登记浏览器桥接失败（{}）。",
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
    }
    Ok(())
}

fn registry_value(key: &str, name: Option<&str>) -> Option<String> {
    let mut command = Command::new("reg.exe");
    command.args(["query", key]);
    if let Some(name) = name {
        command.args(["/v", name]);
    } else {
        command.arg("/ve");
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().find_map(|line| {
        ["REG_EXPAND_SZ", "REG_SZ"].iter().find_map(|marker| {
            line.find(marker)
                .map(|index| line[index + marker.len()..].trim().to_string())
                .filter(|value| !value.is_empty())
        })
    })
}

fn executable_from_registry_value(value: &str) -> Option<PathBuf> {
    let lower = value.to_ascii_lowercase();
    let end = lower.find(".exe")? + 4;
    let raw = value[..end].trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

fn discover_video_editors() -> Vec<EditorInfo> {
    let mut candidates = Vec::new();
    for key in [
        r"HKCU\Software\Classes\JianyingPro.Media\shell\open\command",
        r"HKLM\Software\Classes\JianyingPro.Media\shell\open\command",
    ] {
        if let Some(path) =
            registry_value(key, None).and_then(|value| executable_from_registry_value(&value))
        {
            candidates.push(path);
        }
    }
    for key in [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\JianyingPro",
        r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\JianyingPro",
        r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\JianyingPro",
    ] {
        for value_name in ["DisplayIcon", "UninstallString"] {
            let Some(installer) = registry_value(key, Some(value_name))
                .and_then(|value| executable_from_registry_value(&value))
            else {
                continue;
            };
            if installer
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("JianyingPro.exe"))
            {
                candidates.push(installer);
            } else if let Some(parent) = installer.parent() {
                candidates.push(parent.join("JianyingPro.exe"));
            }
        }
    }
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|path| path.canonicalize().ok())
        .filter(|path| path.is_file() && seen.insert(path.to_string_lossy().to_ascii_lowercase()))
        .map(|path| EditorInfo {
            id: "jianying-pro".into(),
            name: "剪映专业版".into(),
            // Jianying Pro 11.5.3 accepts the process launch but ignores the
            // historical `-open-file=` handoff. Keep discovery separate from
            // capability so the UI never advertises an unverified import.
            verified: false,
            executable: path.to_string_lossy().to_string(),
        })
        .take(1)
        .collect()
}

fn editor_import_argument(path: &PathBuf) -> String {
    format!("-open-file={}", path.to_string_lossy())
}

fn launch_editor_import(
    editor: &EditorInfo,
    paths: &[PathBuf],
) -> Result<EditorImportResult, String> {
    if !editor.verified {
        return Err("当前剪映版本尚未通过素材导入验证，已停用该入口以避免误报成功。".into());
    }
    if paths.is_empty() {
        return Err("没有可导入剪映的本地素材。".into());
    }
    if paths.len() > 100 {
        return Err("单次最多向剪映导入 100 个素材，请分批处理。".into());
    }
    let executable = PathBuf::from(&editor.executable)
        .canonicalize()
        .map_err(|_| "剪映安装位置已经失效，请重新安装或启动剪映后重试。".to_string())?;
    if !executable.is_file()
        || executable
            .file_name()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("JianyingPro.exe"))
    {
        return Err("检测到的剪映程序无效。".into());
    }
    for path in paths {
        Command::new(&executable)
            .arg(editor_import_argument(path))
            .spawn()
            .map_err(|error| format!("无法将素材交给剪映：{error}"))?;
    }
    Ok(EditorImportResult {
        editor_name: editor.name.clone(),
        imported_count: paths.len(),
    })
}

#[tauri::command]
fn list_video_editors() -> Vec<EditorInfo> {
    discover_video_editors()
}

#[tauri::command]
fn import_media_to_editor(
    editor_id: String,
    asset_type: String,
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<EditorImportResult, String> {
    let editor = discover_video_editors()
        .into_iter()
        .find(|editor| editor.id == editor_id)
        .ok_or("没有检测到可用的剪映专业版。")?;
    let downloads_dir = current_downloads_dir(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let path = asset_path(&connection, &downloads_dir, &asset_type, asset_id)?;
    launch_editor_import(&editor, &[path])
}

#[tauri::command]
fn import_asset_package_to_editor(
    editor_id: String,
    job_id: i64,
    state: State<'_, AppState>,
) -> Result<EditorImportResult, String> {
    let editor = discover_video_editors()
        .into_iter()
        .find(|editor| editor.id == editor_id)
        .ok_or("没有检测到可用的剪映专业版。")?;
    let downloads_dir = current_downloads_dir(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let original = validated_media_path(&connection, &downloads_dir, job_id)?;
    let mut paths = vec![original.clone()];
    let mut statement = connection
        .prepare("SELECT id FROM media_derivatives WHERE parent_job_id=?1 AND status='completed' AND library_hidden=0 AND kind!='source' AND file_path IS NOT NULL")
        .map_err(|error| format!("读取项目素材失败：{error}"))?;
    let derivatives = statement
        .query_map(params![job_id], |row| row.get::<_, i64>(0))
        .map_err(|error| format!("读取项目素材失败：{error}"))?;
    for derivative_id in derivatives.flatten() {
        if let Ok(path) = validated_derivative_path(&connection, &downloads_dir, derivative_id) {
            paths.push(path);
        }
    }
    if let Some(cover) = cover_sidecar_path(&original) {
        paths.push(cover);
    }
    if let Ok(subtitles) = discover_sidecar_subtitles(&original) {
        paths.extend(
            subtitles
                .into_iter()
                .map(|subtitle| PathBuf::from(subtitle.path)),
        );
    }
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.to_string_lossy().to_ascii_lowercase()));
    launch_editor_import(&editor, &paths)
}

#[tauri::command]
fn open_asset_package(job_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let media_path = validated_media_path(&connection, &downloads_dir, job_id)?;
    let directory = asset_root_for_media(&media_path);
    if !directory.is_dir() {
        return Err("素材项目文件夹已经移动或不存在。".into());
    }
    Command::new("explorer.exe")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开素材项目文件夹：{error}"))?;
    Ok(())
}

#[tauri::command]
fn get_media_path(
    asset_type: String,
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let file_path = asset_path(&connection, &downloads_dir, &asset_type, asset_id)?;
    Ok(file_path.to_string_lossy().to_string())
}

fn remove_media_from_library_record(
    connection: &Connection,
    asset_type: &str,
    asset_id: i64,
) -> Result<(), String> {
    let changed = match asset_type {
        "original" => connection.execute(
            "UPDATE download_jobs SET library_hidden=1 WHERE id=?1 AND status='completed'",
            params![asset_id],
        ),
        "derivative" => connection.execute(
            "UPDATE media_derivatives SET library_hidden=1 WHERE id=?1 AND status='completed'",
            params![asset_id],
        ),
        _ => return Err("未知的素材类型。".into()),
    }
    .map_err(|error| format!("移出素材库失败：{error}"))?;
    if changed == 0 {
        return Err("找不到可移出的已完成素材。".into());
    }
    Ok(())
}

#[tauri::command]
fn remove_media_from_library(
    asset_type: String,
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    remove_media_from_library_record(&connection, &asset_type, asset_id)
}

#[tauri::command]
fn media_removal_impact(
    asset_type: String,
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<MediaRemovalImpact, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    let (raw_path, managed_file): (String, bool) = match asset_type.as_str() {
        "original" => connection.query_row(
            "SELECT file_path,managed_file FROM download_jobs WHERE id=?1 AND status='completed' AND file_path IS NOT NULL",
            params![asset_id], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        ),
        "derivative" => connection.query_row(
            "SELECT file_path,1 FROM media_derivatives WHERE id=?1 AND status='completed' AND file_path IS NOT NULL",
            params![asset_id], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        ),
        _ => return Err("未知的素材类型。".into()),
    }.map_err(|_| "找不到可移除的已完成素材。".to_string())?;
    let path = PathBuf::from(&raw_path);
    let reference_count = connection.query_row(
        "SELECT (SELECT COUNT(*) FROM download_jobs WHERE file_path=?1) + (SELECT COUNT(*) FROM media_derivatives WHERE file_path=?1)",
        params![raw_path], |row| row.get(0),
    ).map_err(|error| format!("检查文件引用失败：{error}"))?;
    Ok(MediaRemovalImpact {
        file_path: raw_path,
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("未命名文件")
            .to_string(),
        size_bytes: path
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len()),
        reference_count,
        managed_file,
    })
}

#[cfg(target_os = "windows")]
fn move_file_to_recycle_bin(path: &PathBuf) -> Result<(), String> {
    let script = "Add-Type -AssemblyName Microsoft.VisualBasic; $target=[Environment]::GetEnvironmentVariable('CLIPCARGO_TRASH_TARGET'); [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    let result = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CLIPCARGO_TRASH_TARGET", path)
        .output()
        .map_err(|error| format!("无法调用 Windows 回收站：{error}"))?;
    if result.status.success() && !path.exists() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&result.stderr).trim().to_string();
    Err(if detail.is_empty() {
        "文件未能移入回收站。".into()
    } else {
        format!("文件未能移入回收站：{detail}")
    })
}

#[cfg(not(target_os = "windows"))]
fn move_file_to_recycle_bin(_path: &PathBuf) -> Result<(), String> {
    Err("当前系统暂不支持移到回收站。".into())
}

#[tauri::command]
fn trash_media(
    asset_type: String,
    asset_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    if asset_type == "original" {
        let managed: bool = connection
            .query_row(
                "SELECT managed_file FROM download_jobs WHERE id=?1 AND status='completed'",
                params![asset_id],
                |row| row.get(0),
            )
            .map_err(|_| "找不到可删除的已完成素材。".to_string())?;
        if !managed {
            return Err(
                "该素材仅引用用户原文件；ClipCargo 不会将原文件移入回收站，请使用“仅移出库”。"
                    .into(),
            );
        }
    }
    let file_path = asset_path(&connection, &downloads_dir, &asset_type, asset_id)?;
    move_file_to_recycle_bin(&file_path)?;
    remove_media_from_library_record(&connection, &asset_type, asset_id)
        .map_err(|error| format!("文件已移到回收站，但更新素材库失败：{error}"))
}

fn update_media_details_record(
    connection: &Connection,
    asset_type: &str,
    asset_id: i64,
    title: &str,
    project_name: &str,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 512 {
        return Err("素材名称需为 1–512 个字符。".into());
    }
    let project_name = project_name.trim();
    if project_name.is_empty() || project_name.chars().count() > 50 {
        return Err("项目名称需为 1–50 个字符。".into());
    }
    let project_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE name=?1)",
            params![project_name],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查项目失败：{error}"))?;
    if !project_exists {
        return Err("目标项目不存在，请先创建项目。".into());
    }
    let item_id: i64 = match asset_type {
        "original" => connection.query_row("SELECT item_id FROM download_jobs WHERE id=?1 AND status='completed'", params![asset_id], |row| row.get(0)),
        "derivative" => connection.query_row("SELECT j.item_id FROM media_derivatives d JOIN download_jobs j ON j.id=d.parent_job_id WHERE d.id=?1 AND d.status='completed'", params![asset_id], |row| row.get(0)),
        _ => return Err("未知的素材类型。".into()),
    }.map_err(|_| "找不到可编辑的已完成素材。".to_string())?;
    let changed = match asset_type {
        "original" => connection.execute(
            "UPDATE download_jobs SET display_title=?1, updated_at=?2 WHERE id=?3",
            params![title, unix_seconds(), asset_id],
        ),
        "derivative" => connection.execute(
            "UPDATE media_derivatives SET display_title=?1, updated_at=?2 WHERE id=?3",
            params![title, unix_seconds(), asset_id],
        ),
        _ => unreachable!(),
    }
    .map_err(|error| format!("保存素材名称失败：{error}"))?;
    if changed == 0 {
        return Err("素材已不存在。".into());
    }
    connection
        .execute(
            "UPDATE inbox_items SET project_name=?1 WHERE id=?2",
            params![project_name, item_id],
        )
        .map_err(|error| format!("移动素材项目失败：{error}"))?;
    Ok(())
}

#[tauri::command]
fn update_media_details(
    asset_type: String,
    asset_id: i64,
    title: String,
    project_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    update_media_details_record(&connection, &asset_type, asset_id, &title, &project_name)
}

#[cfg(test)]
fn execute_download(
    component: &PathBuf,
    page_url: &str,
    output_template: &str,
) -> Result<String, String> {
    let output = Command::new(component)
        .args([
            "--ignore-config",
            "--no-playlist",
            "--no-progress",
            "--windows-filenames",
            "--print",
            "after_move:filepath",
            "-f",
            "best[ext=mp4]/best",
            "-o",
            output_template,
            "--",
            page_url,
        ])
        .output()
        .map_err(|error| external_tool_start_error("下载引擎", &error))?;
    if !output.status.success() {
        return Err(resolver_error(&output.stderr));
    }
    let file_path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .to_string();
    let valid_file = PathBuf::from(&file_path)
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    valid_file
        .then_some(file_path)
        .ok_or_else(|| "下载器未返回有效文件。".into())
}

fn compatible_mp4_probe(raw: &[u8], extension: &str) -> Result<(bool, bool, bool), String> {
    let value: serde_json::Value =
        serde_json::from_slice(raw).map_err(|_| "媒体编码探测结果无法解析。".to_string())?;
    let streams = value
        .get("streams")
        .and_then(|item| item.as_array())
        .ok_or("媒体编码探测结果缺少轨道信息。")?;
    let video_codecs = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(|item| item.as_str()) == Some("video"))
        .filter_map(|stream| stream.get("codec_name").and_then(|item| item.as_str()))
        .collect::<Vec<_>>();
    let audio_codecs = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(|item| item.as_str()) == Some("audio"))
        .filter_map(|stream| stream.get("codec_name").and_then(|item| item.as_str()))
        .collect::<Vec<_>>();
    let has_video = !video_codecs.is_empty();
    let has_audio = !audio_codecs.is_empty();
    let compatible = extension.eq_ignore_ascii_case("mp4")
        && has_video
        && video_codecs.iter().all(|codec| *codec == "h264")
        && audio_codecs.iter().all(|codec| *codec == "aac");
    Ok((has_video, has_audio, compatible))
}

fn inspect_compatible_mp4(ffprobe: &PathBuf, path: &PathBuf) -> Result<(bool, bool, bool), String> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name",
            "-of",
            "json",
            "--",
        ])
        .arg(path)
        .output()
        .map_err(|error| external_tool_start_error("视频校验工具", &error))?;
    if !output.status.success() {
        return Err(format!(
            "MP4 编码检查失败：{}",
            resolver_error(&output.stderr)
        ));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    compatible_mp4_probe(&output.stdout, extension)
}

struct CompatibleMp4Result {
    final_path: PathBuf,
    retained_source_path: Option<PathBuf>,
}

fn make_compatible_mp4(
    ffmpeg: &PathBuf,
    input: &PathBuf,
    job_id: i64,
    retain_source: bool,
    control: &Arc<AtomicU8>,
) -> Result<CompatibleMp4Result, String> {
    let ffprobe = ffmpeg.with_file_name("ffprobe.exe");
    let (has_video, has_audio, compatible) = inspect_compatible_mp4(&ffprobe, input)?;
    if !has_video {
        return Err("来源没有可转换的视频轨。".into());
    }
    if compatible {
        return Ok(CompatibleMp4Result {
            final_path: input.clone(),
            retained_source_path: None,
        });
    }
    let parent = input.parent().ok_or("无法确定下载文件目录。")?;
    let input_bytes = input
        .metadata()
        .map_err(|error| format!("读取下载文件大小失败：{error}"))?
        .len();
    ensure_free_space(
        &parent.to_path_buf(),
        input_bytes
            .saturating_mul(2)
            .saturating_add(128 * 1_048_576),
        "转换兼容 MP4",
    )?;
    let temporary = parent.join(format!(".clipcargo-compatible-{job_id}.mp4"));
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(input)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "22",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ])
        .arg(&temporary)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| external_tool_start_error("兼容 MP4 转换工具", &error))?;
    let mut stderr_thread = child.stderr.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut stderr = Vec::new();
            let _ = pipe.read_to_end(&mut stderr);
            stderr
        })
    });
    loop {
        if control.load(Ordering::Acquire) != 0 {
            terminate_child_tree(&mut child);
            if let Some(handle) = stderr_thread.take() {
                let _ = handle.join();
            }
            let _ = fs::remove_file(&temporary);
            return Err("下载后的兼容 MP4 转换已停止。".into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => {
                let stderr = stderr_thread
                    .take()
                    .and_then(|handle| handle.join().ok())
                    .unwrap_or_default();
                let _ = fs::remove_file(&temporary);
                return Err(format!("兼容 MP4 转换失败：{}", resolver_error(&stderr)));
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                terminate_child_tree(&mut child);
                if let Some(handle) = stderr_thread.take() {
                    let _ = handle.join();
                }
                let _ = fs::remove_file(&temporary);
                return Err(format!("读取兼容 MP4 转换状态失败：{error}"));
            }
        }
    }
    if let Some(handle) = stderr_thread.take() {
        let _ = handle.join();
    }
    let validation = (|| -> Result<(), String> {
        validate_media_signature(&temporary, "mp4")?;
        validate_media_streams(&ffprobe, &temporary, true, has_audio)?;
        let (_, _, converted_compatible) = inspect_compatible_mp4(&ffprobe, &temporary)?;
        if !converted_compatible {
            return Err("转换结果不是 H.264/AAC MP4。".into());
        }
        Ok(())
    })();
    if let Err(error) = validation {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let final_path = input.with_extension("mp4");
    let mut retained_source_path = None;
    if &final_path == input {
        let backup = parent.join(format!(".clipcargo-source-{job_id}.bak"));
        fs::rename(input, &backup).map_err(|error| format!("暂存来源文件失败：{error}"))?;
        if let Err(error) = fs::rename(&temporary, &final_path) {
            let _ = fs::rename(&backup, input);
            return Err(format!("提交兼容 MP4 失败：{error}"));
        }
        if retain_source {
            let retained = parent.join(format!("source-{job_id}.original.mp4"));
            if retained.exists() {
                fs::remove_file(&retained)
                    .map_err(|error| format!("替换旧下载源文件失败：{error}"))?;
            }
            fs::rename(&backup, &retained)
                .map_err(|error| format!("保存下载源文件失败：{error}"))?;
            retained_source_path = Some(retained);
        } else {
            let _ = fs::remove_file(backup);
        }
    } else {
        fs::rename(&temporary, &final_path)
            .map_err(|error| format!("提交兼容 MP4 失败：{error}"))?;
        if retain_source {
            retained_source_path = Some(input.clone());
        } else {
            let _ = fs::remove_file(input);
        }
    }
    Ok(CompatibleMp4Result {
        final_path,
        retained_source_path,
    })
}

fn find_retained_audio_source(audio_path: &PathBuf) -> Result<Option<PathBuf>, String> {
    let parent = audio_path.parent().ok_or("无法确定音频输出目录。")?;
    let stem = audio_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("音频输出文件名无效。")?;
    let allowed = [
        "mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts", "mpg", "mpeg", "m4a",
        "aac", "opus", "ogg", "webm",
    ];
    let mut candidates = fs::read_dir(parent)
        .map_err(|error| format!("查找下载源文件失败：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path != audio_path && path.is_file())
        .filter(|path| path.file_stem().and_then(|value| value.to_str()) == Some(stem))
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .map(|value| {
                    allowed
                        .iter()
                        .any(|allowed| value.eq_ignore_ascii_case(allowed))
                })
                .unwrap_or(false)
        })
        .filter(|path| {
            path.metadata()
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    Ok(candidates.pop())
}

fn record_retained_source(
    connection: &Connection,
    job_id: i64,
    path: &PathBuf,
) -> Result<(), String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("读取下载源文件失败：{error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("下载源文件为空。".into());
    }
    let title: String = connection.query_row(
        "SELECT i.title FROM download_jobs j JOIN inbox_items i ON i.id=j.item_id WHERE j.id=?1",
        params![job_id],
        |row| row.get(0),
    ).map_err(|error| format!("读取下载源文件标题失败：{error}"))?;
    let now = unix_seconds();
    if let Some(id) = connection
        .query_row(
            "SELECT id FROM media_derivatives WHERE parent_job_id=?1 AND kind='source'",
            params![job_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("检查下载源文件记录失败：{error}"))?
    {
        connection.execute(
            "UPDATE media_derivatives SET title=?1,status='completed',file_path=?2,error_message=NULL,progress_percent=100,library_hidden=1,updated_at=?3 WHERE id=?4",
            params![format!("{title} · 下载源文件"), path.to_string_lossy(), now, id],
        ).map_err(|error| format!("更新下载源文件记录失败：{error}"))?;
    } else {
        connection.execute(
            "INSERT INTO media_derivatives(parent_job_id,title,kind,status,file_path,progress_percent,library_hidden,created_at,updated_at) VALUES(?1,?2,'source','completed',?3,100,1,?4,?4)",
            params![job_id, format!("{title} · 下载源文件"), path.to_string_lossy(), now],
        ).map_err(|error| format!("登记下载源文件失败：{error}"))?;
    }
    Ok(())
}

fn write_source_record(
    connection: &Connection,
    job_id: i64,
    media_path: &PathBuf,
) -> Result<PathBuf, String> {
    let (page_url, title, source_host, source_id, captured_at, quality, output_preset, save_subtitles, subtitle_languages_json, save_cover, retain_source, managed_file): (String, String, String, Option<String>, i64, String, String, i64, String, i64, i64, i64) = connection.query_row(
        "SELECT i.page_url,i.title,i.source_host,i.source_id,i.created_at,j.quality,j.output_preset,j.save_subtitles,j.subtitle_languages_json,j.save_cover,j.retain_source,j.managed_file FROM download_jobs j JOIN inbox_items i ON i.id=j.item_id WHERE j.id=?1",
        params![job_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?)),
    ).map_err(|error| format!("读取来源记录失败：{error}"))?;
    let record = SourceRecord {
        schema_version: 2,
        page_url,
        title,
        source_host,
        source_id,
        captured_at,
        downloaded_at: unix_seconds(),
        quality,
        output_preset,
        save_subtitles: save_subtitles != 0,
        subtitle_languages: serde_json::from_str(&subtitle_languages_json).unwrap_or_default(),
        save_cover: save_cover != 0,
        retain_source: retain_source != 0,
        managed_file: managed_file != 0,
        file_name: media_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
    };
    let bytes =
        serde_json::to_vec_pretty(&record).map_err(|error| format!("生成来源记录失败：{error}"))?;
    let destination = asset_root_for_media(media_path).join("metadata.json");
    let temporary = destination.with_extension("json.tmp");
    let backup = destination.with_extension("json.bak");
    fs::write(&temporary, bytes).map_err(|error| format!("写入来源记录失败：{error}"))?;
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    if destination.exists() {
        fs::rename(&destination, &backup)
            .map_err(|error| format!("暂存旧来源记录失败：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        if backup.exists() {
            let _ = fs::rename(&backup, &destination);
        }
        return Err(format!("提交来源记录失败：{error}"));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(destination)
}

#[derive(Debug)]
struct DownloadTaskResult {
    file_path: String,
    warning_message: Option<String>,
}

#[derive(Debug, PartialEq)]
struct DownloadProgress {
    percent: f64,
    downloaded_bytes: Option<i64>,
    total_bytes: Option<i64>,
    speed_bytes_per_second: Option<f64>,
    eta_seconds: Option<i64>,
}

fn parse_download_progress(value: &str) -> Option<DownloadProgress> {
    let fields = value
        .strip_prefix("download:")?
        .split('|')
        .collect::<Vec<_>>();
    if fields.len() != 5 {
        return None;
    }
    let number_i64 = |raw: &str| raw.trim().parse::<i64>().ok().filter(|value| *value >= 0);
    let number_f64 = |raw: &str| {
        raw.trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
    };
    Some(DownloadProgress {
        percent: fields[0]
            .trim()
            .trim_end_matches('%')
            .trim()
            .parse::<f64>()
            .ok()?
            .clamp(0.0, 100.0),
        downloaded_bytes: number_i64(fields[1]),
        total_bytes: number_i64(fields[2]),
        speed_bytes_per_second: number_f64(fields[3]),
        eta_seconds: number_i64(fields[4]),
    })
}

fn parse_download_output_path(value: &str) -> Option<String> {
    value
        .strip_prefix("clipcargo-file:")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn existing_download_output(
    output_template: &str,
    source_id: Option<&str>,
    download_started_at: SystemTime,
) -> Option<PathBuf> {
    let directory = PathBuf::from(output_template).parent()?.to_path_buf();
    let source_marker = source_id
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 256
                && !value.contains('/')
                && !value.contains('\\')
                && !value.contains('[')
                && !value.contains(']')
        })
        .map(|value| format!("[{value}]"));
    let media_extensions = [
        "mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts", "mpg", "mpeg", "mp3",
        "m4a", "aac", "opus", "ogg", "wav", "flac",
    ];
    let mut candidates = fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .map(|extension| {
                    media_extensions
                        .iter()
                        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
                })
                .unwrap_or(false)
        })
        .filter(|path| {
            path.metadata()
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        })
        .filter(|path| {
            source_marker.as_ref().is_some_and(|marker| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.contains(marker))
                    .unwrap_or(false)
            }) || path
                .metadata()
                .and_then(|metadata| metadata.modified())
                .map(|modified| {
                    modified
                        .checked_add(Duration::from_secs(2))
                        .is_some_and(|value| value >= download_started_at)
                })
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    candidates.pop()
}

fn cover_sidecar_path(media_path: &PathBuf) -> Option<PathBuf> {
    let parent = media_path.parent()?;
    let Some(stem) = media_path.file_stem().and_then(|value| value.to_str()) else {
        return None;
    };
    let extensions = ["jpg", "jpeg", "png", "webp", "avif"];
    let mut directories = vec![parent.to_path_buf()];
    let organized = asset_root_for_media(media_path).join("images");
    if organized != parent {
        directories.push(organized);
    }
    directories.into_iter().find_map(|directory| {
        fs::read_dir(directory)
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.is_file()
                    && path.file_stem().and_then(|value| value.to_str()) == Some(stem)
                    && path
                        .extension()
                        .and_then(|value| value.to_str())
                        .map(|value| {
                            extensions
                                .iter()
                                .any(|extension| value.eq_ignore_ascii_case(extension))
                        })
                        .unwrap_or(false)
            })
    })
}

fn cover_data_url(path: &PathBuf) -> Option<String> {
    const MAX_COVER_BYTES: u64 = 2 * 1024 * 1024;
    let metadata = path.metadata().ok()?;
    if metadata.len() == 0 || metadata.len() > MAX_COVER_BYTES {
        return None;
    }
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => return None,
    };
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:{mime};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

fn has_cover_sidecar(media_path: &PathBuf) -> bool {
    cover_sidecar_path(media_path).is_some()
}

fn move_file_into_directory(
    source: &PathBuf,
    destination_directory: &PathBuf,
) -> Result<PathBuf, String> {
    fs::create_dir_all(destination_directory)
        .map_err(|error| format!("创建素材分类目录失败：{error}"))?;
    let file_name = source.file_name().ok_or("素材附件文件名无效。")?;
    let destination = destination_directory.join(file_name);
    if destination == *source {
        return Ok(destination);
    }
    if destination.exists() {
        fs::remove_file(&destination).map_err(|error| format!("替换已有素材附件失败：{error}"))?;
    }
    if fs::rename(source, &destination).is_err() {
        fs::copy(source, &destination).map_err(|error| format!("归档素材附件失败：{error}"))?;
        fs::remove_file(source).map_err(|error| format!("清理素材附件原文件失败：{error}"))?;
    }
    Ok(destination)
}

fn archive_download_sidecars(media_path: &PathBuf, asset_root: &PathBuf) -> Result<(), String> {
    let media_directory = media_path.parent().ok_or("素材路径缺少父目录。")?;
    let media_stem = media_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("素材文件名无效。")?;
    let subtitle_prefix = format!("{media_stem}.");
    let entries = fs::read_dir(media_directory)
        .map_err(|error| format!("读取下载附件失败：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path != media_path)
        .collect::<Vec<_>>();
    for path in entries {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp" | "avif")
            && stem == media_stem
        {
            move_file_into_directory(&path, &asset_root.join("images"))?;
        } else if matches!(extension.as_str(), "vtt" | "srt") && stem.starts_with(&subtitle_prefix)
        {
            move_file_into_directory(&path, &asset_root.join("subtitles"))?;
        }
    }
    Ok(())
}

fn execute_download_task(
    component: PathBuf,
    page_url: String,
    output_template: String,
    asset_root: PathBuf,
    db_path: PathBuf,
    job_id: i64,
    format_selector: String,
    audio_only: bool,
    source_format: bool,
    save_subtitles: bool,
    subtitle_languages: Vec<String>,
    save_cover: bool,
    save_source_record: bool,
    retain_source: bool,
    control: Arc<AtomicU8>,
    source_browser: Option<String>,
    source_id: Option<String>,
) -> Result<DownloadTaskResult, String> {
    let download_started_at = SystemTime::now();
    let ffmpeg_location = component
        .parent()
        .ok_or("无法确定视频处理工具目录。")?
        .to_path_buf();
    let mut command = Command::new(&component);
    command.args([
        "--ignore-config", "--no-playlist", "--newline", "--progress", "--encoding", "utf-8", "--windows-filenames", "--continue", "--part",
        "--retries", "3", "--fragment-retries", "3", "--retry-sleep", "exp=1:5",
        "--extractor-retries", "3", "--file-access-retries", "3", "--socket-timeout", "20",
        "--concurrent-fragments", "2",
        "--progress-template", "download:download:%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
        "--print", "after_move:clipcargo-file:%(filepath)s", "--ffmpeg-location",
    ]).arg(&ffmpeg_location);
    command.args(["--impersonate", "chrome", "--referer", &page_url]);
    if page_url.contains("youtube.com/") || page_url.contains("youtu.be/") {
        command.args(["--extractor-args", "youtube:player_client=default,android"]);
    }
    if audio_only {
        command.args(["-x", "--audio-format", "mp3", "--audio-quality", "2"]);
        if retain_source {
            command.arg("--keep-video");
        }
    } else if !source_format {
        command.args(["--merge-output-format", "mp4"]);
    }
    command.args(["-f", &format_selector, "-o", &output_template]);
    if save_subtitles {
        command
            .args(["--write-subs", "--write-auto-subs", "--sub-langs"])
            .arg(subtitle_languages.join(","))
            .args(["--sub-format", "vtt/best"]);
    }
    if save_cover {
        command.arg("--write-thumbnail");
    }
    let deno = ffmpeg_location.join("deno.exe");
    if deno.is_file() {
        command
            .arg("--js-runtimes")
            .arg(format!("deno:{}", deno.to_string_lossy()));
    }
    if let Some(browser) = source_browser.as_ref() {
        command.arg("--cookies-from-browser").arg(browser);
    }
    let mut child = command
        .args(["--", &page_url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| external_tool_start_error("下载引擎", &error))?;

    let stdout = child.stdout.take().ok_or("无法读取下载进度。")?;
    let stderr = child.stderr.take().ok_or("无法读取下载错误。")?;
    let (line_sender, line_receiver) = mpsc::channel();
    let stdout_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = line_sender.send(line);
        }
    });
    let stderr_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let connection =
        Connection::open(db_path).map_err(|error| format!("打开任务数据库失败：{error}"))?;
    let mut final_path = String::new();
    let status = loop {
        for line in line_receiver.try_iter() {
            let value = line.trim();
            if let Some(progress) = parse_download_progress(value) {
                let _ = connection.execute(
                    "UPDATE download_jobs SET stage='downloading',progress_percent=?1,downloaded_bytes=?2,total_bytes=?3,speed_bytes_per_second=?4,eta_seconds=?5,updated_at=?6 WHERE id=?7",
                    params![progress.percent, progress.downloaded_bytes, progress.total_bytes, progress.speed_bytes_per_second, progress.eta_seconds, unix_seconds(), job_id],
                );
            } else if let Some(path) = parse_download_output_path(value) {
                final_path = path;
            }
        }
        let requested_action = control.load(Ordering::Acquire);
        if requested_action != 0 {
            terminate_child_tree(&mut child);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return if requested_action == 2 {
                Err("下载已暂停；已保留可用断点。".into())
            } else {
                Err("下载已停止；已保留可用断点。来源支持续传时可重新开始，否则会重新下载。".into())
            };
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                terminate_child_tree(&mut child);
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(format!("读取下载进程状态失败：{error}"));
            }
        }
    };
    let _ = stdout_thread.join();
    for line in line_receiver.try_iter() {
        let value = line.trim();
        if let Some(path) = parse_download_output_path(value) {
            final_path = path;
        }
    }
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(resolver_error(&stderr));
    }
    let _ = connection.execute("UPDATE download_jobs SET stage='verifying',speed_bytes_per_second=NULL,eta_seconds=NULL,updated_at=?1 WHERE id=?2", params![unix_seconds(), job_id]);
    // yt-dlp writes filenames using the selected console encoding. On Windows a
    // non-UTF-8 parent process can still yield a mojibake `--print` path even
    // when the actual file was created with the correct Unicode name. Treat an
    // unusable printed path exactly like a missing one and recover the file from
    // the output directory instead of reporting a false download failure.
    let printed_path = PathBuf::from(&final_path);
    let printed_path_is_valid = !final_path.is_empty()
        && printed_path
            .metadata()
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false);
    let mut downloaded_path = if printed_path_is_valid {
        printed_path
    } else {
        existing_download_output(&output_template, source_id.as_deref(), download_started_at)
            .unwrap_or_default()
    };
    let valid_file = downloaded_path
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if !valid_file {
        return Err("下载器已结束，但下载目录中没有找到对应的媒体文件。".into());
    }
    let extension = downloaded_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    validate_media_signature(&downloaded_path, &extension)?;
    let mut retained_source_path = if audio_only && retain_source {
        find_retained_audio_source(&downloaded_path)?
    } else {
        None
    };
    if !audio_only && !source_format {
        let _ = connection.execute(
            "UPDATE download_jobs SET stage='processing',updated_at=?1 WHERE id=?2",
            params![unix_seconds(), job_id],
        );
        let conversion = make_compatible_mp4(
            &ffmpeg_location.join("ffmpeg.exe"),
            &downloaded_path,
            job_id,
            retain_source,
            &control,
        )?;
        downloaded_path = conversion.final_path;
        retained_source_path = conversion.retained_source_path;
    }
    validate_media_streams(
        &ffmpeg_location.join("ffprobe.exe"),
        &downloaded_path,
        !audio_only,
        audio_only,
    )?;
    archive_download_sidecars(&downloaded_path, &asset_root)?;
    let _ = connection.execute(
        "UPDATE download_jobs SET stage='archiving',updated_at=?1 WHERE id=?2",
        params![unix_seconds(), job_id],
    );
    if let Some(path) = retained_source_path.as_ref() {
        record_retained_source(&connection, job_id, path)?;
    }
    if save_source_record {
        write_source_record(&connection, job_id, &downloaded_path)?;
    }
    let mut warnings = Vec::new();
    if save_subtitles
        && discover_sidecar_subtitles(&downloaded_path)
            .map(|tracks| tracks.is_empty())
            .unwrap_or(true)
    {
        warnings.push("来源没有可保存的所选字幕，主文件已正常下载。".to_string());
    }
    if save_cover && !has_cover_sidecar(&downloaded_path) {
        warnings.push("来源没有提供封面，主文件已正常下载。".to_string());
    }
    Ok(DownloadTaskResult {
        file_path: downloaded_path.to_string_lossy().to_string(),
        warning_message: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join(" "))
        },
    })
}

fn requested_quality_height(quality: &str) -> Result<Option<u16>, String> {
    if quality == "best" {
        return Ok(None);
    }
    let height = quality
        .parse::<u16>()
        .map_err(|_| "未知的下载清晰度。".to_string())?;
    if !(144..=4320).contains(&height) {
        return Err("下载清晰度超出支持范围。".into());
    }
    Ok(Some(height))
}

fn format_selector_for_quality(quality: &str) -> Result<String, String> {
    match requested_quality_height(quality)? {
        // Do not require an MP4/M4A source. A large number of sites only expose
        // WebM/Opus, MPEG-TS or another split-stream combination. yt-dlp first
        // obtains the best tracks that actually exist; the compatibility pass
        // below then produces the requested H.264/AAC MP4 when necessary.
        None => Ok("bv*+ba/b/best".into()),
        Some(height) => Ok(format!(
            "bv*[height<={height}]+ba/b[height<={height}]/best[height<={height}]"
        )),
    }
}

fn source_format_selector_for_quality(quality: &str) -> Result<String, String> {
    match requested_quality_height(quality)? {
        None => Ok("bv*+ba/b".into()),
        Some(height) => Ok(format!(
            "bv*[height<={height}]+ba/b[height<={height}]/best[height<={height}]/best"
        )),
    }
}

fn exact_format_selector(format_id: &str) -> Result<String, String> {
    if format_id.is_empty()
        || format_id.len() > 64
        || !format_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("解析器返回的下载格式无效，请重新识别页面。".into());
    }
    Ok(format!("{format_id}+ba/{format_id}/b"))
}

fn validate_download_capabilities(
    output_preset: &str,
    has_video: Option<bool>,
    has_audio: Option<bool>,
) -> Result<(), String> {
    if matches!(output_preset, "audio" | "package") && has_audio == Some(false) {
        return Err("来源没有可下载的音轨，不能创建音频任务。".into());
    }
    if output_preset != "audio" && has_video == Some(false) {
        return Err("来源没有可下载的视频轨，不能创建视频任务。".into());
    }
    Ok(())
}

fn queue_package_audio(
    db_path: PathBuf,
    downloads_dir: PathBuf,
    ffmpeg: PathBuf,
    parent_job_id: i64,
    source: PathBuf,
    active_processing: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
    queued_processing: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
) -> Result<i64, String> {
    let connection =
        Connection::open(&db_path).map_err(|error| format!("打开素材包任务数据库失败：{error}"))?;
    if let Some(existing_id) = connection
        .query_row(
            "SELECT id FROM media_derivatives WHERE parent_job_id=?1 AND kind='audio' AND status IN ('queued','processing','completed') ORDER BY id DESC LIMIT 1",
            params![parent_job_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("检查素材包 MP3 失败：{error}"))?
    {
        return Ok(existing_id);
    }
    let (title, duration): (String, Option<i64>) = connection
        .query_row(
            "SELECT i.title,i.duration_seconds FROM download_jobs j JOIN inbox_items i ON i.id=j.item_id WHERE j.id=?1",
            params![parent_job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "找不到素材包的原始视频。".to_string())?;
    let (_, has_audio, _) = inspect_compatible_mp4(&ffmpeg.with_file_name("ffprobe.exe"), &source)?;
    if !has_audio {
        return Err("下载结果没有音轨，无法生成素材包 MP3。".into());
    }
    let source_bytes = source
        .metadata()
        .map_err(|error| format!("读取素材包视频大小失败：{error}"))?
        .len();
    ensure_free_space(
        &downloads_dir,
        source_bytes.saturating_add(64 * 1_048_576),
        "生成素材包 MP3",
    )?;
    let now = unix_seconds();
    connection.execute(
        "INSERT INTO media_derivatives(parent_job_id,title,kind,status,progress_percent,created_at,updated_at) VALUES(?1,?2,'audio','queued',0,?3,?3)",
        params![parent_job_id, title, now],
    ).map_err(|error| format!("创建素材包 MP3 任务失败：{error}"))?;
    let derivative_id = connection.last_insert_rowid();
    drop(connection);
    let audio_directory = asset_type_directory(&source, "audio");
    fs::create_dir_all(&audio_directory)
        .map_err(|error| format!("创建素材包音频目录失败：{error}"))?;
    let output = audio_directory.join(format!("derived-{derivative_id}-audio.mp3"));
    let cancelled = Arc::new(AtomicBool::new(false));
    queued_processing
        .lock()
        .map_err(|_| "处理队列不可用。".to_string())?
        .insert(derivative_id, cancelled.clone());
    thread::spawn(move || {
        loop {
            if cancelled.load(Ordering::Acquire) {
                if let Ok(mut queued) = queued_processing.lock() {
                    queued.remove(&derivative_id);
                }
                if let Ok(connection) = Connection::open(&db_path) {
                    let _ = connection.execute("UPDATE media_derivatives SET status='failed',error_message='素材包 MP3 已取消。',error_code='CANCELLED_BY_USER',updated_at=?1 WHERE id=?2", params![unix_seconds(), derivative_id]);
                }
                return;
            }
            let claimed = if let Ok(mut active) = active_processing.lock() {
                if let Ok(mut queued) = queued_processing.lock() {
                    try_claim_queued_task(&mut active, &mut queued, derivative_id, 1)
                } else {
                    false
                }
            } else {
                false
            };
            if claimed {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if let Ok(connection) = Connection::open(&db_path) {
            let _ = connection.execute(
                "UPDATE media_derivatives SET status='processing',updated_at=?1 WHERE id=?2",
                params![unix_seconds(), derivative_id],
            );
        }
        let result = execute_processing_cancellable(
            &ffmpeg,
            &source,
            &output,
            "audio",
            None,
            None,
            None,
            None,
            None,
            duration.map(|value| value as f64),
            db_path.clone(),
            derivative_id,
            cancelled,
        );
        if let Ok(connection) = Connection::open(&db_path) {
            let now = unix_seconds();
            match result {
                Ok(()) => {
                    let _ = connection.execute("UPDATE media_derivatives SET status='completed',file_path=?1,error_message=NULL,error_code=NULL,progress_percent=100,updated_at=?2 WHERE id=?3", params![output.to_string_lossy(), now, derivative_id]);
                }
                Err(message) => {
                    let code = task_error_code(&message, true);
                    let _ = connection.execute("UPDATE media_derivatives SET status='failed',error_message=?1,error_code=?2,updated_at=?3 WHERE id=?4", params![message, code, now, derivative_id]);
                    let _ = connection.execute("UPDATE download_jobs SET warning_message=trim(COALESCE(warning_message,'') || ' 素材包中的 MP3 生成失败，可在素材库中重试。'),updated_at=?1 WHERE id=?2", params![now, parent_job_id]);
                }
            }
        }
        if let Ok(mut active) = active_processing.lock() {
            active.remove(&derivative_id);
        }
    });
    Ok(derivative_id)
}

#[tauri::command]
async fn download_inbox_item(
    id: i64,
    quality: Option<String>,
    output_preset: Option<String>,
    save_subtitles: Option<bool>,
    subtitle_languages: Option<Vec<String>>,
    save_cover: Option<bool>,
    save_source_record: Option<bool>,
    retain_source: Option<bool>,
    concurrency_limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<DownloadJob, String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let component = state.components_dir.join("yt-dlp.exe");
    if !component.is_file() {
        return Err("请先在“设置”安装下载引擎。".into());
    }
    if !state.components_dir.join("ffmpeg.exe").is_file()
        || !state.components_dir.join("ffprobe.exe").is_file()
    {
        return Err("下载、合并和完整性校验需要视频处理工具，请先在“设置”安装或修复。".into());
    }
    fs::create_dir_all(&downloads_dir).map_err(|error| format!("创建下载目录失败：{error}"))?;
    ensure_free_space(&downloads_dir, 256 * 1_048_576, "开始下载")?;
    let quality = quality.unwrap_or_else(|| "1080".into());
    let output_preset = output_preset.unwrap_or_else(|| "video".into());
    let package_mode = output_preset == "package";
    let (audio_only, source_format) = match output_preset.as_str() {
        "package" => (false, false),
        "source" => (false, true),
        "video" => (false, false),
        "audio" => (true, false),
        _ => return Err("未知的下载输出预设。".into()),
    };
    let stored_quality = if audio_only {
        "audio".to_string()
    } else {
        quality.clone()
    };
    let save_subtitles = package_mode || save_subtitles.unwrap_or(false);
    let subtitle_languages =
        subtitle_languages.unwrap_or_else(|| vec!["zh.*".into(), "en.*".into()]);
    if save_subtitles
        && (subtitle_languages.is_empty()
            || subtitle_languages.len() > 20
            || subtitle_languages.iter().any(|language| {
                language.is_empty()
                    || language.len() > 32
                    || !language.chars().all(|value| {
                        value.is_alphanumeric() || matches!(value, '-' | '_' | '.' | '*')
                    })
            }))
    {
        return Err("字幕语言选择无效，请重新选择可用轨道。".into());
    }
    let save_cover = package_mode || save_cover.unwrap_or(false);
    let save_source_record = package_mode || save_source_record.unwrap_or(true);
    let retain_source = retain_source.unwrap_or(true);
    let subtitle_languages_json = serde_json::to_string(&subtitle_languages)
        .map_err(|error| format!("保存字幕参数失败：{error}"))?;
    let concurrency_limit = concurrency_limit.unwrap_or(2);
    if !(1..=4).contains(&concurrency_limit) {
        return Err("下载并发必须在 1 到 4 之间。".into());
    }
    let control = Arc::new(AtomicU8::new(0));
    let active = state
        .active_downloads
        .lock()
        .map_err(|_| "任务状态不可用。".to_string())?;
    let mut queued = state
        .queued_downloads
        .lock()
        .map_err(|_| "排队状态不可用。".to_string())?;
    let (page_url, job_id, _auth_required, source_id, source_title, quality_format_ids) = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        let (page_url, item_status, has_video, has_audio, auth_required, source_id, source_title, quality_format_ids) = connection
            .query_row(
                "SELECT page_url,status,has_video,has_audio,auth_required,source_id,title,quality_format_ids_json FROM inbox_items WHERE id=?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?.map(|value| value != 0),
                        row.get::<_, Option<i64>>(3)?.map(|value| value != 0),
                        row.get::<_, i64>(4)? != 0,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .map_err(|_| "找不到该收集箱条目。".to_string())?;
        if item_status != "ready" {
            return Err("请先成功识别页面，再开始下载。".into());
        }
        validate_download_capabilities(&output_preset, has_video, has_audio)?;
        validate_network_destination(&page_url)?;
        if let Some(existing_job_id) = connection
            .query_row(
                "SELECT id FROM download_jobs WHERE item_id=?1",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("检查下载任务失败：{error}"))?
        {
            if active.contains_key(&existing_job_id) || queued.contains_key(&existing_job_id) {
                return Err("该下载任务已经在运行或排队。".into());
            }
        }
        let now = unix_seconds();
        connection.execute(
            "INSERT INTO download_jobs (item_id, status, stage, file_path, error_message, progress_percent, quality, output_preset, save_subtitles, subtitle_languages_json, save_cover, save_source_record, retain_source, created_at, updated_at)
             VALUES (?1, 'queued', 'queued', NULL, NULL, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(item_id) DO UPDATE SET status='queued', stage='queued', file_path=NULL, error_message=NULL, error_code=NULL, warning_message=NULL, progress_percent=0, downloaded_bytes=NULL, total_bytes=NULL, speed_bytes_per_second=NULL, eta_seconds=NULL, quality=excluded.quality, output_preset=excluded.output_preset, save_subtitles=excluded.save_subtitles, subtitle_languages_json=excluded.subtitle_languages_json, save_cover=excluded.save_cover, save_source_record=excluded.save_source_record, retain_source=excluded.retain_source, library_hidden=0, updated_at=excluded.updated_at",
            params![id, stored_quality, output_preset, save_subtitles as i64, subtitle_languages_json, save_cover as i64, save_source_record as i64, retain_source as i64, now],
        ).map_err(|error| format!("创建下载任务失败：{error}"))?;
        let job_id: i64 = connection
            .query_row(
                "SELECT id FROM download_jobs WHERE item_id=?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取下载任务失败：{error}"))?;
        let quality_format_ids = quality_format_ids
            .and_then(|value| serde_json::from_str::<BTreeMap<i64, String>>(&value).ok())
            .unwrap_or_default();
        (
            page_url,
            job_id,
            auth_required,
            source_id,
            source_title,
            quality_format_ids,
        )
    };
    let asset_root =
        asset_package_directory(&downloads_dir, &source_title, source_id.as_deref(), id);
    let media_directory = asset_root.join(if audio_only { "audio" } else { "video" });
    for directory in [
        media_directory.clone(),
        asset_root.join("audio"),
        asset_root.join("images"),
        asset_root.join("subtitles"),
    ] {
        fs::create_dir_all(&directory).map_err(|error| format!("创建素材包目录失败：{error}"))?;
    }
    let output_template = media_directory
        .join("%(title).180B [%(id)s].%(ext)s")
        .to_string_lossy()
        .to_string();
    let format_selector = if audio_only {
        "ba/bestaudio".to_string()
    } else if let Some(height) = requested_quality_height(&quality)? {
        if let Some(format_id) = quality_format_ids.get(&(height as i64)) {
            exact_format_selector(format_id)?
        } else if source_format {
            source_format_selector_for_quality(&quality)?
        } else {
            format_selector_for_quality(&quality)?
        }
    } else if source_format {
        source_format_selector_for_quality(&quality)?
    } else {
        format_selector_for_quality(&quality)?
    };
    queued.insert(job_id, control.clone());
    drop(active);
    drop(queued);
    let db_path = state.db_path.clone();
    let active_downloads = state.active_downloads.clone();
    let queued_downloads = state.queued_downloads.clone();
    let active_processing = state.active_processing.clone();
    let queued_processing = state.queued_processing.clone();
    let package_downloads_dir = downloads_dir.clone();
    let package_ffmpeg = state.components_dir.join("ffmpeg.exe");
    // Authentication can become necessary only when yt-dlp requests the media
    // streams, even though metadata recognition succeeded anonymously. Keep a
    // configured browser available for that second-stage retry as well.
    let browser_retry = state
        .source_browser
        .lock()
        .map_err(|_| "浏览器登录状态不可用。".to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            let requested_action = control.load(Ordering::Acquire);
            if requested_action != 0 {
                if let Ok(mut queued) = queued_downloads.lock() {
                    queued.remove(&job_id);
                }
                if let Ok(connection) = Connection::open(&db_path) {
                    if requested_action == 2 {
                        let _ = connection.execute("UPDATE download_jobs SET status='paused',stage='paused',error_message=NULL,error_code=NULL,updated_at=?1 WHERE id=?2", params![unix_seconds(), job_id]);
                    } else {
                        let _ = connection.execute("UPDATE download_jobs SET status='failed',stage='failed',error_message='排队下载已取消。',error_code='CANCELLED_BY_USER',updated_at=?1 WHERE id=?2", params![unix_seconds(), job_id]);
                    }
                }
                return;
            }
            let claimed = if let Ok(mut active) = active_downloads.lock() {
                if let Ok(mut queued) = queued_downloads.lock() {
                    try_claim_queued_task(&mut active, &mut queued, job_id, concurrency_limit)
                } else {
                    false
                }
            } else {
                false
            };
            if claimed {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if let Ok(connection) = Connection::open(&db_path) {
            let _ = connection.execute("UPDATE download_jobs SET status='downloading',stage='downloading',updated_at=?1 WHERE id=?2", params![unix_seconds(), job_id]);
        }
        let result_control = control.clone();
        let public_result = execute_download_task(
            component.clone(),
            page_url.clone(),
            output_template.clone(),
            asset_root.clone(),
            db_path.clone(),
            job_id,
            format_selector.clone(),
            audio_only,
            source_format,
            save_subtitles,
            subtitle_languages.clone(),
            save_cover,
            save_source_record,
            retain_source,
            control.clone(),
            None,
            source_id.clone(),
        );
        let result = match public_result {
            Err(message)
                if task_error_code(&message, false) == "AUTH_REQUIRED"
                    && browser_retry.is_some() =>
            {
                execute_download_task(
                    component,
                    page_url,
                    output_template,
                    asset_root,
                    db_path.clone(),
                    job_id,
                    format_selector,
                    audio_only,
                    source_format,
                    save_subtitles,
                    subtitle_languages,
                    save_cover,
                    save_source_record,
                    retain_source,
                    control,
                    browser_retry,
                    source_id,
                )
            }
            other => other,
        };
        if let Ok(connection) = Connection::open(&db_path) {
            let now = unix_seconds();
            match result {
                Ok(task) => {
                    let task_path = task.file_path.clone();
                    let _ = connection.execute("UPDATE download_jobs SET status='completed',stage='completed',file_path=?1,error_message=NULL,error_code=NULL,warning_message=?2,progress_percent=100,speed_bytes_per_second=NULL,eta_seconds=NULL,updated_at=?3 WHERE id=?4", params![task.file_path, task.warning_message, now, job_id]);
                    drop(connection);
                    if package_mode {
                        if let Err(message) = queue_package_audio(
                            db_path.clone(),
                            package_downloads_dir,
                            package_ffmpeg,
                            job_id,
                            PathBuf::from(task_path),
                            active_processing,
                            queued_processing,
                        ) {
                            if let Ok(connection) = Connection::open(&db_path) {
                                let _ = connection.execute("UPDATE download_jobs SET warning_message=trim(COALESCE(warning_message,'') || ' 素材包中的 MP3 未生成，可在素材库中手动提取。'),updated_at=?1 WHERE id=?2", params![unix_seconds(), job_id]);
                            }
                            eprintln!("{message}");
                        }
                    }
                }
                Err(_message) if result_control.load(Ordering::Acquire) == 2 => {
                    let _ = connection.execute("UPDATE download_jobs SET status='paused',stage='paused',error_message=NULL,error_code=NULL,speed_bytes_per_second=NULL,eta_seconds=NULL,updated_at=?1 WHERE id=?2", params![now, job_id]);
                }
                Err(message) => {
                    let code = task_error_code(&message, false);
                    let _ = connection.execute("UPDATE download_jobs SET status='failed',stage='failed',error_message=?1,error_code=?2,speed_bytes_per_second=NULL,eta_seconds=NULL,updated_at=?3 WHERE id=?4", params![message, code, now, job_id]);
                }
            }
        }
        if let Ok(mut active) = active_downloads.lock() {
            active.remove(&job_id);
        }
    });
    let connection = state
        .db
        .lock()
        .map_err(|_| "数据库锁不可用。".to_string())?;
    select_download_job(&connection, id)
}

#[tauri::command]
async fn resume_download(
    job_id: i64,
    concurrency_limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<DownloadJob, String> {
    let (
        item_id,
        quality,
        output_preset,
        save_subtitles,
        subtitle_languages_json,
        save_cover,
        save_source_record,
        retain_source,
    ) = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        connection.query_row(
            "SELECT item_id,quality,output_preset,save_subtitles,subtitle_languages_json,save_cover,save_source_record,retain_source FROM download_jobs WHERE id=?1 AND status='paused'",
            params![job_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)? != 0, row.get::<_, String>(4)?, row.get::<_, i64>(5)? != 0, row.get::<_, i64>(6)? != 0, row.get::<_, i64>(7)? != 0)),
        ).map_err(|_| "只能继续已暂停的下载任务。".to_string())?
    };
    let subtitle_languages: Vec<String> = serde_json::from_str(&subtitle_languages_json)
        .map_err(|error| format!("读取原下载字幕参数失败：{error}"))?;
    download_inbox_item(
        item_id,
        Some(quality),
        Some(output_preset),
        Some(save_subtitles),
        Some(subtitle_languages),
        Some(save_cover),
        Some(save_source_record),
        Some(retain_source),
        concurrency_limit,
        state,
    )
    .await
}

#[tauri::command]
async fn retry_download(
    job_id: i64,
    concurrency_limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<DownloadJob, String> {
    let (
        item_id,
        quality,
        output_preset,
        save_subtitles,
        subtitle_languages_json,
        save_cover,
        save_source_record,
        retain_source,
    ) = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "数据库锁不可用。".to_string())?;
        connection.query_row(
            "SELECT item_id,quality,output_preset,save_subtitles,subtitle_languages_json,save_cover,save_source_record,retain_source FROM download_jobs WHERE id=?1 AND status='failed'",
            params![job_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)? != 0, row.get::<_, String>(4)?, row.get::<_, i64>(5)? != 0, row.get::<_, i64>(6)? != 0, row.get::<_, i64>(7)? != 0)),
        ).map_err(|_| "只能重试失败的下载任务。".to_string())?
    };
    let subtitle_languages: Vec<String> = serde_json::from_str(&subtitle_languages_json)
        .map_err(|error| format!("读取原下载字幕参数失败：{error}"))?;
    download_inbox_item(
        item_id,
        Some(quality),
        Some(output_preset),
        Some(save_subtitles),
        Some(subtitle_languages),
        Some(save_cover),
        Some(save_source_record),
        Some(retain_source),
        concurrency_limit,
        state,
    )
    .await
}

#[tauri::command]
fn cancel_download(job_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancelled) = state
        .active_downloads
        .lock()
        .map_err(|_| "任务状态不可用。".to_string())?
        .get(&job_id)
    {
        cancelled.store(1, Ordering::Release);
        return Ok(());
    }
    if let Some(cancelled) = state
        .queued_downloads
        .lock()
        .map_err(|_| "排队状态不可用。".to_string())?
        .get(&job_id)
    {
        cancelled.store(1, Ordering::Release);
        return Ok(());
    }
    Err("该下载任务当前未运行或排队。".into())
}

#[tauri::command]
fn pause_download(job_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(control) = state
        .active_downloads
        .lock()
        .map_err(|_| "任务状态不可用。".to_string())?
        .get(&job_id)
    {
        control.store(2, Ordering::Release);
        return Ok(());
    }
    Err("只有正在下载的任务可以暂停。".into())
}

fn extension_ids_from_manifest(path: &PathBuf) -> Vec<String> {
    let value: serde_json::Value = match fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(value) => value,
        None => return Vec::new(),
    };
    value
        .get("allowed_origins")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|origin| origin.as_str())
        .filter_map(|origin| {
            normalize_extension_id(
                origin
                    .strip_prefix("chrome-extension://")?
                    .strip_suffix('/')?,
            )
            .ok()
        })
        .collect()
}

fn registry_points_to_manifest(manifest_path: &PathBuf) -> bool {
    let expected = manifest_path.to_string_lossy().to_ascii_lowercase();
    [
        r"HKCU\Software\Google\Chrome\NativeMessagingHosts\net.clipcargo.native",
        r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\net.clipcargo.native",
    ]
    .iter()
    .all(|key| {
        Command::new("reg.exe")
            .args(["QUERY", key, "/ve"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .to_ascii_lowercase()
                    .contains(&expected)
            })
            .unwrap_or(false)
    })
}

fn read_extension_heartbeat(path: &PathBuf) -> Option<ExtensionHeartbeat> {
    let heartbeat: ExtensionHeartbeat = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    TRUSTED_EXTENSION_IDS
        .contains(&heartbeat.extension_id.as_str())
        .then_some(heartbeat)
}

#[tauri::command]
fn bridge_status(state: State<'_, AppState>) -> BridgeStatus {
    let current_exe = std::env::current_exe().ok();
    let host_installed = current_exe
        .as_ref()
        .map(|path| path.with_file_name("clipcargo-native-host.exe").is_file())
        .unwrap_or(false);
    let manifest_path = state
        .components_dir
        .parent()
        .map(|path| path.join("native-messaging/net.clipcargo.native.json"));
    let registered_extension_ids = manifest_path
        .as_ref()
        .map(extension_ids_from_manifest)
        .unwrap_or_default();
    let registered = host_installed
        && TRUSTED_EXTENSION_IDS
            .iter()
            .all(|extension_id| registered_extension_ids.iter().any(|registered| registered == extension_id))
        && manifest_path
            .as_ref()
            .is_some_and(registry_points_to_manifest);
    let heartbeat = read_extension_heartbeat(&state.bridge_inbox.join(".extension-status"));
    let extension_id = heartbeat
        .as_ref()
        .map(|status| status.extension_id.clone())
        .or_else(|| {
            registered_extension_ids
                .iter()
                .find(|extension_id| extension_id.as_str() == STORE_EXTENSION_ID)
                .cloned()
        });
    let last_seen_at = heartbeat.as_ref().map(|status| status.received_at);
    let now = unix_seconds().max(0) as u64;
    let extension_active = last_seen_at.is_some_and(|seen| now.saturating_sub(seen) <= 150);
    let extension_version = heartbeat.as_ref().map(|status| status.version.clone());
    let extension_package_version = extension_package_version(&state.extension_dir);
    BridgeStatus {
        queue_path: state.bridge_inbox.clone(),
        host_name: "net.clipcargo.native".into(),
        protocol_version: 1,
        host_installed,
        registered,
        extension_id,
        extension_verified: heartbeat.is_some(),
        extension_active,
        extension_version,
        extension_package_version,
        last_seen_at,
    }
}

fn extension_package_version(extension_dir: &Path) -> Option<String> {
    fs::read(extension_dir.join("manifest.json"))
        .ok()
        .and_then(|contents| serde_json::from_slice::<serde_json::Value>(&contents).ok())
        .and_then(|manifest| {
            manifest
                .get("version")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
}

#[tauri::command]
fn component_status(state: State<'_, AppState>) -> ComponentStatus {
    let downloads_dir = current_downloads_dir(&state).unwrap_or_default();
    let yt_dlp_path = state.components_dir.join("yt-dlp.exe");
    let yt_dlp_ready = yt_dlp_path.is_file();
    let ffmpeg_ready = state.components_dir.join("ffmpeg.exe").is_file()
        && state.components_dir.join("ffprobe.exe").is_file();
    let deno_path = state.components_dir.join("deno.exe");
    let deno_ready = deno_path.is_file();
    let managed_bytes = |kind: &str| {
        component_managed_files(kind)
            .unwrap_or(&[])
            .iter()
            .filter_map(|name| fs::metadata(state.components_dir.join(name)).ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .sum::<u64>()
    };
    let yt_dlp_bytes = managed_bytes("yt-dlp");
    let ffmpeg_bytes = managed_bytes("ffmpeg");
    let deno_bytes = managed_bytes("deno");
    ComponentStatus {
        yt_dlp_ready,
        ffmpeg_ready,
        deno_ready,
        component_directory: state.components_dir.clone(),
        downloads_directory: downloads_dir.clone(),
        download_pipeline: if yt_dlp_ready {
            "ready".into()
        } else {
            "component-required".into()
        },
        yt_dlp_version: if yt_dlp_ready {
            Command::new(&yt_dlp_path)
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            None
        },
        ffmpeg_version: if ffmpeg_ready {
            Command::new(state.components_dir.join("ffmpeg.exe"))
                .arg("-version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(str::to_string)
                })
        } else {
            None
        },
        deno_version: if deno_ready {
            Command::new(&deno_path)
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(str::to_string)
                })
        } else {
            None
        },
        storage_free_bytes: fs2::available_space(&downloads_dir).ok(),
        installing: state.component_installing.load(Ordering::Acquire),
        install_phase: match state.component_install_phase.load(Ordering::Acquire) {
            1 => "downloading",
            2 => "verifying",
            3 => "installing",
            _ => "idle",
        }
        .into(),
        install_progress_percent: state.component_installing.load(Ordering::Acquire).then(|| {
            state
                .component_install_progress
                .load(Ordering::Acquire)
                .min(100)
        }),
        yt_dlp_bytes,
        ffmpeg_bytes,
        deno_bytes,
        total_bytes: yt_dlp_bytes
            .saturating_add(ffmpeg_bytes)
            .saturating_add(deno_bytes),
    }
}

#[tauri::command]
fn component_install_status(state: State<'_, AppState>) -> ComponentInstallStatus {
    let installing = state.component_installing.load(Ordering::Acquire);
    ComponentInstallStatus {
        installing,
        install_phase: match state.component_install_phase.load(Ordering::Acquire) {
            1 => "downloading",
            2 => "verifying",
            3 => "installing",
            _ => "idle",
        }
        .into(),
        install_progress_percent: installing.then(|| {
            state
                .component_install_progress
                .load(Ordering::Acquire)
                .min(100)
        }),
    }
}

#[tauri::command]
fn cancel_component_install(state: State<'_, AppState>) -> Result<(), String> {
    if !state.component_installing.load(Ordering::Acquire) {
        return Err("当前没有正在进行的工具安装。".into());
    }
    state
        .component_cancel_requested
        .store(true, Ordering::Release);
    Ok(())
}

fn component_managed_files(kind: &str) -> Result<&'static [&'static str], String> {
    match kind {
        "yt-dlp" => Ok(&["yt-dlp.exe", "yt-dlp.manifest.json", "yt-dlp-NOTICE.txt"]),
        "deno" => Ok(&["deno.exe", "deno.manifest.json", "deno-NOTICE.txt"]),
        "ffmpeg" => Ok(&[
            "ffmpeg.exe",
            "ffprobe.exe",
            "ffmpeg.manifest.json",
            "FFmpeg-NOTICE.txt",
        ]),
        _ => Err("未知工具，未执行卸载。".into()),
    }
}

fn remove_component_files(components_dir: &PathBuf, kind: &str) -> Result<usize, String> {
    let files = component_managed_files(kind)?;
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    for name in files {
        let current = components_dir.join(name);
        if !current.exists() {
            continue;
        }
        let removing = components_dir.join(format!("{name}.removing"));
        if removing.exists() {
            fs::remove_file(&removing)
                .map_err(|error| format!("无法清理上次卸载暂存文件：{error}"))?;
        }
        if let Err(error) = fs::rename(&current, &removing) {
            for (original, staged_path) in staged.iter().rev() {
                let _ = fs::rename(staged_path, original);
            }
            return Err(format!("工具正在使用或文件不可写，未执行卸载：{error}"));
        }
        staged.push((current, removing));
    }
    if staged.is_empty() {
        return Err("该工具尚未安装。".into());
    }
    let removed = staged.len();
    for (_, staged_path) in staged {
        fs::remove_file(staged_path)
            .map_err(|error| format!("工具已停用，但暂存文件清理失败：{error}"))?;
    }
    Ok(removed)
}

fn rollback_component_group(components_dir: &PathBuf, names: &[&str]) {
    for name in names {
        let current = components_dir.join(name);
        if current.exists() {
            let _ = fs::remove_file(&current);
        }
    }
    for name in names {
        let current = components_dir.join(name);
        let backup = components_dir.join(format!("{name}.backup"));
        if backup.exists() {
            let _ = fs::rename(backup, current);
        }
    }
}

fn activate_component_group(components_dir: &PathBuf, names: &[&str]) -> Result<(), String> {
    for name in names {
        let backup = components_dir.join(format!("{name}.backup"));
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| format!("清理 {name} 旧备份失败：{error}"))?;
        }
    }
    let mut backed_up = Vec::new();
    for name in names {
        let current = components_dir.join(name);
        if current.exists() {
            let backup = components_dir.join(format!("{name}.backup"));
            if let Err(error) = fs::rename(&current, &backup) {
                for previous in backed_up {
                    let previous_backup = components_dir.join(format!("{previous}.backup"));
                    let _ = fs::rename(previous_backup, components_dir.join(previous));
                }
                return Err(format!("备份 {name} 失败，现有版本没有改变：{error}"));
            }
            backed_up.push(*name);
        }
    }
    for name in names {
        let fresh = components_dir.join(format!("{name}.new"));
        let current = components_dir.join(name);
        if let Err(error) = fs::rename(&fresh, &current) {
            rollback_component_group(components_dir, names);
            return Err(format!("启用 {name} 失败，已恢复整组旧版本：{error}"));
        }
    }
    Ok(())
}

#[tauri::command]
fn remove_component(kind: String, state: State<'_, AppState>) -> Result<usize, String> {
    if state.component_installing.load(Ordering::Acquire) {
        return Err("工具正在安装，请等待安装结束或先取消安装。".into());
    }
    let busy = !state
        .active_downloads
        .lock()
        .map_err(|_| "下载任务状态不可用。")?
        .is_empty()
        || !state
            .queued_downloads
            .lock()
            .map_err(|_| "下载队列状态不可用。")?
            .is_empty()
        || !state
            .active_processing
            .lock()
            .map_err(|_| "处理任务状态不可用。")?
            .is_empty()
        || !state
            .queued_processing
            .lock()
            .map_err(|_| "处理队列状态不可用。")?
            .is_empty();
    if busy {
        return Err("有下载或处理任务正在运行或排队，请先完成或停止任务再卸载工具。".into());
    }
    remove_component_files(&state.components_dir, &kind)
}

fn expected_yt_dlp_hash(checksums: &str) -> Result<String, String> {
    checksums
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let hash = fields.next()?;
            let filename = fields.next()?;
            (filename.trim_start_matches('*') == "yt-dlp.exe").then(|| hash.to_ascii_lowercase())
        })
        .filter(|hash| hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "官方校验文件中没有有效的 yt-dlp.exe SHA-256。".into())
}

fn standalone_sha256(raw: &str) -> Result<String, String> {
    raw.split_whitespace()
        .find(|value| value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "校验文件中没有有效的 SHA-256。".into())
}

#[tauri::command]
async fn install_yt_dlp(state: State<'_, AppState>) -> Result<ComponentInstallResult, String> {
    ensure_free_space(&state.components_dir, 128 * 1_048_576, "安装下载引擎")?;
    state
        .component_installing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "工具安装正在进行，请稍候。".to_string())?;
    state
        .component_cancel_requested
        .store(false, Ordering::Release);
    state.component_install_phase.store(1, Ordering::Release);
    state.component_install_progress.store(0, Ordering::Release);
    let _guard = InstallFlagGuard {
        installing: &state.component_installing,
        phase: &state.component_install_phase,
        progress: &state.component_install_progress,
    };
    install_yt_dlp_into_controlled(
        &state.components_dir,
        &state.component_cancel_requested,
        Some(&state.component_install_phase),
        Some(&state.component_install_progress),
    )
    .await
}

#[cfg(test)]
async fn install_yt_dlp_into(components_dir: &PathBuf) -> Result<ComponentInstallResult, String> {
    let cancel = AtomicBool::new(false);
    install_yt_dlp_into_controlled(components_dir, &cancel, None, None).await
}

async fn download_component_bytes(
    mut response: reqwest::Response,
    maximum: usize,
    label: &str,
    cancel: &AtomicBool,
    progress: Option<&AtomicU8>,
) -> Result<Vec<u8>, String> {
    let expected = response.content_length().filter(|value| *value > 0);
    let mut payload = Vec::with_capacity(expected.unwrap_or(0).min(maximum as u64) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取{label}下载内容失败：{error}"))?
    {
        if cancel.load(Ordering::Acquire) {
            return Err("工具安装已取消。".into());
        }
        let next = payload
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| format!("{label}下载大小溢出。"))?;
        if next > maximum {
            return Err(format!("{label}下载内容超过安全上限。"));
        }
        payload.extend_from_slice(&chunk);
        if let (Some(progress), Some(expected)) = (progress, expected) {
            progress.store(
                ((next as u64 * 90 / expected).min(90)) as u8,
                Ordering::Release,
            );
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err("工具安装已取消。".into());
    }
    Ok(payload)
}

async fn request_component(
    client: &reqwest::Client,
    url: &str,
    label: &str,
) -> Result<reqwest::Response, String> {
    let mut last_error = String::new();
    for attempt in 0..5 {
        match client.get(url).send().await {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let status = response.status();
                last_error = format!("HTTP {status}");
                if status.as_u16() != 429 && !status.is_server_error() {
                    return Err(format!("{label}地址返回错误：{last_error}"));
                }
            }
            Err(error) => last_error = error.to_string(),
        }
        if attempt < 4 {
            thread::sleep(Duration::from_secs(1_u64 << attempt));
        }
    }
    Err(format!("{label}失败，已重试 5 次：{last_error}"))
}

async fn download_component_file(
    client: &reqwest::Client,
    url: &str,
    path: &PathBuf,
    maximum: usize,
    label: &str,
    cancel: &AtomicBool,
    progress: Option<&AtomicU8>,
) -> Result<(usize, String), String> {
    let mut last_error = String::new();
    for attempt in 0..5 {
        if cancel.load(Ordering::Acquire) {
            return Err("工具安装已取消。".into());
        }
        let result = async {
            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|error| format!("{label}连接失败：{error}"))?;
            if !response.status().is_success() {
                return Err(format!("{label}地址返回错误：HTTP {}", response.status()));
            }
            if response.content_length().unwrap_or(0) as usize > maximum {
                return Err(format!("{label}下载文件超过安全上限。"));
            }
            let expected = response.content_length().filter(|value| *value > 0);
            let mut output = fs::File::create(path)
                .map_err(|error| format!("创建{label}临时文件失败：{error}"))?;
            let mut hasher = Sha256::new();
            let mut byte_count = 0usize;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| format!("读取{label}下载内容失败：{error}"))?
            {
                if cancel.load(Ordering::Acquire) {
                    return Err("工具安装已取消。".into());
                }
                byte_count = byte_count
                    .checked_add(chunk.len())
                    .ok_or_else(|| format!("{label}下载大小溢出。"))?;
                if byte_count > maximum {
                    return Err(format!("{label}下载内容超过安全上限。"));
                }
                if let (Some(progress), Some(expected)) = (progress, expected) {
                    progress.store(
                        ((byte_count as u64 * 90 / expected).min(90)) as u8,
                        Ordering::Release,
                    );
                }
                hasher.update(&chunk);
                std::io::Write::write_all(&mut output, &chunk)
                    .map_err(|error| format!("写入{label}临时文件失败：{error}"))?;
            }
            Ok((byte_count, format!("{:x}", hasher.finalize())))
        }
        .await;
        match result {
            Ok(download) => return Ok(download),
            Err(error) if error == "工具安装已取消。" => {
                let _ = fs::remove_file(path);
                return Err(error);
            }
            Err(error) => {
                last_error = error;
                let _ = fs::remove_file(path);
            }
        }
        if attempt < 4 {
            thread::sleep(Duration::from_secs(1_u64 << attempt));
        }
    }
    Err(format!("{label}下载失败，已重试 5 次：{last_error}"))
}

async fn install_yt_dlp_into_controlled(
    components_dir: &PathBuf,
    cancel: &AtomicBool,
    phase: Option<&AtomicU8>,
    progress: Option<&AtomicU8>,
) -> Result<ComponentInstallResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("ClipCargo/0.1 component-manager")
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| format!("创建安全下载连接失败：{error}"))?;
    let base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
    let checksum_response = client
        .get(format!("{base}/SHA2-256SUMS"))
        .send()
        .await
        .map_err(|error| format!("获取官方校验文件失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("官方校验文件返回错误：{error}"))?;
    if checksum_response.content_length().unwrap_or(0) > 1_048_576 {
        return Err("官方校验文件大小异常，已停止安装。".into());
    }
    let checksums = checksum_response
        .text()
        .await
        .map_err(|error| format!("读取官方校验文件失败：{error}"))?;
    let expected_hash = expected_yt_dlp_hash(&checksums)?;
    let payload_response = client
        .get(format!("{base}/yt-dlp.exe"))
        .send()
        .await
        .map_err(|error| format!("下载 yt-dlp 失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("yt-dlp 下载地址返回错误：{error}"))?;
    if payload_response.content_length().unwrap_or(0) > 67_108_864 {
        return Err("yt-dlp 下载文件超过 64 MiB 安全上限，已停止安装。".into());
    }
    let payload =
        download_component_bytes(payload_response, 67_108_864, "yt-dlp", cancel, progress).await?;
    if let Some(phase) = phase {
        phase.store(2, Ordering::Release);
    }
    if let Some(progress) = progress {
        progress.store(93, Ordering::Release);
    }
    let actual_hash = format!("{:x}", Sha256::digest(&payload));
    if actual_hash != expected_hash {
        return Err(format!(
            "yt-dlp 完整性校验失败：期望 {expected_hash}，实际 {actual_hash}。"
        ));
    }
    if cancel.load(Ordering::Acquire) {
        return Err("工具安装已取消。".into());
    }
    if let Some(phase) = phase {
        phase.store(3, Ordering::Release);
    }
    if let Some(progress) = progress {
        progress.store(97, Ordering::Release);
    }
    fs::create_dir_all(components_dir).map_err(|error| format!("创建工具目录失败：{error}"))?;
    let final_path = components_dir.join("yt-dlp.exe");
    let temporary_path = components_dir.join("yt-dlp.exe.download");
    let backup_path = components_dir.join("yt-dlp.exe.backup");
    fs::write(&temporary_path, &payload)
        .map_err(|error| format!("写入工具临时文件失败：{error}"))?;
    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(|error| format!("清理旧工具备份失败：{error}"))?;
    }
    if final_path.exists() {
        fs::rename(&final_path, &backup_path)
            .map_err(|error| format!("备份当前工具失败：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary_path, &final_path) {
        if backup_path.exists() {
            let _ = fs::rename(&backup_path, &final_path);
        }
        return Err(format!("启用新工具失败，已尝试恢复旧版本：{error}"));
    }
    let version_output = match Command::new(&final_path).arg("--version").output() {
        Ok(output) => output,
        Err(error) => {
            rollback_component_group(components_dir, &["yt-dlp.exe"]);
            return Err(format!(
                "{}；已恢复旧版本。",
                external_tool_start_error("下载引擎", &error)
            ));
        }
    };
    if !version_output.status.success() {
        rollback_component_group(components_dir, &["yt-dlp.exe"]);
        return Err("新工具无法正常运行，已恢复旧版本。".into());
    }
    let version = String::from_utf8_lossy(&version_output.stdout)
        .trim()
        .to_string();
    let source_code =
        format!("https://github.com/yt-dlp/yt-dlp/archive/refs/tags/{version}.tar.gz");
    let manifest = serde_json::json!({"component":"yt-dlp","version":version,"sha256":actual_hash,"source":"https://github.com/yt-dlp/yt-dlp/releases/latest","sourceCode":source_code,"license":"GPL-3.0-or-later (standalone Windows executable)","licenseDetails":"https://github.com/yt-dlp/yt-dlp/blob/master/README.md#licensing","installedAt":unix_seconds()});
    fs::write(
        components_dir.join("yt-dlp.manifest.json"),
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("生成工具清单失败：{error}"))?,
    )
    .map_err(|error| format!("保存工具清单失败：{error}"))?;
    let notice = format!("yt-dlp {version}\r\n\r\nBinary source: https://github.com/yt-dlp/yt-dlp/releases/latest\r\nCorresponding source: {source_code}\r\nLicense: GPL-3.0-or-later for the PyInstaller-bundled Windows executable.\r\nLicense details and bundled dependency notices: https://github.com/yt-dlp/yt-dlp/blob/{version}/THIRD_PARTY_LICENSES.txt\r\nProject license: https://github.com/yt-dlp/yt-dlp/blob/{version}/LICENSE\r\nSHA-256: {actual_hash}\r\n");
    fs::write(components_dir.join("yt-dlp-NOTICE.txt"), notice)
        .map_err(|error| format!("保存 yt-dlp 许可声明失败：{error}"))?;
    if backup_path.exists() {
        let _ = fs::remove_file(backup_path);
    }
    Ok(ComponentInstallResult {
        component: "yt-dlp".into(),
        version,
        sha256: actual_hash,
        bytes: payload.len(),
    })
}

#[tauri::command]
async fn install_deno(state: State<'_, AppState>) -> Result<ComponentInstallResult, String> {
    ensure_free_space(
        &state.components_dir,
        160 * 1_048_576,
        "安装 JavaScript 运行时",
    )?;
    state
        .component_installing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "工具安装正在进行，请稍候。".to_string())?;
    state
        .component_cancel_requested
        .store(false, Ordering::Release);
    state.component_install_phase.store(1, Ordering::Release);
    state.component_install_progress.store(0, Ordering::Release);
    let _guard = InstallFlagGuard {
        installing: &state.component_installing,
        phase: &state.component_install_phase,
        progress: &state.component_install_progress,
    };
    install_deno_into_controlled(
        &state.components_dir,
        &state.component_cancel_requested,
        Some(&state.component_install_phase),
        Some(&state.component_install_progress),
    )
    .await
}

#[cfg(test)]
async fn install_deno_into(components_dir: &PathBuf) -> Result<ComponentInstallResult, String> {
    let cancel = AtomicBool::new(false);
    install_deno_into_controlled(components_dir, &cancel, None, None).await
}

async fn install_deno_into_controlled(
    components_dir: &PathBuf,
    cancel: &AtomicBool,
    phase: Option<&AtomicU8>,
    progress: Option<&AtomicU8>,
) -> Result<ComponentInstallResult, String> {
    const BASE: &str = "https://github.com/denoland/deno/releases/latest/download";
    const ARCHIVE: &str = "deno-x86_64-pc-windows-msvc.zip";
    let client = reqwest::Client::builder()
        .user_agent("ClipCargo/0.1 component-manager")
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| format!("创建安全下载连接失败：{error}"))?;
    let checksum = client
        .get(format!("{BASE}/{ARCHIVE}.sha256sum"))
        .send()
        .await
        .map_err(|error| format!("获取 Deno 校验文件失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Deno 校验地址返回错误：{error}"))?
        .text()
        .await
        .map_err(|error| format!("读取 Deno 校验文件失败：{error}"))?;
    let expected_hash = standalone_sha256(&checksum)?;
    let response = client
        .get(format!("{BASE}/{ARCHIVE}"))
        .send()
        .await
        .map_err(|error| format!("下载 Deno 失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Deno 下载地址返回错误：{error}"))?;
    if response.content_length().unwrap_or(0) > 104_857_600 {
        return Err("Deno 下载文件超过 100 MiB 安全上限。".into());
    }
    let payload = download_component_bytes(response, 104_857_600, "Deno", cancel, progress).await?;
    if let Some(phase) = phase {
        phase.store(2, Ordering::Release);
    }
    if let Some(progress) = progress {
        progress.store(93, Ordering::Release);
    }
    let actual_hash = format!("{:x}", Sha256::digest(&payload));
    if actual_hash != expected_hash {
        return Err(format!(
            "Deno 完整性校验失败：期望 {expected_hash}，实际 {actual_hash}。"
        ));
    }
    if cancel.load(Ordering::Acquire) {
        return Err("工具安装已取消。".into());
    }
    if let Some(phase) = phase {
        phase.store(3, Ordering::Release);
    }
    if let Some(progress) = progress {
        progress.store(97, Ordering::Release);
    }
    let extraction_dir = components_dir.clone();
    let extraction_payload = payload.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(extraction_payload))
            .map_err(|error| format!("打开 Deno 压缩包失败：{error}"))?;
        let mut entry = archive
            .by_name("deno.exe")
            .map_err(|error| format!("压缩包中没有 deno.exe：{error}"))?;
        fs::create_dir_all(&extraction_dir)
            .map_err(|error| format!("创建工具目录失败：{error}"))?;
        let temporary = extraction_dir.join("deno.exe.new");
        let mut output = fs::File::create(&temporary)
            .map_err(|error| format!("创建 Deno 临时文件失败：{error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("解压 Deno 失败：{error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Deno 解压任务异常结束：{error}"))??;
    let temporary = components_dir.join("deno.exe.new");
    let current = components_dir.join("deno.exe");
    let backup = components_dir.join("deno.exe.backup");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| format!("清理 Deno 旧备份失败：{error}"))?;
    }
    if current.exists() {
        fs::rename(&current, &backup).map_err(|error| format!("备份当前 Deno 失败：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &current) {
        if backup.exists() {
            let _ = fs::rename(&backup, &current);
        }
        return Err(format!("启用 Deno 失败，已尝试恢复旧版本：{error}"));
    }
    let version_output = match Command::new(&current).arg("--version").output() {
        Ok(output) => output,
        Err(error) => {
            rollback_component_group(components_dir, &["deno.exe"]);
            return Err(format!(
                "{}；已恢复旧版本。",
                external_tool_start_error("Deno", &error)
            ));
        }
    };
    if !version_output.status.success() {
        rollback_component_group(components_dir, &["deno.exe"]);
        return Err("Deno 无法正常运行，已恢复旧版本。".into());
    }
    let version = String::from_utf8_lossy(&version_output.stdout)
        .lines()
        .next()
        .unwrap_or("deno")
        .to_string();
    let release_version = version.strip_prefix("deno ").unwrap_or(&version);
    let source_code =
        format!("https://github.com/denoland/deno/archive/refs/tags/v{release_version}.tar.gz");
    fs::write(components_dir.join("deno.manifest.json"), serde_json::to_vec_pretty(&serde_json::json!({"component":"deno","version":version.clone(),"sha256":actual_hash,"source":format!("{BASE}/{ARCHIVE}"),"sourceCode":source_code,"license":"MIT","licenseText":"https://github.com/denoland/deno/blob/main/LICENSE.md","installedAt":unix_seconds()})).map_err(|error| format!("生成 Deno 清单失败：{error}"))?)
        .map_err(|error| format!("保存 Deno 清单失败：{error}"))?;
    let notice = format!("Deno {release_version}\r\n\r\nBinary source: {BASE}/{ARCHIVE}\r\nCorresponding source: {source_code}\r\nLicense: MIT\r\nCopyright 2018-2026 the Deno authors\r\nLicense text: https://github.com/denoland/deno/blob/v{release_version}/LICENSE.md\r\nSHA-256: {actual_hash}\r\n");
    fs::write(components_dir.join("deno-NOTICE.txt"), notice)
        .map_err(|error| format!("保存 Deno 许可声明失败：{error}"))?;
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(ComponentInstallResult {
        component: "deno".into(),
        version,
        sha256: actual_hash,
        bytes: payload.len(),
    })
}

#[tauri::command]
async fn install_ffmpeg(state: State<'_, AppState>) -> Result<ComponentInstallResult, String> {
    ensure_free_space(&state.components_dir, 512 * 1_048_576, "安装视频处理工具")?;
    state
        .component_installing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "工具安装正在进行，请稍候。".to_string())?;
    state
        .component_cancel_requested
        .store(false, Ordering::Release);
    state.component_install_phase.store(1, Ordering::Release);
    state.component_install_progress.store(0, Ordering::Release);
    let _guard = InstallFlagGuard {
        installing: &state.component_installing,
        phase: &state.component_install_phase,
        progress: &state.component_install_progress,
    };
    install_ffmpeg_into_controlled(
        &state.components_dir,
        &state.component_cancel_requested,
        Some(&state.component_install_phase),
        Some(&state.component_install_progress),
    )
    .await
}

#[cfg(test)]
async fn install_ffmpeg_into(components_dir: &PathBuf) -> Result<ComponentInstallResult, String> {
    let cancel = AtomicBool::new(false);
    install_ffmpeg_into_controlled(components_dir, &cancel, None, None).await
}

async fn install_ffmpeg_into_controlled(
    components_dir: &PathBuf,
    cancel: &AtomicBool,
    phase: Option<&AtomicU8>,
    progress: Option<&AtomicU8>,
) -> Result<ComponentInstallResult, String> {
    const ARCHIVE_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
    const CHECKSUM_URL: &str =
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256";
    const MAX_ARCHIVE_BYTES: usize = 160 * 1024 * 1024;
    let client = reqwest::Client::builder()
        .user_agent("ClipCargo/0.1 component-manager")
        // Large component downloads can legitimately take longer than five minutes on
        // slower connections. Limit connection setup and stalled reads separately so
        // a continuously progressing transfer is not aborted by a total-request timer.
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| format!("创建安全下载连接失败：{error}"))?;
    let checksum_response =
        request_component(&client, CHECKSUM_URL, "获取 FFmpeg 校验文件").await?;
    if checksum_response.content_length().unwrap_or(0) > 1_048_576 {
        return Err("FFmpeg 校验文件大小异常。".into());
    }
    let expected_hash = standalone_sha256(
        &checksum_response
            .text()
            .await
            .map_err(|error| format!("读取 FFmpeg 校验文件失败：{error}"))?,
    )?;
    fs::create_dir_all(components_dir).map_err(|error| format!("创建工具目录失败：{error}"))?;
    let archive_path = components_dir.join("ffmpeg.zip.download");
    let (byte_count, actual_hash) = download_component_file(
        &client,
        ARCHIVE_URL,
        &archive_path,
        MAX_ARCHIVE_BYTES,
        "FFmpeg",
        cancel,
        progress,
    )
    .await?;
    if cancel.load(Ordering::Acquire) {
        let _ = fs::remove_file(&archive_path);
        return Err("工具安装已取消。".into());
    }
    if let Some(phase) = phase {
        phase.store(2, Ordering::Release);
    }
    if let Some(progress) = progress {
        progress.store(93, Ordering::Release);
    }
    if actual_hash != expected_hash {
        let _ = fs::remove_file(&archive_path);
        return Err(format!(
            "FFmpeg 完整性校验失败：期望 {expected_hash}，实际 {actual_hash}。"
        ));
    }
    if let Some(phase) = phase {
        phase.store(3, Ordering::Release);
    }
    if let Some(progress) = progress {
        progress.store(97, Ordering::Release);
    }

    let extraction_dir = components_dir.clone();
    let extraction_archive = archive_path.clone();
    let extraction = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let file = fs::File::open(&extraction_archive)
            .map_err(|error| format!("打开 FFmpeg 压缩包失败：{error}"))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|error| format!("读取 FFmpeg 压缩包失败：{error}"))?;
        for (needle, target) in [
            ("/bin/ffmpeg.exe", "ffmpeg.exe.new"),
            ("/bin/ffprobe.exe", "ffprobe.exe.new"),
            ("/LICENSE", "FFmpeg-LICENSE.txt"),
            ("/README.txt", "FFmpeg-README.txt"),
        ] {
            let index = (0..archive.len())
                .find(|index| {
                    archive
                        .by_index(*index)
                        .ok()
                        .map(|entry| entry.name().replace('\\', "/").ends_with(needle))
                        .unwrap_or(false)
                })
                .ok_or_else(|| format!("FFmpeg 压缩包缺少 {needle}。"))?;
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("读取 FFmpeg 文件失败：{error}"))?;
            if entry.size() > 200 * 1024 * 1024 {
                return Err("FFmpeg 可执行文件大小异常。".into());
            }
            let mut output = fs::File::create(extraction_dir.join(target))
                .map_err(|error| format!("创建 FFmpeg 工具失败：{error}"))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| format!("解压 FFmpeg 工具失败：{error}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("FFmpeg 解压任务异常结束：{error}"))?;
    let _ = fs::remove_file(&archive_path);
    extraction?;

    const FFMPEG_EXECUTABLES: &[&str] = &["ffmpeg.exe", "ffprobe.exe"];
    activate_component_group(components_dir, FFMPEG_EXECUTABLES)?;
    let ffmpeg_path = components_dir.join("ffmpeg.exe");
    let ffprobe_path = components_dir.join("ffprobe.exe");
    let ffmpeg_output = match Command::new(&ffmpeg_path).arg("-version").output() {
        Ok(output) => output,
        Err(error) => {
            rollback_component_group(components_dir, FFMPEG_EXECUTABLES);
            return Err(format!(
                "{}；已恢复整组旧版本。",
                external_tool_start_error("FFmpeg", &error)
            ));
        }
    };
    let ffprobe_ok = Command::new(&ffprobe_path)
        .arg("-version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if !ffmpeg_output.status.success() || !ffprobe_ok {
        rollback_component_group(components_dir, FFMPEG_EXECUTABLES);
        return Err("FFmpeg 或 ffprobe 无法正常运行，已恢复整组旧版本。".into());
    }
    let version = String::from_utf8_lossy(&ffmpeg_output.stdout)
        .lines()
        .next()
        .unwrap_or("FFmpeg")
        .to_string();
    let manifest = serde_json::json!({"component":"ffmpeg","version":version,"sha256":actual_hash,"source":ARCHIVE_URL,"sourceCode":"https://github.com/FFmpeg/FFmpeg","buildInformation":"https://www.gyan.dev/ffmpeg/builds/","license":"GPL-3.0-or-later","licenseFiles":["FFmpeg-LICENSE.txt","FFmpeg-README.txt"],"installedAt":unix_seconds()});
    let notice = format!("{version}\r\n\r\nBinary source: {ARCHIVE_URL}\r\nBuild information and corresponding source reference: https://www.gyan.dev/ffmpeg/builds/\r\nUpstream source: https://github.com/FFmpeg/FFmpeg\r\nLicense: GPL-3.0-or-later (this build enables GPL/version3 components)\r\nBundled license: FFmpeg-LICENSE.txt\r\nBundled build/readme information: FFmpeg-README.txt\r\nArchive SHA-256: {actual_hash}\r\n");
    let metadata_result = (|| -> Result<(), String> {
        fs::write(
            components_dir.join("ffmpeg.manifest.json"),
            serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("生成 FFmpeg 清单失败：{error}"))?,
        )
        .map_err(|error| format!("保存 FFmpeg 清单失败：{error}"))?;
        fs::write(components_dir.join("FFmpeg-NOTICE.txt"), notice)
            .map_err(|error| format!("保存 FFmpeg 许可声明失败：{error}"))?;
        Ok(())
    })();
    if let Err(error) = metadata_result {
        rollback_component_group(components_dir, FFMPEG_EXECUTABLES);
        return Err(format!("{error}；已恢复整组旧版本。"));
    }
    for name in ["ffmpeg.exe.backup", "ffprobe.exe.backup"] {
        let path = components_dir.join(name);
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
    Ok(ComponentInstallResult {
        component: "ffmpeg".into(),
        version,
        sha256: actual_hash,
        bytes: byte_count,
    })
}

fn read_configured_downloads_dir(app_data: &PathBuf) -> PathBuf {
    let fallback = app_data.join("downloads");
    let config_path = app_data.join("download-location.txt");
    let Ok(raw) = fs::read_to_string(config_path) else {
        return fallback;
    };
    let candidate = PathBuf::from(raw.trim());
    if candidate.is_absolute() && candidate.to_string_lossy().len() <= 2048 {
        candidate
    } else {
        fallback
    }
}

fn application_paths(
    app: &tauri::App,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    fs::create_dir_all(&app_data).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let components_dir = app_data.join("components");
    fs::create_dir_all(&components_dir).map_err(|error| format!("无法创建工具目录：{error}"))?;
    let downloads_config_path = app_data.join("download-location.txt");
    let downloads_dir = read_configured_downloads_dir(&app_data);
    fs::create_dir_all(&downloads_dir).map_err(|error| format!("无法创建下载目录：{error}"))?;
    Ok((
        app_data.join("clipcargo.sqlite3"),
        app_data.join("bridge-inbox"),
        components_dir,
        downloads_dir,
        downloads_config_path,
    ))
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn request_task_shutdown(state: &AppState) {
    if let Ok(active) = state.active_downloads.lock() {
        for control in active.values() {
            control.store(1, Ordering::Release);
        }
    }
    if let Ok(queued) = state.queued_downloads.lock() {
        for control in queued.values() {
            control.store(1, Ordering::Release);
        }
    }
    if let Ok(active) = state.active_processing.lock() {
        for cancelled in active.values() {
            cancelled.store(true, Ordering::Release);
        }
    }
    if let Ok(queued) = state.queued_processing.lock() {
        for cancelled in queued.values() {
            cancelled.store(true, Ordering::Release);
        }
    }
}

fn task_shutdown_complete(state: &AppState) -> bool {
    state
        .active_downloads
        .lock()
        .map(|tasks| tasks.is_empty())
        .unwrap_or(false)
        && state
            .queued_downloads
            .lock()
            .map(|tasks| tasks.is_empty())
            .unwrap_or(false)
        && state
            .active_processing
            .lock()
            .map(|tasks| tasks.is_empty())
            .unwrap_or(false)
        && state
            .queued_processing
            .lock()
            .map(|tasks| tasks.is_empty())
            .unwrap_or(false)
}

fn stop_tasks_and_exit(app: tauri::AppHandle) {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        state.allow_exit.store(true, Ordering::Release);
        request_task_shutdown(&state);
        if let Ok(mut source_login) = state.source_login.lock() {
            if let Some(mut session) = source_login.take() {
                terminate_child_tree(&mut session.child);
                let _ = session.child.wait();
            }
        }
        while !task_shutdown_complete(&state) {
            thread::sleep(Duration::from_millis(100));
        }
        app.exit(0);
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (
                database_path,
                bridge_inbox,
                components_dir,
                downloads_dir,
                downloads_config_path,
            ) =
                application_paths(app)?;
            let database_existed = database_path
                .metadata()
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false);
            let mut connection = Connection::open(&database_path)
                .map_err(|error| format!("打开数据库失败：{error}"))?;
            let migration_backup =
                prepare_database_backup(&connection, &database_path, database_existed)?;
            if let Err(migration_error) = initialize_database(&connection) {
                let recovery = migration_backup
                    .as_ref()
                    .map(|backup| restore_database_backup(&mut connection, backup))
                    .transpose();
                return match recovery {
                    Ok(Some(())) => Err(format!(
                        "{migration_error} 数据库已从迁移前备份恢复，应用未继续启动。"
                    )
                    .into()),
                    Ok(None) => Err(migration_error.into()),
                    Err(recovery_error) => Err(format!(
                        "{migration_error} {recovery_error} 备份保留在磁盘，请勿继续写入。"
                    )
                    .into()),
                };
            }
            connection
                .execute(
                    "INSERT OR IGNORE INTO managed_roots(path,created_at) VALUES(?1,?2)",
                    params![downloads_dir.to_string_lossy(), unix_seconds()],
                )
                .map_err(|error| format!("登记下载目录失败：{error}"))?;
            recover_interrupted_jobs(
                &connection,
                &downloads_dir,
                &components_dir.join("ffprobe.exe"),
            )?;
            allow_managed_roots(app.handle(), &connection, &downloads_dir)?;
            fs::create_dir_all(&bridge_inbox)
                .map_err(|error| format!("创建浏览器收集目录失败：{error}"))?;
            let bundled_extension_dir = app
                .path()
                .resource_dir()
                .map_err(|error| format!("无法确定软件资源目录：{error}"))?
                .join("browser-extension");
            let extension_dir = if bundled_extension_dir.join("manifest.json").is_file() {
                bundled_extension_dir
            } else {
                let development_extension_dir = components_dir
                    .parent()
                    .ok_or("无法确定开发扩展目录。")?
                    .join("browser-extension-development");
                materialize_embedded_extension(&development_extension_dir)?
            };
            let source_browser = read_configured_source_browser(&components_dir);
            app.manage(AppState {
                db: Mutex::new(connection),
                db_path: database_path,
                bridge_inbox,
                components_dir,
                extension_dir,
                downloads_dir: Mutex::new(downloads_dir),
                downloads_config_path,
                component_installing: AtomicBool::new(false),
                component_cancel_requested: AtomicBool::new(false),
                component_install_phase: AtomicU8::new(0),
                component_install_progress: AtomicU8::new(0),
                active_downloads: Arc::new(Mutex::new(HashMap::new())),
                queued_downloads: Arc::new(Mutex::new(HashMap::new())),
                active_processing: Arc::new(Mutex::new(HashMap::new())),
                queued_processing: Arc::new(Mutex::new(HashMap::new())),
                source_browser: Mutex::new(source_browser),
                source_login: Mutex::new(None),
                allow_exit: AtomicBool::new(false),
            });
            // Keep both the Chrome Web Store and local-development extension IDs
            // registered whenever the desktop app starts. A missing sidecar should
            // not prevent the rest of the desktop application from opening.
            let bridge_state = app.state::<AppState>();
            if let Err(error) = register_extension_bridge(&bridge_state) {
                eprintln!("ClipCargo browser bridge registration skipped: {error}");
            }
            let menu = MenuBuilder::new(app)
                .text("show-main", "打开 ClipCargo")
                .separator()
                .text("quit", "退出（停止任务）")
                .build()?;
            let tray = TrayIconBuilder::with_id("clipcargo-tray")
                .menu(&menu)
                .tooltip("ClipCargo")
                .show_menu_on_left_click(true);
            let tray = if let Some(icon) = app.default_window_icon().cloned() {
                tray.icon(icon)
            } else {
                tray
            };
            tray.on_menu_event(|app, event| {
                if event.id() == "show-main" {
                    show_main_window(app);
                } else if event.id() == "quit" {
                    stop_tasks_and_exit(app.clone());
                }
            })
            .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if !state.allow_exit.load(Ordering::Acquire) {
                    if task_shutdown_complete(&state) {
                        if let Ok(mut source_login) = state.source_login.lock() {
                            if let Some(mut session) = source_login.take() {
                                terminate_child_tree(&mut session.child);
                                let _ = session.child.wait();
                            }
                        }
                        state.allow_exit.store(true, Ordering::Release);
                        window.app_handle().exit(0);
                    } else {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_inbox,
            list_projects,
            create_project,
            rename_project,
            delete_project,
            capture_page,
            remove_inbox_item,
            move_inbox_items,
            update_inbox_details,
            open_source_page,
            bridge_status,
            component_status,
            component_install_status,
            install_yt_dlp,
            install_ffmpeg,
            install_deno,
            cancel_component_install,
            remove_component,
            source_auth_status,
            set_source_browser,
            open_source_login,
            finish_source_login,
            resolve_inbox_item,
            list_download_jobs,
            download_inbox_item,
            resume_download,
            retry_download,
            pause_download,
            cancel_download,
            import_local_media,
            inspect_local_media,
            relink_media,
            open_media_external,
            reveal_media,
            list_video_editors,
            import_media_to_editor,
            import_asset_package_to_editor,
            open_asset_package,
            open_components_directory,
            open_downloads_directory,
            set_downloads_directory,
            open_extension_directory,
            get_media_path,
            get_media_subtitles,
            remove_media_from_library,
            media_removal_impact,
            trash_media,
            update_media_details,
            list_media_derivatives,
            process_media,
            retry_processing,
            cancel_processing
        ])
        .run(tauri::generate_context!())
        .expect("ClipCargo failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_editor_registry_commands_without_losing_spaces() {
        assert_eq!(
            executable_from_registry_value(r#""D:\Apps\剪映专业版\JianyingPro.exe" "%1""#),
            Some(PathBuf::from(r"D:\Apps\剪映专业版\JianyingPro.exe"))
        );
        assert_eq!(
            editor_import_argument(&PathBuf::from(r"D:\素材\带 空格.mp4")),
            r"-open-file=D:\素材\带 空格.mp4"
        );
    }

    #[test]
    #[ignore = "requires Jianying Pro to be installed on the Windows test machine"]
    fn detects_an_installed_jianying_editor() {
        let editors = discover_video_editors();
        let editor = editors
            .iter()
            .find(|editor| editor.id == "jianying-pro")
            .expect("Jianying Pro was not detected");
        assert!(PathBuf::from(&editor.executable).is_file());
        assert!(editor.executable.ends_with("JianyingPro.exe"));
    }

    #[test]
    fn explains_windows_smart_app_control_blocks() {
        let error = std::io::Error::from_raw_os_error(4551);
        let message = external_tool_start_error("下载引擎", &error);
        assert!(message.contains("Windows 智能应用控制"));
        assert!(message.contains("重启电脑"));

        let ordinary = external_tool_start_error("FFmpeg", &std::io::Error::from_raw_os_error(2));
        assert!(ordinary.starts_with("无法启动FFmpeg"));
    }

    #[test]
    fn recognizes_vimeo_logged_in_requirements_as_authentication() {
        let message = resolver_error(
            b"ERROR: The web client only works when logged-in. Use --cookies or --username and --password to provide account credentials.",
        );
        assert!(message.contains("独立登录窗口"));
        assert_eq!(task_error_code(&message, false), "AUTH_REQUIRED");
    }

    #[test]
    fn persists_and_really_clears_isolated_browser_login_data() {
        let root = std::env::temp_dir().join(format!(
            "clipcargo-source-login-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let components = root.join("components");
        let cookie_database = root
            .join("login-profiles")
            .join("chrome")
            .join("Default")
            .join("Network")
            .join("Cookies");
        fs::create_dir_all(cookie_database.parent().unwrap()).unwrap();
        fs::create_dir_all(&components).unwrap();
        fs::write(&cookie_database, b"isolated-cookie-database").unwrap();

        save_configured_source_browser(&components, "chrome").unwrap();
        let restored = read_configured_source_browser(&components).unwrap();
        assert!(restored.starts_with("chrome:"));
        assert!(restored.contains("login-profiles"));

        clear_configured_source_browser(&components).unwrap();
        assert!(read_configured_source_browser(&components).is_none());
        assert!(!root.join("login-profiles").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_and_canonicalizes_a_missing_directory_before_opening_it() {
        let root =
            std::env::temp_dir().join(format!("clipcargo-open-directory-{}", new_request_id()));
        let directory = root.join("components");
        assert!(!directory.exists());
        let prepared = prepare_directory_for_open(&directory, "测试").unwrap();
        assert!(prepared.is_absolute());
        assert!(prepared.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recreates_a_complete_browser_extension_after_its_directory_was_removed() {
        let root = std::env::temp_dir().join(format!(
            "clipcargo-extension-directory-{}",
            new_request_id()
        ));
        let directory = root.join("browser-extension");
        assert!(!directory.exists());
        let prepared = materialize_embedded_extension(&directory).unwrap();
        assert!(prepared.is_absolute());
        for (relative, content) in EMBEDDED_EXTENSION_FILES {
            let file = prepared.join(relative);
            assert!(
                file.is_file(),
                "missing embedded extension file: {relative}"
            );
            assert_eq!(fs::read(file).unwrap(), content);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_the_embedded_extension_package_version() {
        let root = std::env::temp_dir().join(format!(
            "clipcargo-extension-version-{}",
            new_request_id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("manifest.json"), r#"{"version":"0.1.6"}"#).unwrap();
        assert_eq!(extension_package_version(&root).as_deref(), Some("0.1.6"));
        fs::write(root.join("manifest.json"), b"not-json").unwrap();
        assert_eq!(extension_package_version(&root), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_structured_task_error_columns_and_codes() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        for table in ["download_jobs", "media_derivatives"] {
            let mut statement = connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap();
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(columns.iter().any(|column| column == "error_code"));
        }
        assert_eq!(task_error_code("登录授权已失效", false), "AUTH_REQUIRED");
        assert_eq!(
            task_error_code(
                "Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies",
                false
            ),
            "AUTH_REQUIRED"
        );
        assert_eq!(task_error_code("HTTP error 429", false), "RATE_LIMITED");
        assert_eq!(task_error_code("输出校验未通过", true), "OUTPUT_INVALID");
        assert_eq!(task_error_code("编码器异常退出", true), "PROCESS_FAILED");
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("waiting-component".into()),
                page_url: "https://example.com/waiting".into(),
                title: Some("waiting".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        connection
            .execute(
                "UPDATE inbox_items SET waiting_component=1 WHERE id=?1",
                params![capture.item.id],
            )
            .unwrap();
        assert_eq!(
            select_by_request_id(&connection, "waiting-component")
                .unwrap()
                .status,
            "waiting_component"
        );
    }

    #[test]
    fn extension_id_validation_accepts_only_chromium_ids() {
        assert_eq!(
            normalize_extension_id(" ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP ").unwrap(),
            "abcdefghijklmnopabcdefghijklmnop"
        );
        assert!(normalize_extension_id("abc").is_err());
        assert!(normalize_extension_id("qrstuvwxyzqrstuvwxyzqrstuvwxyzqr").is_err());
        assert!(normalize_extension_id("abcdefghijklmnopabcdefghijklmn0p").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn accepts_windows_media_paths_with_extended_prefix_and_case_differences() {
        let root = PathBuf::from(r"C:\Users\Moote\AppData\Local\net.clipcargo.desktop\downloads");
        let media = PathBuf::from(
            r"\\?\c:\users\moote\appdata\local\net.clipcargo.desktop\downloads\video.mp4",
        );
        let sibling = PathBuf::from(
            r"\\?\c:\users\moote\appdata\local\net.clipcargo.desktop\downloads-old\video.mp4",
        );
        assert!(path_is_within_root(&media, &root));
        assert!(!path_is_within_root(&sibling, &root));
        let traversal = root.join("..").join("outside.mp4");
        assert!(traversal
            .components()
            .any(|component| matches!(component, Component::ParentDir)));
    }

    #[test]
    fn reads_only_a_valid_allowed_extension_origin_from_manifest() {
        let directory =
            std::env::temp_dir().join(format!("clipcargo-bridge-manifest-{}", new_request_id()));
        fs::create_dir_all(&directory).unwrap();
        let manifest = directory.join("host.json");
        fs::write(
            &manifest,
            br#"{"allowed_origins":["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]}"#,
        )
        .unwrap();
        assert_eq!(
            extension_ids_from_manifest(&manifest),
            vec!["abcdefghijklmnopabcdefghijklmnop"]
        );
        fs::write(
            &manifest,
            br#"{"allowed_origins":["https://example.com/"]}"#,
        )
        .unwrap();
        assert!(extension_ids_from_manifest(&manifest).is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn source_format_selectors_do_not_force_mp4_codecs() {
        assert_eq!(
            source_format_selector_for_quality("best").unwrap(),
            "bv*+ba/b"
        );
        assert!(source_format_selector_for_quality("1080")
            .unwrap()
            .contains("height<=1080"));
        assert!(source_format_selector_for_quality("720")
            .unwrap()
            .contains("height<=720"));
        assert!(source_format_selector_for_quality("2160")
            .unwrap()
            .contains("height<=2160"));
        assert!(source_format_selector_for_quality("9000").is_err());
        assert_eq!(exact_format_selector("30080").unwrap(), "30080+ba/30080/b");
        assert!(exact_format_selector("30080/evil").is_err());
    }

    #[test]
    fn vertical_formats_use_the_short_edge_as_the_quality_label() {
        let metadata: ResolverOutput = serde_json::from_str(r#"{
          "formats":[
            {"format_id":"30080","ext":"mp4","vcodec":"avc1.640032","acodec":"none","width":1080,"height":1920},
            {"format_id":"30064","ext":"mp4","vcodec":"avc1.640028","acodec":"none","width":720,"height":1280},
            {"format_id":"100024","ext":"mp4","vcodec":"av01","acodec":"none","width":720,"height":1280}
          ]
        }"#).unwrap();
        let capabilities = resolver_capabilities(&metadata);
        assert_eq!(capabilities.max_height, Some(1080));
        assert_eq!(capabilities.available_heights, vec![1080, 720]);
        assert_eq!(
            capabilities
                .quality_format_ids
                .get(&1080)
                .map(String::as_str),
            Some("30080")
        );
        assert_eq!(
            capabilities
                .quality_format_ids
                .get(&720)
                .map(String::as_str),
            Some("30064")
        );
    }

    #[test]
    fn compatible_mp4_requires_h264_and_aac_when_audio_exists() {
        let h264_aac = br#"{"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac"}]}"#;
        assert_eq!(
            compatible_mp4_probe(h264_aac, "mp4").unwrap(),
            (true, true, true)
        );
        let h264_silent = br#"{"streams":[{"codec_type":"video","codec_name":"h264"}]}"#;
        assert_eq!(
            compatible_mp4_probe(h264_silent, "mp4").unwrap(),
            (true, false, true)
        );
        let vp9_opus = br#"{"streams":[{"codec_type":"video","codec_name":"vp9"},{"codec_type":"audio","codec_name":"opus"}]}"#;
        assert_eq!(
            compatible_mp4_probe(vp9_opus, "webm").unwrap(),
            (true, true, false)
        );
    }

    #[test]
    fn resolver_capabilities_describe_available_tracks_and_formats() {
        let metadata: ResolverOutput = serde_json::from_str(r#"{
          "id":"demo", "title":"Demo", "subtitles":{"en":[{}],"zh-Hans":[{}]}, "automatic_captions":{"en":[{}]}, "formats":[
            {"format_id":"v1080","ext":"mp4","vcodec":"avc1.640028","acodec":"none","width":1920,"height":1080},
            {"format_id":"audio","ext":"m4a","vcodec":"none","acodec":"mp4a.40.2"},
            {"format_id":"v720","ext":"webm","vcodec":"vp9","acodec":"opus","width":1280,"height":720}
          ]
        }"#).unwrap();
        assert_eq!(
            resolver_capabilities(&metadata),
            ResolverCapabilities {
                has_video: true,
                has_audio: true,
                max_height: Some(1080),
                available_heights: vec![1080, 720],
                quality_format_ids: BTreeMap::from([(720, "v720".into()), (1080, "v1080".into()),]),
                compatible_mp4: true,
            }
        );
        assert_eq!(
            resolver_subtitle_options(&metadata),
            vec![
                SubtitleOption {
                    language: "zh-Hans".into(),
                    automatic: false
                },
                SubtitleOption {
                    language: "en".into(),
                    automatic: false
                },
                SubtitleOption {
                    language: "en".into(),
                    automatic: true
                },
            ]
        );
        let audio_only: ResolverOutput = serde_json::from_str(
            r#"{"formats":[{"ext":"m4a","vcodec":"none","acodec":"mp4a.40.2"}]}"#,
        )
        .unwrap();
        assert_eq!(
            resolver_capabilities(&audio_only),
            ResolverCapabilities {
                has_video: false,
                has_audio: true,
                max_height: None,
                available_heights: vec![],
                quality_format_ids: BTreeMap::new(),
                compatible_mp4: false,
            }
        );
        let codec_unknown_mp4: ResolverOutput =
            serde_json::from_str(r#"{"ext":"mp4","duration":125}"#).unwrap();
        assert_eq!(
            resolver_capabilities(&codec_unknown_mp4),
            ResolverCapabilities {
                has_video: true,
                has_audio: true,
                max_height: None,
                available_heights: vec![],
                quality_format_ids: BTreeMap::new(),
                compatible_mp4: false,
            }
        );
    }

    #[test]
    fn backend_rejects_impossible_output_presets() {
        validate_download_capabilities("audio", Some(true), Some(true)).unwrap();
        validate_download_capabilities("video", Some(true), Some(false)).unwrap();
        validate_download_capabilities("package", Some(true), Some(true)).unwrap();
        validate_download_capabilities("audio", None, None).unwrap();
        assert!(
            validate_download_capabilities("audio", Some(true), Some(false))
                .unwrap_err()
                .contains("音轨")
        );
        assert!(
            validate_download_capabilities("package", Some(true), Some(false))
                .unwrap_err()
                .contains("音轨")
        );
        assert!(
            validate_download_capabilities("video", Some(false), Some(true))
                .unwrap_err()
                .contains("视频轨")
        );
    }

    #[test]
    fn source_record_contains_safe_stable_metadata_only() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-source-record-{}", new_request_id()));
        let video_dir = test_dir.join("video");
        fs::create_dir_all(&video_dir).unwrap();
        let media = video_dir.join("sample.mp4");
        fs::write(&media, b"media").unwrap();
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("source-record".into()),
                page_url: "https://example.com/watch/1".into(),
                title: Some("来源标题".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        connection.execute(
            "INSERT INTO download_jobs(item_id,status,file_path,quality,output_preset,created_at,updated_at) VALUES(?1,'completed',?2,'1080','video',1,1)",
            params![capture.item.id, media.to_string_lossy()],
        ).unwrap();
        let record_path = write_source_record(&connection, 1, &media).unwrap();
        assert_eq!(record_path, test_dir.join("metadata.json"));
        let raw = fs::read_to_string(record_path).unwrap();
        let record: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(record["pageUrl"], "https://example.com/watch/1");
        assert_eq!(record["outputPreset"], "video");
        for forbidden in ["cookies", "authorization", "mediaUrl", "proxyPassword"] {
            assert!(record.get(forbidden).is_none());
        }
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn rejects_local_network_urls() {
        for url in [
            "http://localhost/video",
            "http://127.0.0.1/video",
            "http://192.168.1.2/video",
        ] {
            assert!(validate_page_url(url).is_err(), "{url} should be blocked");
        }
    }

    #[test]
    fn classifies_non_public_resolved_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.2",
            "192.168.1.2",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                is_non_public_ip(ip.parse().unwrap()),
                "{ip} should be blocked"
            );
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(
                !is_non_public_ip(ip.parse().unwrap()),
                "{ip} should be public"
            );
        }
    }

    #[test]
    fn preserves_share_link_access_parameters() {
        let raw =
            "https://www.xiaohongshu.com/explore/abc123?xsec_token=ABc%2F123&xsec_source=pc_search";
        let (validated, host) = validate_page_url(raw).unwrap();
        assert_eq!(host, "www.xiaohongshu.com");
        assert!(validated.contains("xsec_token=ABc%2F123"));
        assert!(validated.contains("xsec_source=pc_search"));
    }

    #[test]
    fn capture_is_idempotent() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let create = || CaptureInput {
            request_id: Some("request-1".into()),
            page_url: "https://www.youtube.com/watch?v=example".into(),
            title: Some("示例".into()),
            project_name: Some("旅行素材".into()),
            capture_method: Some("extension".into()),
        };
        assert!(!insert_capture(&connection, create()).unwrap().duplicate);
        assert!(insert_capture(&connection, create()).unwrap().duplicate);
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM inbox_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn deduplicates_same_url_within_project_but_allows_another_project() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let capture = |request_id: &str, project_name: &str| CaptureInput {
            request_id: Some(request_id.into()),
            page_url: "https://example.com/watch?id=1".into(),
            title: Some("示例".into()),
            project_name: Some(project_name.into()),
            capture_method: Some("paste".into()),
        };
        let first = insert_capture(&connection, capture("one", "项目甲")).unwrap();
        let duplicate = insert_capture(&connection, capture("two", "项目甲")).unwrap();
        let another_project = insert_capture(&connection, capture("three", "项目乙")).unwrap();
        assert!(!first.duplicate);
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.item.id, first.item.id);
        assert!(!another_project.duplicate);
        assert_ne!(another_project.item.id, first.item.id);
    }

    #[test]
    fn manages_projects_without_deleting_content() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        create_project_record(&connection, "客户甲").unwrap();
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("project-lifecycle".into()),
                page_url: "https://example.com/project-video".into(),
                title: Some("项目素材".into()),
                project_name: Some("客户甲".into()),
                capture_method: Some("paste".into()),
            },
        )
        .unwrap();
        rename_project_record(&mut connection, "客户甲", "客户乙").unwrap();
        let renamed: String = connection
            .query_row(
                "SELECT project_name FROM inbox_items WHERE id=?1",
                params![capture.item.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(renamed, "客户乙");
        delete_project_record(&mut connection, "客户乙").unwrap();
        let fallback: String = connection
            .query_row(
                "SELECT project_name FROM inbox_items WHERE id=?1",
                params![capture.item.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fallback, "未分类");
        let remaining: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM inbox_items WHERE id=?1",
                params![capture.item.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 1);
        assert!(delete_project_record(&mut connection, "未分类").is_err());
    }

    #[test]
    fn moves_selected_inbox_items_atomically() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        create_project_record(&connection, "目标项目").unwrap();
        let first = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("batch-move-one".into()),
                page_url: "https://example.com/one".into(),
                title: Some("一".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        let second = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("batch-move-two".into()),
                page_url: "https://example.com/two".into(),
                title: Some("二".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        assert_eq!(
            move_inbox_records(
                &mut connection,
                &[first.item.id, second.item.id],
                "目标项目"
            )
            .unwrap(),
            2
        );
        let moved: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM inbox_items WHERE project_name='目标项目'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(moved, 2);
        assert!(move_inbox_records(&mut connection, &[first.item.id, 999_999], "未分类").is_err());
        let still_moved: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM inbox_items WHERE project_name='目标项目'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_moved, 2);
    }

    #[test]
    fn removing_media_from_library_keeps_the_physical_file() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-library-remove-{}", new_request_id()));
        fs::create_dir_all(&test_dir).unwrap();
        let media = test_dir.join("kept.mp4");
        fs::write(&media, b"\0\0\0\x18ftypisomkept-media").unwrap();
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("library-remove".into()),
                page_url: "https://example.com/kept".into(),
                title: Some("保留文件".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        connection.execute(
            "INSERT INTO download_jobs(item_id,status,file_path,created_at,updated_at) VALUES(?1,'completed',?2,1,1)",
            params![capture.item.id, media.to_string_lossy()],
        ).unwrap();
        remove_media_from_library_record(&connection, "original", 1).unwrap();
        let hidden: i64 = connection
            .query_row(
                "SELECT library_hidden FROM download_jobs WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hidden, 1);
        assert!(media.is_file());
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn removes_only_files_owned_by_the_selected_component() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-component-remove-{}", new_request_id()));
        fs::create_dir_all(&test_dir).unwrap();
        for name in [
            "yt-dlp.exe",
            "yt-dlp.manifest.json",
            "yt-dlp-NOTICE.txt",
            "deno.exe",
            "user-note.txt",
        ] {
            fs::write(test_dir.join(name), b"test").unwrap();
        }
        assert_eq!(remove_component_files(&test_dir, "yt-dlp").unwrap(), 3);
        assert!(!test_dir.join("yt-dlp.exe").exists());
        assert!(test_dir.join("deno.exe").is_file());
        assert!(test_dir.join("user-note.txt").is_file());
        assert!(remove_component_files(&test_dir, "unknown").is_err());
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn activates_and_rolls_back_ffmpeg_as_one_group() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-component-group-{}", new_request_id()));
        fs::create_dir_all(&test_dir).unwrap();
        let names = ["ffmpeg.exe", "ffprobe.exe"];
        for name in names {
            fs::write(test_dir.join(name), format!("old-{name}")).unwrap();
            fs::write(test_dir.join(format!("{name}.new")), format!("new-{name}")).unwrap();
        }
        activate_component_group(&test_dir, &names).unwrap();
        assert_eq!(
            fs::read_to_string(test_dir.join("ffmpeg.exe")).unwrap(),
            "new-ffmpeg.exe"
        );
        assert_eq!(
            fs::read_to_string(test_dir.join("ffprobe.exe")).unwrap(),
            "new-ffprobe.exe"
        );
        rollback_component_group(&test_dir, &names);
        assert_eq!(
            fs::read_to_string(test_dir.join("ffmpeg.exe")).unwrap(),
            "old-ffmpeg.exe"
        );
        assert_eq!(
            fs::read_to_string(test_dir.join("ffprobe.exe")).unwrap(),
            "old-ffprobe.exe"
        );

        fs::write(test_dir.join("ffmpeg.exe.new"), b"next-ffmpeg").unwrap();
        assert!(activate_component_group(&test_dir, &names).is_err());
        assert_eq!(
            fs::read_to_string(test_dir.join("ffmpeg.exe")).unwrap(),
            "old-ffmpeg.exe"
        );
        assert_eq!(
            fs::read_to_string(test_dir.join("ffprobe.exe")).unwrap(),
            "old-ffprobe.exe"
        );
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn renames_media_without_losing_source_title_and_moves_its_project() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        create_project_record(&connection, "新项目").unwrap();
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("media-details".into()),
                page_url: "https://example.com/details".into(),
                title: Some("来源原始标题".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        connection.execute("INSERT INTO download_jobs(item_id,status,file_path,created_at,updated_at) VALUES(?1,'completed','missing.mp4',1,1)", params![capture.item.id]).unwrap();
        update_media_details_record(&connection, "original", 1, "我的展示名称", "新项目").unwrap();
        let (source_title, display_title, project): (String, String, String) = connection.query_row(
            "SELECT i.title,j.display_title,i.project_name FROM download_jobs j JOIN inbox_items i ON i.id=j.item_id WHERE j.id=1", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(source_title, "来源原始标题");
        assert_eq!(display_title, "我的展示名称");
        assert_eq!(project, "新项目");
        assert!(update_media_details_record(&connection, "original", 1, "", "新项目").is_err());
        assert!(update_media_details_record(&connection, "original", 1, "名称", "不存在").is_err());
    }

    #[test]
    fn rejects_overlong_page_urls() {
        let url = format!("https://example.com/{}", "x".repeat(8192));
        assert!(validate_page_url(&url).unwrap_err().contains("8192"));
    }

    #[test]
    fn reads_windows_checksum_entry() {
        let checksums = "aaaa  yt-dlp\n66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a  yt-dlp.exe\n";
        assert_eq!(
            expected_yt_dlp_hash(checksums).unwrap(),
            "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"
        );
    }

    #[test]
    fn rejects_missing_or_malformed_checksum_entry() {
        assert!(expected_yt_dlp_hash("aaaa  yt-dlp").is_err());
        assert!(expected_yt_dlp_hash("not-a-hash  yt-dlp.exe").is_err());
    }

    #[test]
    fn reads_standalone_checksum() {
        assert_eq!(
            standalone_sha256(
                "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  archive.zip"
            )
            .unwrap(),
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        );
        assert!(standalone_sha256("not-a-checksum").is_err());
    }

    #[test]
    fn keeps_last_resolver_error_line() {
        let error = resolver_error(b"warning\nERROR: login required\n");
        assert!(error.contains("要求登录"));
        let generic = resolver_error(b"warning\nERROR: unknown failure\n");
        assert_eq!(generic, "ERROR: unknown failure");
        assert!(resolver_error(b"ERROR: HTTP Error 429: Too Many Requests").contains("限制请求"));
        assert!(resolver_error(b"ERROR: connection reset by peer").contains("网络连接"));
        assert!(resolver_error(b"ERROR: no space left on device").contains("磁盘空间不足"));
    }

    #[test]
    fn maps_download_quality_to_bounded_format_selectors() {
        let best = format_selector_for_quality("best").unwrap();
        assert!(best.contains("bv*+ba"));
        assert!(!best.contains("ext=mp4"));
        assert!(!best.contains("ext=m4a"));
        assert!(format_selector_for_quality("1080")
            .unwrap()
            .contains("height<=1080"));
        assert!(format_selector_for_quality("720")
            .unwrap()
            .contains("height<=720"));
        assert!(format_selector_for_quality("2160")
            .unwrap()
            .contains("height<=2160"));
        assert!(format_selector_for_quality("4k;rm -rf").is_err());
    }

    #[test]
    fn checks_available_space_before_media_work() {
        let temp = std::env::temp_dir();
        assert!(ensure_free_space(&temp, 0, "测试").is_ok());
        assert!(ensure_free_space(&temp, u64::MAX, "测试")
            .unwrap_err()
            .contains("磁盘空间不足"));
    }

    #[test]
    fn rejects_invalid_or_overlong_clip_ranges_before_creating_a_task() {
        assert_eq!(
            validate_clip_range(Some(2.0), Some(7.5), Some(10)).unwrap(),
            5.5
        );
        assert!(validate_clip_range(Some(5.0), Some(5.0), Some(10)).is_err());
        assert!(validate_clip_range(Some(-1.0), Some(2.0), Some(10)).is_err());
        assert!(validate_clip_range(Some(0.0), Some(10.1), Some(10))
            .unwrap_err()
            .contains("超过素材时长"));
        assert!(validate_clip_range(None, Some(2.0), Some(10)).is_err());
    }

    #[test]
    fn rejects_clip_outputs_with_large_duration_drift() {
        validate_clip_output_duration(1.5, 1.5).unwrap();
        validate_clip_output_duration(1.75, 1.733_333).unwrap();
        assert!(validate_clip_output_duration(1.5, 1.61)
            .unwrap_err()
            .contains("时长异常"));
        assert!(validate_clip_output_duration(1.5, 0.0)
            .unwrap_err()
            .contains("有效时长"));
    }

    #[test]
    fn reuses_matching_active_processing_task() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("processing-idempotency".into()),
                page_url: "https://example.com/video".into(),
                title: Some("processing".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        connection.execute(
            "INSERT INTO download_jobs(item_id,status,file_path,created_at,updated_at) VALUES(?1,'completed','C:\\ClipCargo\\source.mp4',1,1)",
            params![capture.item.id],
        ).unwrap();
        connection.execute(
            "INSERT INTO media_derivatives(parent_job_id,title,kind,status,start_seconds,end_seconds,created_at,updated_at) VALUES(1,'clip','clip','queued',1.5,4.5,1,1)",
            [],
        ).unwrap();

        assert_eq!(
            matching_active_derivative_id(
                &connection,
                1,
                "clip",
                Some(1.5),
                Some(4.5),
                None,
                None,
                None
            )
            .unwrap(),
            Some(1)
        );
        assert_eq!(
            matching_active_derivative_id(
                &connection,
                1,
                "clip",
                Some(0.0),
                Some(4.5),
                None,
                None,
                None
            )
            .unwrap(),
            None
        );
        assert_eq!(
            matching_active_derivative_id(&connection, 1, "convert", None, None, None, None, None)
                .unwrap(),
            None
        );
    }

    #[test]
    fn builds_bounded_crop_filter_from_preview_coordinates() {
        let filter = crop_filter(Some(0.25), Some(0.75), Some(1.4)).unwrap();
        assert!(filter.contains("(iw-ow)*0.2500"));
        assert!(filter.contains("(ih-oh)*0.7500"));
        assert!(filter.contains("/1.4000"));
        for invalid in [
            crop_filter(Some(-0.1), Some(0.5), Some(1.0)),
            crop_filter(Some(0.5), Some(1.1), Some(1.0)),
            crop_filter(Some(0.5), Some(0.5), Some(2.1)),
        ] {
            assert!(invalid.is_err());
        }
    }

    #[test]
    fn rejects_media_probe_results_without_required_tracks_or_duration() {
        let valid = br#"{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"3.25"}}"#;
        validate_probe_json(valid, true, true).unwrap();
        let audio_only = br#"{"streams":[{"codec_type":"audio"}],"format":{"duration":"3.25"}}"#;
        assert!(validate_probe_json(audio_only, true, false)
            .unwrap_err()
            .contains("视频轨"));
        let video_only = br#"{"streams":[{"codec_type":"video"}],"format":{"duration":"3.25"}}"#;
        assert!(validate_probe_json(video_only, false, true)
            .unwrap_err()
            .contains("音频轨"));
        let zero_duration = br#"{"streams":[{"codec_type":"video"}],"format":{"duration":"0.0"}}"#;
        assert!(validate_probe_json(zero_duration, true, false)
            .unwrap_err()
            .contains("有效时长"));
        assert!(validate_probe_json(b"not-json", true, false).is_err());
    }

    #[test]
    fn enforces_separate_download_and_processing_capacity_limits() {
        ensure_queue_capacity(0, 2, "下载").unwrap();
        ensure_queue_capacity(1, 2, "下载").unwrap();
        assert!(ensure_queue_capacity(2, 2, "下载")
            .unwrap_err()
            .contains("最多 2 个"));
        assert!(ensure_queue_capacity(1, 1, "媒体处理")
            .unwrap_err()
            .contains("最多 1 个"));
    }

    #[test]
    fn creates_and_restores_a_consistent_pre_migration_database_backup() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-db-backup-{}", new_request_id()));
        fs::create_dir_all(&test_dir).unwrap();
        let database_path = test_dir.join("clipcargo.sqlite3");
        let mut connection = Connection::open(&database_path).unwrap();
        connection.execute_batch("CREATE TABLE legacy_data(value TEXT NOT NULL); INSERT INTO legacy_data(value) VALUES('before'); PRAGMA user_version=0;").unwrap();
        let backup = prepare_database_backup(&connection, &database_path, true)
            .unwrap()
            .unwrap();
        assert!(backup.is_file());
        assert_eq!(
            prepare_database_backup(&connection, &database_path, true).unwrap(),
            Some(backup.clone())
        );
        connection
            .execute("UPDATE legacy_data SET value='after'", [])
            .unwrap();
        restore_database_backup(&mut connection, &backup).unwrap();
        let value: String = connection
            .query_row("SELECT value FROM legacy_data", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "before");
        drop(connection);
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn queue_claims_tasks_in_fifo_order_and_respects_capacity() {
        let mut active = HashMap::new();
        let mut queued = HashMap::new();
        for id in [12_i64, 10, 11] {
            queued.insert(id, Arc::new(AtomicBool::new(false)));
        }
        assert!(!try_claim_queued_task(&mut active, &mut queued, 12, 2));
        assert!(try_claim_queued_task(&mut active, &mut queued, 10, 2));
        assert!(try_claim_queued_task(&mut active, &mut queued, 11, 2));
        assert!(!try_claim_queued_task(&mut active, &mut queued, 12, 2));
        active.remove(&10);
        assert!(try_claim_queued_task(&mut active, &mut queued, 12, 2));
    }

    #[test]
    fn discovers_only_matching_sidecar_subtitles() {
        let directory =
            std::env::temp_dir().join(format!("clipcargo-subtitles-{}", new_request_id()));
        fs::create_dir_all(&directory).unwrap();
        let media = directory.join("sample.video.mp4");
        fs::write(&media, b"media").unwrap();
        fs::write(directory.join("sample.video.zh-Hans.vtt"), b"WEBVTT").unwrap();
        fs::write(directory.join("sample.video.en.srt"), b"1").unwrap();
        fs::write(directory.join("another.zh.vtt"), b"WEBVTT").unwrap();
        fs::write(directory.join("sample.video.notes.txt"), b"notes").unwrap();
        let tracks = discover_sidecar_subtitles(&media).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].language, "en");
        assert_eq!(tracks[1].language, "zh-Hans");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn finds_retained_audio_source_with_matching_stem() {
        let directory =
            std::env::temp_dir().join(format!("clipcargo-retained-source-{}", new_request_id()));
        fs::create_dir_all(&directory).unwrap();
        let audio = directory.join("sample [id].mp3");
        let source = directory.join("sample [id].webm");
        fs::write(&audio, b"audio").unwrap();
        fs::write(&source, b"source").unwrap();
        fs::write(directory.join("sample [id].jpg"), b"cover").unwrap();
        fs::write(directory.join("unrelated.mp4"), b"other").unwrap();
        assert_eq!(find_retained_audio_source(&audio).unwrap(), Some(source));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn finds_only_matching_cover_sidecars() {
        let directory =
            std::env::temp_dir().join(format!("clipcargo-cover-sidecar-{}", new_request_id()));
        fs::create_dir_all(&directory).unwrap();
        let media = directory.join("sample.video.mp4");
        fs::write(&media, b"media").unwrap();
        fs::write(directory.join("other.webp"), b"cover").unwrap();
        assert!(!has_cover_sidecar(&media));
        fs::write(directory.join("sample.video.webp"), b"cover").unwrap();
        assert!(has_cover_sidecar(&media));
        assert_eq!(
            cover_data_url(&directory.join("sample.video.webp")).unwrap(),
            "data:image/webp;base64,Y292ZXI="
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn builds_stable_windows_safe_asset_package_folders() {
        let root = PathBuf::from(r"C:\ClipCargo\素材");
        assert_eq!(
            asset_package_directory(&root, "标题: 含/非法*字符. ", Some("BV:123"), 9),
            root.join("标题_ 含_非法_字符 [BV_123]")
        );
        assert_eq!(
            asset_package_directory(&root, "CON", None, 9),
            root.join("_CON [item-9]")
        );
    }

    #[test]
    fn discovers_organized_subtitles_and_cover_beside_a_video_folder() {
        let root =
            std::env::temp_dir().join(format!("clipcargo-organized-package-{}", new_request_id()));
        let video_dir = root.join("video");
        let subtitle_dir = root.join("subtitles");
        let image_dir = root.join("images");
        fs::create_dir_all(&video_dir).unwrap();
        fs::create_dir_all(&subtitle_dir).unwrap();
        fs::create_dir_all(&image_dir).unwrap();
        let media = video_dir.join("sample.video.mp4");
        fs::write(&media, b"media").unwrap();
        fs::write(subtitle_dir.join("sample.video.zh-Hans.vtt"), b"WEBVTT").unwrap();
        fs::write(image_dir.join("sample.video.webp"), b"cover").unwrap();
        let tracks = discover_sidecar_subtitles(&media).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].language, "zh-Hans");
        assert_eq!(
            cover_sidecar_path(&media),
            Some(image_dir.join("sample.video.webp"))
        );
        assert_eq!(asset_sidecar_counts(&media), (1, 1));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archives_downloaded_sidecars_by_material_type() {
        let root =
            std::env::temp_dir().join(format!("clipcargo-archive-sidecars-{}", new_request_id()));
        let video_dir = root.join("video");
        fs::create_dir_all(&video_dir).unwrap();
        let media = video_dir.join("sample.video.mp4");
        fs::write(&media, b"media").unwrap();
        fs::write(video_dir.join("sample.video.jpg"), b"cover").unwrap();
        fs::write(video_dir.join("sample.video.zh-Hans.vtt"), b"WEBVTT").unwrap();
        fs::write(video_dir.join("unrelated.jpg"), b"other").unwrap();

        archive_download_sidecars(&media, &root).unwrap();

        assert!(root.join("images/sample.video.jpg").is_file());
        assert!(root.join("subtitles/sample.video.zh-Hans.vtt").is_file());
        assert!(video_dir.join("unrelated.jpg").is_file());
        assert!(!video_dir.join("sample.video.jpg").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrates_existing_download_table_to_support_queued_status() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE inbox_items(id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,page_url TEXT NOT NULL,title TEXT NOT NULL,source_host TEXT NOT NULL,project_name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('captured','resolving','ready','failed')),capture_method TEXT NOT NULL,created_at INTEGER NOT NULL);
             CREATE TABLE download_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,item_id INTEGER NOT NULL UNIQUE REFERENCES inbox_items(id) ON DELETE CASCADE,status TEXT NOT NULL CHECK(status IN ('downloading','completed','failed')),file_path TEXT,error_message TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
             CREATE TABLE media_derivatives(id INTEGER PRIMARY KEY AUTOINCREMENT,parent_job_id INTEGER NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('convert','clip','audio','crop-vertical')),status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),file_path TEXT,error_message TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
             INSERT INTO inbox_items(request_id,page_url,title,source_host,project_name,status,capture_method,created_at) VALUES('old','https://example.com/old','old','example.com','未分类','ready','manual',1);
             INSERT INTO download_jobs(item_id,status,created_at,updated_at) VALUES(1,'completed',1,1);"
        ).unwrap();
        initialize_database(&connection).unwrap();
        connection.execute("INSERT INTO inbox_items(request_id,page_url,title,source_host,project_name,status,capture_method,created_at) VALUES('new','https://example.com/new','new','example.com','未分类','ready','manual',2)", []).unwrap();
        connection.execute("INSERT INTO download_jobs(item_id,status,created_at,updated_at) VALUES(2,'queued',2,2)", []).unwrap();
        connection
            .execute(
                "UPDATE download_jobs SET status='paused' WHERE item_id=2",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO media_derivatives(parent_job_id,title,kind,status,created_at,updated_at) VALUES(1,'queued','convert','queued',2,2)", []).unwrap();
        let preserved: String = connection
            .query_row(
                "SELECT status FROM download_jobs WHERE item_id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let paused: String = connection
            .query_row(
                "SELECT status FROM download_jobs WHERE item_id=2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let stage: String = connection
            .query_row(
                "SELECT stage FROM download_jobs WHERE item_id=2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, "completed");
        assert_eq!(paused, "paused");
        assert_eq!(stage, "queued");
        let queued_derivative: String = connection
            .query_row(
                "SELECT status FROM media_derivatives WHERE parent_job_id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_derivative, "queued");
        connection.execute("INSERT INTO media_derivatives(parent_job_id,title,kind,status,created_at,updated_at) VALUES(1,'source','source','completed',2,2)", []).unwrap();
        assert!(connection.execute("INSERT INTO media_derivatives(parent_job_id,title,kind,status,created_at,updated_at) VALUES(1,'duplicate','source','completed',2,2)", []).is_err());
        let violations: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn imports_local_media_into_managed_library() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-local-import-{}", new_request_id()));
        let downloads = test_dir.join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        let source = test_dir.join("sample.mp4");
        fs::write(&source, b"\0\0\0\x18ftypisomtest-media").unwrap();
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let too_many = vec![source.to_string_lossy().to_string(); 101];
        assert!(import_local_media_records(
            &mut connection,
            &downloads,
            too_many,
            "未分类".into(),
            "copy"
        )
        .unwrap_err()
        .contains("最多导入 100"));
        let jobs = import_local_media_records(
            &mut connection,
            &downloads,
            vec![source.to_string_lossy().to_string()],
            "本地项目".into(),
            "copy",
        )
        .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, "completed");
        assert_eq!(jobs[0].quality, "local");
        assert!(PathBuf::from(jobs[0].file_path.as_ref().unwrap()).is_file());
        let project: String = connection
            .query_row(
                "SELECT project_name FROM inbox_items WHERE id=?1",
                params![jobs[0].item_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project, "本地项目");
        let referenced = import_local_media_records(
            &mut connection,
            &downloads,
            vec![source.to_string_lossy().to_string()],
            "未分类".into(),
            "reference",
        )
        .unwrap();
        assert_eq!(
            PathBuf::from(referenced[0].file_path.as_ref().unwrap()),
            source.canonicalize().unwrap()
        );
        assert!(!referenced[0].managed_file);
        assert_eq!(
            validated_media_path(&connection, &downloads, referenced[0].id).unwrap(),
            source.canonicalize().unwrap()
        );
        let unsupported = test_dir.join("notes.txt");
        fs::write(&unsupported, b"not media").unwrap();
        assert!(import_local_media_records(
            &mut connection,
            &downloads,
            vec![unsupported.to_string_lossy().to_string()],
            "x".into(),
            "copy"
        )
        .is_err());
        let disguised = test_dir.join("fake.mp4");
        fs::write(&disguised, b"plain text pretending to be video").unwrap();
        let error = import_local_media_records(
            &mut connection,
            &downloads,
            vec![disguised.to_string_lossy().to_string()],
            "x".into(),
            "copy",
        )
        .unwrap_err();
        assert!(error.contains("内容与 .mp4"));
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn rolls_back_an_entire_local_import_batch() {
        let test_dir = std::env::temp_dir().join(format!(
            "clipcargo-local-import-rollback-{}",
            new_request_id()
        ));
        let downloads = test_dir.join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        let valid = test_dir.join("valid.mp4");
        let invalid = test_dir.join("invalid.txt");
        fs::write(&valid, b"\0\0\0\x18ftypisomvalid-media").unwrap();
        fs::write(&invalid, b"not media").unwrap();
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let error = import_local_media_records(
            &mut connection,
            &downloads,
            vec![
                valid.to_string_lossy().to_string(),
                invalid.to_string_lossy().to_string(),
            ],
            "未分类".into(),
            "copy",
        )
        .unwrap_err();
        assert!(error.contains("不支持导入 .txt"));
        let inbox_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM inbox_items", [], |row| row.get(0))
            .unwrap();
        let job_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM download_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!((inbox_count, job_count), (0, 0));
        assert!(downloads.read_dir().unwrap().next().is_none());
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn relinks_missing_media_by_copying_a_valid_replacement() {
        let test_dir = std::env::temp_dir().join(format!("clipcargo-relink-{}", new_request_id()));
        let downloads = test_dir.join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        let original = test_dir.join("original.mp4");
        fs::write(&original, b"\0\0\0\x18ftypisomoriginal").unwrap();
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let jobs = import_local_media_records(
            &mut connection,
            &downloads,
            vec![original.to_string_lossy().to_string()],
            "未分类".into(),
            "copy",
        )
        .unwrap();
        let old_path = PathBuf::from(jobs[0].file_path.as_ref().unwrap());
        fs::remove_file(&old_path).unwrap();
        let replacement = test_dir.join("replacement.mp4");
        fs::write(&replacement, b"\0\0\0\x18ftypisomreplacement").unwrap();

        relink_media_record(
            &connection,
            &downloads,
            "original",
            jobs[0].id,
            &replacement.to_string_lossy(),
        )
        .unwrap();

        let new_path: String = connection
            .query_row(
                "SELECT file_path FROM download_jobs WHERE id=?1",
                params![jobs[0].id],
                |row| row.get(0),
            )
            .unwrap();
        let new_path = PathBuf::from(new_path);
        assert!(new_path.is_file());
        assert!(new_path.starts_with(&downloads));
        assert_ne!(new_path, replacement);
        let missing = test_dir.join("missing.mp4");
        assert!(relink_media_record(
            &connection,
            &downloads,
            "original",
            jobs[0].id,
            &missing.to_string_lossy()
        )
        .is_err());
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn relinks_external_reference_without_copying_or_changing_ownership() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-reference-relink-{}", new_request_id()));
        let downloads = test_dir.join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        let original = test_dir.join("original.mp4");
        fs::write(&original, b"\0\0\0\x18ftypisomoriginal").unwrap();
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let jobs = import_local_media_records(
            &mut connection,
            &downloads,
            vec![original.to_string_lossy().to_string()],
            "未分类".into(),
            "reference",
        )
        .unwrap();
        fs::remove_file(&original).unwrap();
        let replacement = test_dir.join("replacement.mp4");
        fs::write(&replacement, b"\0\0\0\x18ftypisomreplacement").unwrap();

        relink_media_record(
            &connection,
            &downloads,
            "original",
            jobs[0].id,
            &replacement.to_string_lossy(),
        )
        .unwrap();

        let (new_path, managed): (String, i64) = connection
            .query_row(
                "SELECT file_path,managed_file FROM download_jobs WHERE id=?1",
                params![jobs[0].id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(PathBuf::from(new_path), replacement.canonicalize().unwrap());
        assert_eq!(managed, 0);
        assert!(downloads.read_dir().unwrap().next().is_none());
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn refuses_media_outside_download_root() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("media-boundary".into()),
                page_url: "https://example.com/video".into(),
                title: Some("test".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        let outside = std::env::current_exe().unwrap();
        connection.execute("INSERT INTO download_jobs(item_id,status,file_path,created_at,updated_at) VALUES(?1,'completed',?2,1,1)", params![capture.item.id, outside.to_string_lossy()]).unwrap();
        let root = std::env::temp_dir().join("clipcargo-empty-download-root");
        fs::create_dir_all(&root).unwrap();
        assert!(validated_media_path(&connection, &root, 1).is_err());
        let _ = fs::remove_dir(root);
    }

    #[test]
    fn recovers_interrupted_jobs_on_startup() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-recovery-test-{}", new_request_id()));
        fs::create_dir_all(&test_dir).unwrap();
        let db_path = test_dir.join("recovery.sqlite3");
        {
            let connection = Connection::open(&db_path).unwrap();
            initialize_database(&connection).unwrap();
            let capture = insert_capture(
                &connection,
                CaptureInput {
                    request_id: Some("recovery".into()),
                    page_url: "https://example.com/video".into(),
                    title: Some("recovery".into()),
                    project_name: None,
                    capture_method: None,
                },
            )
            .unwrap();
            connection.execute("INSERT INTO download_jobs(item_id,status,created_at,updated_at) VALUES(?1,'downloading',1,1)", params![capture.item.id]).unwrap();
            let queued_capture = insert_capture(
                &connection,
                CaptureInput {
                    request_id: Some("recovery-queued".into()),
                    page_url: "https://example.com/queued".into(),
                    title: Some("queued".into()),
                    project_name: None,
                    capture_method: None,
                },
            )
            .unwrap();
            connection.execute("INSERT INTO download_jobs(item_id,status,created_at,updated_at) VALUES(?1,'queued',1,1)", params![queued_capture.item.id]).unwrap();
            let paused_capture = insert_capture(
                &connection,
                CaptureInput {
                    request_id: Some("recovery-paused".into()),
                    page_url: "https://example.com/paused".into(),
                    title: Some("paused".into()),
                    project_name: None,
                    capture_method: None,
                },
            )
            .unwrap();
            connection.execute("INSERT INTO download_jobs(item_id,status,stage,speed_bytes_per_second,eta_seconds,created_at,updated_at) VALUES(?1,'paused','paused',1024,9,1,1)", params![paused_capture.item.id]).unwrap();
            connection.execute("UPDATE download_jobs SET stage='downloading',speed_bytes_per_second=2048,eta_seconds=17 WHERE id=1", []).unwrap();
            connection.execute("INSERT INTO media_derivatives(parent_job_id,title,kind,status,created_at,updated_at) VALUES(1,'recovery','convert','processing',1,1)", []).unwrap();
            connection.execute("INSERT INTO media_derivatives(parent_job_id,title,kind,status,created_at,updated_at) VALUES(1,'queued','clip','queued',1,1)", []).unwrap();
        }
        let possible_output = derivative_output_path(&test_dir, 1, "convert");
        fs::write(&possible_output, b"possible completed output").unwrap();
        let connection = Connection::open(&db_path).unwrap();
        initialize_database(&connection).unwrap();
        recover_interrupted_jobs(
            &connection,
            &test_dir,
            &test_dir.join("missing-ffprobe.exe"),
        )
        .unwrap();
        let download: (String, String, String, Option<f64>, Option<i64>) = connection.query_row("SELECT status,error_message,stage,speed_bytes_per_second,eta_seconds FROM download_jobs WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).unwrap();
        let processing: (String, String) = connection
            .query_row(
                "SELECT status,error_message FROM media_derivatives WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let queued: (String, String) = connection
            .query_row(
                "SELECT status,error_message FROM download_jobs WHERE item_id=2",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let paused: (String, String, Option<f64>, Option<i64>) = connection.query_row("SELECT status,stage,speed_bytes_per_second,eta_seconds FROM download_jobs WHERE item_id=3", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap();
        let queued_processing: (String, String) = connection
            .query_row(
                "SELECT status,error_message FROM media_derivatives WHERE id=2",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(download.0, "failed");
        assert_eq!(processing.0, "failed");
        assert_eq!(queued.0, "failed");
        assert_eq!(download.2, "failed");
        assert_eq!(download.3, None);
        assert_eq!(download.4, None);
        assert_eq!(
            paused,
            ("paused".into(), "paused".into(), Some(1024.0), Some(9))
        );
        assert_eq!(queued_processing.0, "failed");
        assert!(download.1.contains("上次退出"));
        assert!(processing.1.contains("上次退出"));
        assert!(processing.1.contains("已保留"));
        assert!(queued.1.contains("上次退出"));
        assert!(queued_processing.1.contains("上次退出"));
        assert!(possible_output.is_file());
        drop(connection);
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn preserves_processing_recipe_for_failed_task_retry() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("processing-retry".into()),
                page_url: "https://example.com/retry".into(),
                title: Some("retry".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        connection.execute("INSERT INTO download_jobs(item_id,status,file_path,created_at,updated_at) VALUES(?1,'completed','retry.mp4',1,1)", params![capture.item.id]).unwrap();
        connection.execute("INSERT INTO media_derivatives(parent_job_id,title,kind,status,error_message,start_seconds,end_seconds,created_at,updated_at) VALUES(1,'clip retry','clip','failed','interrupted',1.25,4.75,1,1)", []).unwrap();
        let input = processing_retry_input(&connection, 1).unwrap();
        assert_eq!(input.job_id, 1);
        assert_eq!(input.mode, "clip");
        assert_eq!(input.start_seconds, Some(1.25));
        assert_eq!(input.end_seconds, Some(4.75));
        connection
            .execute(
                "UPDATE media_derivatives SET status='completed' WHERE id=1",
                [],
            )
            .unwrap();
        assert!(processing_retry_input(&connection, 1).is_err());
    }

    #[test]
    fn parses_numeric_download_telemetry_without_inventing_missing_values() {
        assert_eq!(
            parse_download_progress("download: 62.0%|65011712|104857600|3565158.25|11"),
            Some(DownloadProgress {
                percent: 62.0,
                downloaded_bytes: Some(65_011_712),
                total_bytes: Some(104_857_600),
                speed_bytes_per_second: Some(3_565_158.25),
                eta_seconds: Some(11),
            })
        );
        let missing = parse_download_progress("download: 8.5%|8912896|NA|NA|NA").unwrap();
        assert_eq!(missing.percent, 8.5);
        assert_eq!(missing.downloaded_bytes, Some(8_912_896));
        assert_eq!(missing.total_bytes, None);
        assert_eq!(missing.speed_bytes_per_second, None);
        assert_eq!(missing.eta_seconds, None);
        assert!(parse_download_progress("not-progress").is_none());
    }

    #[test]
    fn reads_only_tagged_download_output_paths() {
        assert_eq!(
            parse_download_output_path("clipcargo-file:C:\\Downloads\\video.mp4").as_deref(),
            Some("C:\\Downloads\\video.mp4")
        );
        assert!(
            parse_download_output_path("[FixupM3u8] Fixing MPEG-TS in MP4 container").is_none()
        );
        assert!(parse_download_output_path("clipcargo-file:   ").is_none());
    }

    #[test]
    fn recovers_an_existing_media_file_when_download_is_skipped() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-existing-download-{}", new_request_id()));
        fs::create_dir_all(&test_dir).unwrap();
        let download_started_at = SystemTime::now();
        let media = test_dir.join("Video title [BV1234567890].mp4");
        fs::write(&media, b"non-empty media placeholder").unwrap();
        fs::write(test_dir.join("Video title [BV1234567890].jpg"), b"cover").unwrap();
        let template = test_dir.join("%(title)s [%(id)s].%(ext)s");
        assert_eq!(
            existing_download_output(
                template.to_string_lossy().as_ref(),
                Some("BV1234567890"),
                download_started_at,
            ),
            Some(media)
        );
        assert_eq!(
            existing_download_output(
                template.to_string_lossy().as_ref(),
                None,
                download_started_at,
            ),
            Some(test_dir.join("Video title [BV1234567890].mp4"))
        );
        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn refuses_to_orphan_downloaded_media_when_removing_inbox_item() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let capture = insert_capture(
            &connection,
            CaptureInput {
                request_id: Some("linked-media".into()),
                page_url: "https://example.com/video".into(),
                title: Some("linked".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        connection.execute("INSERT INTO download_jobs(item_id,status,created_at,updated_at) VALUES(?1,'completed',1,1)", params![capture.item.id]).unwrap();
        assert!(remove_inbox_record(&connection, capture.item.id).is_err());
        let remaining: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM inbox_items WHERE id=?1",
                params![capture.item.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 1);
    }

    #[tokio::test]
    #[ignore = "downloads the current official yt-dlp Windows release"]
    async fn installs_verified_official_yt_dlp() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-component-test-{}", unix_seconds()));
        let result = install_yt_dlp_into(&test_dir).await.unwrap();
        assert!(!result.version.is_empty());
        assert_eq!(result.sha256.len(), 64);
        assert!(test_dir.join("yt-dlp.exe").is_file());
        assert!(test_dir.join("yt-dlp.manifest.json").is_file());
        assert!(test_dir.join("yt-dlp-NOTICE.txt").is_file());
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(test_dir.join("yt-dlp.manifest.json")).unwrap())
                .unwrap();
        assert_eq!(
            manifest["license"],
            "GPL-3.0-or-later (standalone Windows executable)"
        );
        assert!(manifest["sourceCode"]
            .as_str()
            .unwrap()
            .contains(&result.version));
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::Arc,
            thread,
            time::Duration,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = Arc::clone(&stop);
        let server = thread::spawn(move || {
            while !server_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0_u8; 2048];
                        let _ = stream.read(&mut request);
                        let body = b"\0\0\0\x0cftypisom";
                        let header = format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = stream.write_all(header.as_bytes());
                        let _ = stream.write_all(body);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
        });
        let template = test_dir
            .join("download.%(ext)s")
            .to_string_lossy()
            .to_string();
        let downloaded = execute_download(
            &test_dir.join("yt-dlp.exe"),
            &format!("http://{address}/sample.mp4"),
            &template,
        )
        .unwrap();
        assert!(PathBuf::from(downloaded).metadata().unwrap().len() > 0);
        stop.store(true, Ordering::Release);
        server.join().unwrap();
        let _ = fs::remove_dir_all(test_dir);
    }

    #[tokio::test]
    #[ignore = "downloads and validates the current FFmpeg Windows essentials build"]
    async fn installs_and_executes_verified_ffmpeg() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-ffmpeg-test-{}", new_request_id()));
        let result = install_ffmpeg_into(&test_dir).await.unwrap();
        assert_eq!(result.sha256.len(), 64);
        assert!(test_dir.join("ffmpeg.manifest.json").is_file());
        assert!(test_dir.join("FFmpeg-NOTICE.txt").is_file());
        assert!(
            test_dir
                .join("FFmpeg-LICENSE.txt")
                .metadata()
                .unwrap()
                .len()
                > 1000
        );
        assert!(test_dir.join("FFmpeg-README.txt").metadata().unwrap().len() > 100);
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(test_dir.join("ffmpeg.manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["license"], "GPL-3.0-or-later");
        let ffmpeg = test_dir.join("ffmpeg.exe");
        let ffprobe = test_dir.join("ffprobe.exe");
        let output = test_dir.join("generated.mp4");
        let status = Command::new(test_dir.join("ffmpeg.exe"))
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:sample_rate=44100",
                "-t",
                "1.0",
                "-shortest",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-y",
                output.to_string_lossy().as_ref(),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        assert!(output.metadata().unwrap().len() > 0);

        let cases = [
            ("convert", test_dir.join("converted.mp4"), None, None),
            ("clip", test_dir.join("clipped.mp4"), Some(0.2), Some(0.7)),
            ("audio", test_dir.join("audio.mp3"), None, None),
            ("crop-vertical", test_dir.join("vertical.mp4"), None, None),
            ("rotate-left", test_dir.join("rotate-left.mp4"), None, None),
            (
                "rotate-right",
                test_dir.join("rotate-right.mp4"),
                None,
                None,
            ),
            ("mute", test_dir.join("muted.mp4"), None, None),
            ("speed-2x", test_dir.join("speed-2x.mp4"), None, None),
            ("compress", test_dir.join("compressed.mp4"), None, None),
        ];
        for (mode, processed, start, end) in cases {
            execute_processing(
                &ffmpeg,
                &output,
                &processed,
                mode,
                start,
                end,
                Some(0.5),
                Some(0.5),
                Some(1.0),
            )
            .unwrap();
            let probe = Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    processed.to_string_lossy().as_ref(),
                ])
                .output()
                .unwrap();
            assert!(probe.status.success(), "ffprobe failed for {mode}");
            assert!(
                String::from_utf8_lossy(&probe.stdout)
                    .trim()
                    .parse::<f64>()
                    .unwrap()
                    > 0.0
            );
        }

        let dimensions = Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=s=x:p=0",
                test_dir.join("vertical.mp4").to_string_lossy().as_ref(),
            ])
            .output()
            .unwrap();
        assert!(dimensions.status.success());
        assert_eq!(
            String::from_utf8_lossy(&dimensions.stdout).trim(),
            "720x1280"
        );
        for rotated in ["rotate-left.mp4", "rotate-right.mp4"] {
            let dimensions = Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=width,height",
                    "-of",
                    "csv=s=x:p=0",
                    test_dir.join(rotated).to_string_lossy().as_ref(),
                ])
                .output()
                .unwrap();
            assert!(dimensions.status.success());
            assert_eq!(
                String::from_utf8_lossy(&dimensions.stdout).trim(),
                "180x320"
            );
        }
        let muted_audio = Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                test_dir.join("muted.mp4").to_string_lossy().as_ref(),
            ])
            .output()
            .unwrap();
        assert!(muted_audio.status.success());
        assert!(String::from_utf8_lossy(&muted_audio.stdout)
            .trim()
            .is_empty());
        let speed_duration = Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                test_dir.join("speed-2x.mp4").to_string_lossy().as_ref(),
            ])
            .output()
            .unwrap();
        let speed_duration = String::from_utf8_lossy(&speed_duration.stdout)
            .trim()
            .parse::<f64>()
            .unwrap();
        assert!((0.45..=0.6).contains(&speed_duration));
        let progress_db = test_dir.join("progress.sqlite3");
        let progress_connection = Connection::open(&progress_db).unwrap();
        initialize_database(&progress_connection).unwrap();
        let capture = insert_capture(
            &progress_connection,
            CaptureInput {
                request_id: Some("ffmpeg-progress".into()),
                page_url: "https://example.com/video".into(),
                title: Some("progress".into()),
                project_name: None,
                capture_method: None,
            },
        )
        .unwrap();
        progress_connection.execute("INSERT INTO download_jobs(item_id,status,file_path,created_at,updated_at) VALUES(?1,'completed',?2,1,1)", params![capture.item.id, output.to_string_lossy()]).unwrap();
        progress_connection.execute("INSERT INTO media_derivatives(parent_job_id,title,kind,status,progress_percent,created_at,updated_at) VALUES(1,'progress','convert','processing',0,1,1)", []).unwrap();
        let progress_output = test_dir.join("progress-output.mp4");
        execute_processing_cancellable(
            &ffmpeg,
            &output,
            &progress_output,
            "convert",
            None,
            None,
            None,
            None,
            None,
            Some(1.0),
            progress_db.clone(),
            1,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let progress: f64 = progress_connection
            .query_row(
                "SELECT progress_percent FROM media_derivatives WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(progress > 0.0 && progress <= 99.0);
        let package_active = Arc::new(Mutex::new(HashMap::new()));
        let package_queued = Arc::new(Mutex::new(HashMap::new()));
        let package_derivative_id = queue_package_audio(
            progress_db.clone(),
            test_dir.clone(),
            ffmpeg.clone(),
            1,
            output.clone(),
            package_active,
            package_queued,
        )
        .unwrap();
        let package_deadline = SystemTime::now() + Duration::from_secs(10);
        let package_result = loop {
            let result: (String, Option<String>) = progress_connection
                .query_row(
                    "SELECT status,file_path FROM media_derivatives WHERE id=?1",
                    params![package_derivative_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            if matches!(result.0.as_str(), "completed" | "failed") {
                break result;
            }
            assert!(SystemTime::now() < package_deadline, "素材包 MP3 生成超时");
            thread::sleep(Duration::from_millis(100));
        };
        assert_eq!(package_result.0, "completed");
        let package_audio = PathBuf::from(package_result.1.unwrap());
        assert!(package_audio.metadata().unwrap().len() > 0);
        let package_probe = Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                package_audio.to_string_lossy().as_ref(),
            ])
            .output()
            .unwrap();
        assert!(package_probe.status.success());
        assert_eq!(String::from_utf8_lossy(&package_probe.stdout).trim(), "mp3");
        let cancel_result = execute_processing_cancellable(
            &ffmpeg,
            &output,
            &test_dir.join("cancelled.mp4"),
            "convert",
            None,
            None,
            None,
            None,
            None,
            Some(1.0),
            progress_db,
            1,
            Arc::new(AtomicBool::new(true)),
        );
        assert_eq!(cancel_result.unwrap_err(), "处理已取消。");
        assert!(!test_dir.join("cancelled.mp4").exists());
        let _ = fs::remove_dir_all(test_dir);
    }

    #[tokio::test]
    #[ignore = "downloads and validates the current official Deno Windows release"]
    async fn installs_verified_official_deno() {
        let test_dir =
            std::env::temp_dir().join(format!("clipcargo-deno-test-{}", new_request_id()));
        let result = install_deno_into(&test_dir).await.unwrap();
        assert_eq!(result.sha256.len(), 64);
        assert!(result.bytes > 1_048_576);
        let output = Command::new(test_dir.join("deno.exe"))
            .arg("--version")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).starts_with("deno "));
        assert!(test_dir.join("deno.manifest.json").is_file());
        assert!(test_dir.join("deno-NOTICE.txt").is_file());
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(test_dir.join("deno.manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["license"], "MIT");
        let _ = fs::remove_dir_all(test_dir);
    }
}
