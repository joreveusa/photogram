// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_notification::NotificationExt;

/// Open a URL in the system default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

/// Check if the backend is reachable.
#[tauri::command]
async fn check_backend() -> bool {
    reqwest::get("http://localhost:8000/system/stats")
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Send a desktop notification (called from frontend when a job finishes).
#[tauri::command]
fn notify_job_complete(app: tauri::AppHandle, title: String, body: String) {
    let _ = app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // ── System tray ───────────────────────────────────────────
            let open_i  = MenuItem::with_id(app, "open",  "Open PhotoForge", true, None::<&str>)?;
            let sep     = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_i  = MenuItem::with_id(app, "quit",  "Quit",            true, None::<&str>)?;
            let menu    = Menu::with_items(app, &[&open_i, &sep, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_url, check_backend, notify_job_complete])
        .run(tauri::generate_context!())
        .expect("error while running PhotoForge");
}
