//! Weflow 桌面端壳：只做 WebView 加载，业务零改动。
//!
//! 服务器地址解析顺序（先命中者生效）：
//!   1. 命令行 `--url <addr>` / `--url=<addr>`（临时指定，便于排障）
//!   2. exe 同目录 `weflow.conf`（便携部署 / IT 统一下发）
//!   3. `%APPDATA%\Weflow\weflow.conf`（应用内「连接设置」写入的位置）
//!   4. 编译期默认 `http://127.0.0.1:3100`（同机部署，api 同时托管前端）
//!
//! 远程接入：地址填 `https://web.leaif.com` 之类即可当远程客户端用
//! —— 必须 https，否则生产环境的 Secure 会话 Cookie 不会被 WebView 接受。
//!
//! 启动流程：窗口先加载内置页 `ui/index.html`（连接页）。连接页探测目标地址
//! 可达后跳转；不可达时留在连接页让用户改地址（写回配置），不再出现
//! WebView2 的原生错误页。
//!
//! 下载即打开：页面里的「下载」由 WebView2 落盘（系统下载目录），下载完成后
//! 直接用系统默认程序打开——桌面端因此不必内建任何文档查看器。走的是
//! tauri-plugin-opener 的 Rust 侧自由函数（不经 IPC，也就不需要给远端页面
//! 开任何权限）；Windows 之外的平台同理由 opener 处理。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;
use tauri::webview::DownloadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// 编译期默认：同机部署的 Core API（同时托管前端）
const DEFAULT_URL: &str = "http://127.0.0.1:3100";
/// 单次可达性探测超时（建立连接）
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Deserialize)]
struct Conf {
    url: String,
}

#[derive(Serialize)]
struct ServerInfo {
    url: String,
    /// exe | user | cli | default —— 连接页据此说明地址来源
    source: String,
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|d| d.to_path_buf())
}

fn user_conf_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join("Weflow").join("weflow.conf"))
}

/// 读取单个 conf 文件的 url 字段；缺失或格式不对返回 None
fn read_conf(path: &PathBuf) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let conf: Conf = serde_json::from_str(&text).ok()?;
    let url = conf.url.trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// 命令行 `--url <addr>` 或 `--url=<addr>`
fn cli_url() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if let Some(rest) = arg.strip_prefix("--url=") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        } else if arg == "--url" {
            if let Some(next) = args.next() {
                let trimmed = next.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn resolve_server() -> ServerInfo {
    if let Some(url) = cli_url() {
        return ServerInfo {
            url,
            source: "cli".into(),
        };
    }
    if let Some(dir) = exe_dir() {
        if let Some(url) = read_conf(&dir.join("weflow.conf")) {
            return ServerInfo {
                url,
                source: "exe".into(),
            };
        }
    }
    if let Some(path) = user_conf_path() {
        if let Some(url) = read_conf(&path) {
            return ServerInfo {
                url,
                source: "user".into(),
            };
        }
    }
    ServerInfo {
        url: DEFAULT_URL.to_string(),
        source: "default".into(),
    }
}

/// 保存服务器地址：优先写 exe 同目录（便携部署），不可写时退回 %APPDATA%
fn persist_server(url: &str) -> Result<PathBuf, String> {
    let encoded = serde_json::to_string(url).map_err(|e| e.to_string())?;
    let payload = format!("{{ \"url\": {encoded} }}\n");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("weflow.conf"));
    }
    if let Some(path) = user_conf_path() {
        candidates.push(path);
    }
    for path in candidates {
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        if std::fs::write(&path, &payload).is_ok() {
            return Ok(path);
        }
    }
    Err("无法写入配置文件（exe 目录与 %APPDATA% 都不可写）".into())
}

/// 目标地址能否建立 TCP 连接（够用来区分「服务没起来/地址写错」与「服务在」）
fn probe(url: &str) -> bool {
    let parsed = match tauri::Url::parse(url.trim()) {
        Ok(value) => value,
        Err(_) => return false,
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let host = match parsed.host_str() {
        Some(value) => value.to_string(),
        None => return false,
    };
    let port = match parsed.port_or_known_default() {
        Some(value) => value,
        None => return false,
    };
    let addrs = match (host.as_str(), port).to_socket_addrs() {
        Ok(iter) => iter,
        Err(_) => return false,
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok() {
            return true;
        }
    }
    false
}

/// 只允许内置连接页调用配置读写命令。
///
/// 产品前端（远端页面）跑在同一个 WebView 里，不设防的话它也能读写本机配置
/// —— 本壳刻意不给远端页面任何 IPC 能力（见文件头注释），这里保持一致。
fn is_builtin_page(webview: &tauri::Webview) -> bool {
    match webview.url() {
        Ok(url) => {
            let scheme = url.scheme();
            let host = url.host_str().unwrap_or("");
            scheme == "tauri" || (scheme == "http" && host == "tauri.localhost")
        }
        Err(_) => false,
    }
}

#[tauri::command]
fn current_server(webview: tauri::Webview) -> Result<ServerInfo, String> {
    if !is_builtin_page(&webview) {
        return Err("forbidden".into());
    }
    Ok(resolve_server())
}

#[tauri::command]
fn probe_server(url: String) -> bool {
    probe(&url)
}

#[tauri::command]
fn save_server_url(webview: tauri::Webview, url: String) -> Result<String, String> {
    if !is_builtin_page(&webview) {
        return Err("forbidden".into());
    }
    let trimmed = url.trim().trim_end_matches('/').to_string();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("地址需要以 http:// 或 https:// 开头".into());
    }
    if !probe(&trimmed) {
        return Err(format!("无法连接 {trimmed}，请确认地址与网络"));
    }
    let path = persist_server(&trimmed)?;
    Ok(path.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            current_server,
            probe_server,
            save_server_url
        ])
        .setup(move |app| {
            // 窗口在 Rust 侧构建（而非 tauri.conf.json）：只有 builder 能挂
            // on_download，用来在下载完成后调起系统默认程序。
            let _window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("Weflow")
            .inner_size(1440.0, 900.0)
            .resizable(true)
            .on_download(|_webview, event| {
                if let DownloadEvent::Finished {
                    path: Some(path),
                    success: true,
                    ..
                } = event
                {
                    let _ = tauri_plugin_opener::open_path(path, None::<&str>);
                }
                // true = 让下载照常进行
                true
            })
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running weflow desktop");
}
