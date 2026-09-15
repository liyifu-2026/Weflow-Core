//! Weflow 桌面端壳：只做 WebView 加载，业务零改动。
//!
//! 加载目标来自运行时配置文件 `weflow.conf`（exe 同目录，JSON）：
//!   { "url": "http://127.0.0.1:3100" }
//! 未配置时回落到编译期默认（同机部署地址）。
//!
//! 下载即打开：页面里的「下载」由 WebView2 落盘（系统下载目录），下载完成后
//! 直接用系统默认程序打开——桌面端因此不必内建任何文档查看器。走的是
//! tauri-plugin-opener 的 Rust 侧自由函数（不经 IPC，也就不需要给远端页面
//! 开任何权限）；Windows 之外的平台同理由 opener 处理。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::path::PathBuf;
use tauri::webview::DownloadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};

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
            // 窗口在 Rust 侧构建（而非 tauri.conf.json）：只有 builder 能挂
            // on_download，用来在下载完成后调起系统默认程序。
            let window = WebviewWindowBuilder::new(
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
            window.eval(&format!("location.replace({url:?});"))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running weflow desktop");
}
