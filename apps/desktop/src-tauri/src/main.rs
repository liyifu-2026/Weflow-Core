//! Weflow 桌面端壳：只做 WebView 加载，业务零改动。
//!
//! 加载目标来自运行时配置文件 `weflow.conf`（exe 同目录，JSON）：
//!   { "url": "http://127.0.0.1:3100" }
//! 未配置时回落到编译期默认（同机部署地址）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::path::PathBuf;
use tauri::Manager;

/// exe 同目录的 weflow.conf；不存在时返回 None
fn read_conf_url() -> Option<String> {
    #[derive(Deserialize)]
    struct Conf {
        url: String,
    }
    let exe = std::env::current_exe().ok()?;
    let dir: PathBuf = exe.parent()?.to_path_buf();
    let text = std::fs::read_to_string(dir.join("weflow.conf")).ok()?;
    let conf: Conf = serde_json::from_str(&text).ok()?;
    let url = conf.url.trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// 编译期默认：同机部署的 Core API（同时托管前端）
const DEFAULT_URL: &str = "http://127.0.0.1:3100";

fn main() {
    let url = read_conf_url().unwrap_or_else(|| DEFAULT_URL.to_string());
    tauri::Builder::default()
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window missing")?;
            window.eval(&format!("location.replace({url:?});"))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running weflow desktop");
}
