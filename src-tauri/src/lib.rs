pub mod ai;
pub mod commands;
pub mod core;
pub mod error;
pub mod state;

pub use error::AppError;
pub use state::AppState;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

#[cfg(windows)]
fn harden_webview(app: &tauri::App) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.with_webview(|webview| unsafe {
            let controller = webview.controller();
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let Ok(settings) = core.Settings() else {
                return;
            };
            let _ = settings.SetIsZoomControlEnabled(false);

            #[cfg(not(debug_assertions))]
            {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows::core::Interface;

                if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                    let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
                }
            }
        })?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn harden_webview(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

fn setup_native_menu(app: &tauri::App) -> tauri::Result<()> {
    let new_query = MenuItemBuilder::with_id("new-query", "New Query")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_query)
        .item(&close_tab)
        .separator()
        .quit()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .copy()
        .paste()
        .select_all()
        .build()?;

    let toggle_theme = MenuItemBuilder::with_id("toggle-theme", "Toggle Theme").build(app)?;
    let toggle_ai = MenuItemBuilder::with_id("toggle-ai", "Toggle AI Panel").build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar").build(app)?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_theme)
        .item(&toggle_ai)
        .item(&toggle_sidebar)
        .build()?;

    let about = MenuItemBuilder::with_id("about", "About DataForge").build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&about)
        .item(&check_updates)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &help])
        .build()?;

    app.handle().set_menu(menu)?;
    app.handle().on_menu_event(|app, event| {
        let id = event.id().as_ref();
        match id {
            "new-query" => {
                let _ = app.emit("menu:new-query", ());
            }
            "close-tab" => {
                let _ = app.emit("menu:close-tab", ());
            }
            "toggle-theme" => {
                let _ = app.emit("menu:toggle-theme", ());
            }
            "toggle-ai" => {
                let _ = app.emit("menu:toggle-ai", ());
            }
            "toggle-sidebar" => {
                let _ = app.emit("menu:toggle-sidebar", ());
            }
            "about" => {
                let _ = app.emit("menu:about", ());
            }
            "check-updates" => {
                let _ = app.emit("menu:check-updates", ());
            }
            _ => {}
        }
    });

    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("tray-show", "Show DataForge").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DataForge")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState::new(config_dir)?);
            harden_webview(app)?;
            setup_native_menu(app)?;
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::save_connection,
            commands::connection::update_connection,
            commands::connection::list_connections,
            commands::connection::list_connection_states,
            commands::connection::connect_connection,
            commands::connection::disconnect_connection,
            commands::connection::delete_connection,
            commands::connection::test_connection,
            commands::connection::pick_sqlite_file,
            commands::query::run_query,
            commands::query::list_databases,
            commands::query::list_tables,
            commands::query::list_columns,
            commands::query::get_schema,
            commands::ai::ai_nl2sql,
            commands::ai::ai_explain,
            commands::ai::ai_get_config,
            commands::ai::ai_set_config,
            commands::ai::ai_has_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DataForge");
}
