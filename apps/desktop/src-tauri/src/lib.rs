mod client;
mod daemon;
mod geometry;
mod shortcut;
mod sse;
mod status_view;

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::client::LoopbackClient;
use crate::daemon::{DaemonEndpoint, EndpointState, LaunchSequence};
use crate::status_view::TrayPresentation;

const PANEL: &str = "panel";
const MAIN: &str = "main";
const TRAY: &str = "main";
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 560.0;
const MAIN_WIDTH: f64 = 1100.0;
const MAIN_HEIGHT: f64 = 760.0;
const PANEL_GAP: f64 = 6.0;
const BLUR_GUARD: Duration = Duration::from_millis(350);
const DAEMON_WAIT: Duration = Duration::from_secs(30);
const STATUS_POLL: Duration = Duration::from_secs(30);

struct ShellState {
    endpoint: Mutex<Option<DaemonEndpoint>>,
    shortcut: Mutex<String>,
    attention: Mutex<Option<String>>,
    panel_target: Mutex<Option<String>>,
    main_target: Mutex<Option<String>>,
    launch_attempt: Mutex<u32>,
}

static BLUR_GUARD_UNTIL: AtomicU64 = AtomicU64::new(0);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            arm_blur_guard();
            let app = app.clone();
            let _ = app
                .clone()
                .run_on_main_thread(move || toggle_panel(&app, None, false));
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        arm_blur_guard();
                        let app = app.clone();
                        let _ = app
                            .clone()
                            .run_on_main_thread(move || toggle_panel(&app, None, true));
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![open_main_window])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            app.manage(ShellState {
                endpoint: Mutex::new(None),
                shortcut: Mutex::new(String::new()),
                attention: Mutex::new(None),
                panel_target: Mutex::new(None),
                main_target: Mutex::new(None),
                launch_attempt: Mutex::new(0),
            });
            install_tray(app)?;
            let data_dir = current_data_dir();
            let shell = read_shell(&data_dir);
            apply_autostart(app.handle(), shell.autostart.unwrap_or(true));
            let initial = shortcut::effective_shortcut(None, shell.shortcut.as_deref());
            register_shortcut(app.handle(), &initial);

            let handle = app.handle().clone();
            thread::spawn(move || supervise(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build you-brain")
        .run(|_app, _event| {});
}

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    let open_panel = MenuItem::with_id(app, "open-panel", "打开面板", true, None::<&str>)?;
    let open_main = MenuItem::with_id(app, "open-main", "打开完整窗口", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "立即同步", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_panel, &open_main, &sync, &quit])?;
    let disconnected = status_view::disconnected();
    TrayIconBuilder::with_id(TRAY)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(disconnected.tooltip)
        .title(disconnected.title)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-panel" => {
                arm_blur_guard();
                toggle_panel(app, None, false);
            }
            "open-main" => show_main(app),
            "sync" => sync_now(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state,
                rect,
                ..
            } = event
            {
                arm_blur_guard();
                if button_state == MouseButtonState::Up {
                    toggle_panel(tray.app_handle(), Some(rect), true);
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn supervise(app: tauri::AppHandle) {
    let (ping_tx, ping_rx) = mpsc::channel();
    let watcher = app.clone();
    thread::spawn(move || watch_events(watcher, ping_tx));
    let mut announced_failure = false;

    loop {
        let data_dir = current_data_dir();
        match ensure_daemon(&app, &data_dir) {
            Ok(endpoint) => {
                announced_failure = false;
                set_endpoint(&app, Some(endpoint.clone()));
                let port = endpoint.port;
                let app_for_windows = app.clone();
                let _ =
                    app.run_on_main_thread(move || publish_daemon_windows(&app_for_windows, port));
                refresh_status(&app, &data_dir);
                recv_poll(&ping_rx);
            }
            Err(message) => {
                eprintln!("you-brain: {message}");
                set_endpoint(&app, None);
                show_tray(&app, status_view::disconnected());
                if !announced_failure {
                    notify(&app, "you-brain", &message);
                    announced_failure = true;
                }
                thread::sleep(Duration::from_secs(5));
            }
        }
    }
}

fn recv_poll(rx: &Receiver<()>) {
    let _ = rx.recv_timeout(STATUS_POLL);
    while rx.try_recv().is_ok() {}
}

fn ensure_daemon(
    app: &tauri::AppHandle,
    data_dir: &std::path::Path,
) -> Result<DaemonEndpoint, String> {
    if let Some(endpoint) = read_healthy(data_dir) {
        if let Ok(mut attempt) = app.state::<ShellState>().launch_attempt.lock() {
            *attempt = 0;
        }
        return Ok(endpoint);
    }
    let sequence = locate_launch(app)?;
    let attempt = app
        .state::<ShellState>()
        .launch_attempt
        .lock()
        .map(|guard| *guard)
        .unwrap_or(0);
    let spec = spec_for_attempt(&sequence, attempt);
    let resources = app.path().resource_dir().ok();
    daemon::spawn_detached(spec, data_dir, resources.as_deref())
        .map_err(|error| format!("拉起 daemon 失败：{error}"))?;
    if let Ok(mut guard) = app.state::<ShellState>().launch_attempt.lock() {
        *guard = attempt.saturating_add(1);
    }
    wait_healthy(data_dir, DAEMON_WAIT).ok_or_else(|| daemon_wait_message(&sequence, attempt))
}

fn spec_for_attempt(sequence: &LaunchSequence, attempt: u32) -> &daemon::LaunchSpec {
    if attempt >= 1 {
        if let Some(fallback) = sequence.fallback.as_ref() {
            return fallback;
        }
    }
    &sequence.primary
}

fn daemon_wait_message(sequence: &LaunchSequence, attempt: u32) -> String {
    if attempt == 0 && sequence.fallback.is_some() {
        "sidecar 未在 30 秒内就绪，将改用 YOU_BRAIN_DAEMON_CMD".to_string()
    } else {
        "daemon 未在 30 秒内就绪。确认 sidecar 或 YOU_BRAIN_DAEMON_CMD 可用。".to_string()
    }
}

fn locate_launch(app: &tauri::AppHandle) -> Result<LaunchSequence, String> {
    let env_cmd = std::env::var("YOU_BRAIN_DAEMON_CMD").ok();
    daemon::launch_sequence(locate_sidecar(app), env_cmd.as_deref()).map_err(|error| match error {
        daemon::LaunchError::BadCommand => {
            "YOU_BRAIN_DAEMON_CMD 无法解析。示例：bun /path/packages/cli/src/index.ts daemon"
                .to_string()
        }
        daemon::LaunchError::Missing => {
            "找不到 daemon。请设置 YOU_BRAIN_DAEMON_CMD，或放入 sidecar 二进制 you-brain。"
                .to_string()
        }
    })
}

fn locate_sidecar(app: &tauri::AppHandle) -> Option<daemon::SidecarCandidate> {
    let exe = std::env::current_exe().ok()?;
    let resource = app.path().resource_dir().ok();
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let triple = env!("YOU_BRAIN_TARGET_TRIPLE");
    daemon::resolve_sidecar(resource.as_deref(), &exe, manifest, triple)
}

fn read_healthy(data_dir: &std::path::Path) -> Option<DaemonEndpoint> {
    let (state, endpoint) = inspect_daemon(data_dir);
    if daemon::should_launch(state) {
        None
    } else {
        endpoint
    }
}

fn inspect_daemon(data_dir: &std::path::Path) -> (EndpointState, Option<DaemonEndpoint>) {
    let (parsed, endpoint) = match std::fs::read_to_string(daemon::daemon_file(data_dir)) {
        Ok(text) => match daemon::parse_daemon_json(&text) {
            Ok(endpoint) => (Some(Ok(())), Some(endpoint)),
            Err(error) => (Some(Err(error)), None),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
        Err(_) => (Some(Err(daemon::DaemonJsonError::InvalidJson)), None),
    };
    let (alive, status_ok) = match &endpoint {
        Some(endpoint) => {
            let alive = daemon::process_is_alive(endpoint.pid);
            let status_ok = alive
                && daemon::status_is_healthy(
                    LoopbackClient::new(endpoint.port, &endpoint.token).http_status("/api/status"),
                );
            (alive, status_ok)
        }
        None => (false, false),
    };
    (
        daemon::classify_endpoint(parsed, alive, status_ok),
        endpoint,
    )
}

fn wait_healthy(data_dir: &std::path::Path, timeout: Duration) -> Option<DaemonEndpoint> {
    let started = std::time::Instant::now();
    loop {
        if let Some(endpoint) = read_healthy(data_dir) {
            return Some(endpoint);
        }
        if started.elapsed() >= timeout {
            return None;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn watch_events(app: tauri::AppHandle, ping: std::sync::mpsc::Sender<()>) {
    loop {
        let Some(endpoint) = current_endpoint(&app) else {
            thread::sleep(Duration::from_secs(1));
            continue;
        };
        let client = LoopbackClient::new(endpoint.port, &endpoint.token);
        let Ok(reader) = client.open_events() else {
            thread::sleep(Duration::from_secs(2));
            continue;
        };
        let mut reader = BufReader::new(reader);
        let mut pending = String::new();
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    pending.push_str(&line);
                    let (events, rest) = sse::drain_sse(&pending);
                    if !events.is_empty() {
                        let _ = ping.send(());
                    }
                    pending = rest;
                }
                Err(_) => break,
            }
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn refresh_status(app: &tauri::AppHandle, data_dir: &std::path::Path) {
    let Some(endpoint) = current_endpoint(app) else {
        return;
    };
    let client = LoopbackClient::new(endpoint.port, &endpoint.token);
    let status = match client.get_status() {
        Ok(status) => status,
        Err(_) => {
            show_tray(app, status_view::disconnected());
            return;
        }
    };
    let reminders = client.reminder_count().unwrap_or(0);
    let view = status_view::present(&status, reminders);
    let body = status_view::notification_body(&status, reminders);
    let notify_now = {
        let state = app.state::<ShellState>();
        let mut previous = state
            .attention
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let fire = status_view::should_notify(previous.as_deref(), &view.attention);
        *previous = Some(view.attention.clone());
        fire
    };
    show_tray(app, view);
    if notify_now && !body.is_empty() {
        notify(app, "you-brain", &body);
    }
    if let Ok(shared) = client.shared_shortcut() {
        let local = read_shell(data_dir).shortcut;
        let next = shortcut::effective_shortcut(shared.as_deref(), local.as_deref());
        let current = app
            .state::<ShellState>()
            .shortcut
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        if current != next {
            let app = app.clone();
            let _ = app
                .clone()
                .run_on_main_thread(move || register_shortcut(&app, &next));
        }
    }
}

fn sync_now(app: &tauri::AppHandle) {
    let Some(endpoint) = current_endpoint(app) else {
        notify(app, "you-brain", "daemon 未连接，无法同步");
        return;
    };
    let app = app.clone();
    thread::spawn(move || {
        let client = LoopbackClient::new(endpoint.port, &endpoint.token);
        match client.sync() {
            Ok(()) => refresh_status(&app, &current_data_dir()),
            Err(error) => notify(&app, "you-brain", &format!("同步失败：{error}")),
        }
    });
}

/// Load the daemon origin from `daemon.json`'s port only. The daemon injects
/// the loopback token into `index.html`; the shell must not put it in the URL.
fn publish_daemon_windows(app: &tauri::AppHandle, port: u16) {
    ensure_content(app, PANEL, &format!("http://127.0.0.1:{port}/panel"), true);
    ensure_content(app, MAIN, &format!("http://127.0.0.1:{port}/"), false);
}

fn ensure_content(app: &tauri::AppHandle, label: &str, url: &str, panel: bool) {
    let state = app.state::<ShellState>();
    let slot = if panel {
        &state.panel_target
    } else {
        &state.main_target
    };
    if let Some(window) = app.get_webview_window(label) {
        let mut current = slot.lock().unwrap_or_else(|poison| poison.into_inner());
        if current.as_deref() != Some(url) {
            if let Ok(parsed) = url.parse::<url::Url>() {
                if window.navigate(parsed).is_ok() {
                    *current = Some(url.to_string());
                }
            }
        }
        return;
    }
    let Ok(parsed) = url.parse::<url::Url>() else {
        return;
    };
    let built = if panel {
        build_panel(app, WebviewUrl::External(parsed))
    } else {
        build_main(app, WebviewUrl::External(parsed))
    };
    if built.is_ok() {
        *slot.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(url.to_string());
    }
}

fn toggle_panel(app: &tauri::AppHandle, anchor: Option<tauri::Rect>, toggle: bool) {
    if app.get_webview_window(PANEL).is_none() {
        let _ = build_panel(app, WebviewUrl::App("index.html".into()));
        *app.state::<ShellState>()
            .panel_target
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some("app://index.html".into());
        if let Some(endpoint) = current_endpoint(app) {
            publish_daemon_windows(app, endpoint.port);
        }
    }
    let Some(window) = app.get_webview_window(PANEL) else {
        return;
    };
    if toggle && window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    if let Some(rect) = anchor {
        position_panel(app, &window, rect);
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    handle
        .run_on_main_thread(move || show_main(&app))
        .map_err(|error| format!("打开完整窗口失败：{error}"))
}

fn show_main(app: &tauri::AppHandle) {
    if app.get_webview_window(MAIN).is_none() {
        let _ = build_main(app, WebviewUrl::App("index.html".into()));
        *app.state::<ShellState>()
            .main_target
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some("app://index.html".into());
        if let Some(endpoint) = current_endpoint(app) {
            publish_daemon_windows(app, endpoint.port);
        }
    }
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn position_panel(app: &tauri::AppHandle, window: &WebviewWindow, rect: tauri::Rect) {
    let physical = physical_origin(&rect, window.scale_factor().unwrap_or(1.0));
    let monitor = monitor_at(app, physical.0, physical.1);
    let scale = monitor
        .as_ref()
        .map(tauri::Monitor::scale_factor)
        .unwrap_or_else(|| window.scale_factor().unwrap_or(1.0));
    let icon = logical_rect(&rect, scale);
    let work_area = monitor
        .as_ref()
        .map(|monitor| logical_physical_rect(monitor.work_area(), scale))
        .unwrap_or(geometry::PxRect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        });
    let origin = geometry::panel_origin(
        icon,
        geometry::PxSize {
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
        },
        work_area,
        PANEL_GAP,
    );
    let _ = window.set_position(tauri::LogicalPosition::new(origin.x, origin.y));
}

fn monitor_at(app: &tauri::AppHandle, x: f64, y: f64) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().ok()?;
    monitors.into_iter().find(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        let left = f64::from(origin.x);
        let top = f64::from(origin.y);
        x >= left
            && y >= top
            && x < left + f64::from(size.width)
            && y < top + f64::from(size.height)
    })
}

fn physical_origin(rect: &tauri::Rect, scale: f64) -> (f64, f64) {
    match rect.position {
        tauri::Position::Physical(position) => (f64::from(position.x), f64::from(position.y)),
        tauri::Position::Logical(position) => (position.x * scale, position.y * scale),
    }
}

fn logical_physical_rect(rect: &tauri::PhysicalRect<i32, u32>, scale: f64) -> geometry::PxRect {
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    geometry::PxRect {
        x: f64::from(rect.position.x) / scale,
        y: f64::from(rect.position.y) / scale,
        width: f64::from(rect.size.width) / scale,
        height: f64::from(rect.size.height) / scale,
    }
}

fn logical_rect(rect: &tauri::Rect, scale: f64) -> geometry::PxRect {
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    let (x, y, width, height) = match (rect.position, rect.size) {
        (tauri::Position::Logical(position), tauri::Size::Logical(size)) => {
            (position.x, position.y, size.width, size.height)
        }
        (position, size) => {
            let (x, y) = match position {
                tauri::Position::Physical(position) => {
                    (f64::from(position.x) / scale, f64::from(position.y) / scale)
                }
                tauri::Position::Logical(position) => (position.x, position.y),
            };
            let (width, height) = match size {
                tauri::Size::Physical(size) => (
                    f64::from(size.width) / scale,
                    f64::from(size.height) / scale,
                ),
                tauri::Size::Logical(size) => (size.width, size.height),
            };
            (x, y, width, height)
        }
    };
    geometry::PxRect {
        x,
        y,
        width,
        height,
    }
}

fn build_panel(app: &tauri::AppHandle, url: WebviewUrl) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, PANEL, url)
        .title("you-brain")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .decorations(false)
        .visible(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .build()?;
    let panel = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            if !blur_guard_active() {
                let _ = panel.hide();
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = panel.hide();
        }
        _ => {}
    });
    Ok(window)
}

fn build_main(app: &tauri::AppHandle, url: WebviewUrl) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, MAIN, url)
        .title("you-brain")
        .inner_size(MAIN_WIDTH, MAIN_HEIGHT)
        .resizable(true)
        .visible(false)
        .center()
        .build()?;
    let main = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = main.hide();
        }
    });
    Ok(window)
}

fn register_shortcut(app: &tauri::AppHandle, shortcut_text: &str) {
    let Ok(parsed) = shortcut::parse_shortcut(shortcut_text) else {
        eprintln!("you-brain: 忽略无法解析的快捷键 {shortcut_text}");
        return;
    };
    let native = shortcut::to_shortcut(&parsed, cfg!(target_os = "macos"));
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    if let Err(error) = manager.register(native) {
        eprintln!("you-brain: 注册快捷键 {shortcut_text} 失败：{error}");
        return;
    }
    *app.state::<ShellState>()
        .shortcut
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = shortcut_text.to_string();
}

fn apply_autostart(app: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    let result = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
    if let Err(error) = result {
        eprintln!("you-brain: 开机自启设置失败：{error}");
    }
}

fn show_tray(app: &tauri::AppHandle, view: TrayPresentation) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(tray) = app.tray_by_id(TRAY) {
            let _ = tray.set_title(Some(view.title));
            let _ = tray.set_tooltip(Some(view.tooltip));
        }
    });
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let title = title.to_string();
    let body = body.to_string();
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let _ = app.notification().builder().title(title).body(body).show();
    });
}

fn set_endpoint(app: &tauri::AppHandle, endpoint: Option<DaemonEndpoint>) {
    *app.state::<ShellState>()
        .endpoint
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = endpoint;
}

fn current_endpoint(app: &tauri::AppHandle) -> Option<DaemonEndpoint> {
    app.state::<ShellState>()
        .endpoint
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

fn read_shell(data_dir: &std::path::Path) -> daemon::ShellFile {
    match std::fs::read_to_string(daemon::shell_file(data_dir)) {
        Ok(text) => daemon::parse_shell_file(&text),
        Err(_) => daemon::ShellFile::default(),
    }
}

fn current_data_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    let override_value = std::env::var("YOU_BRAIN_DATA_DIR").ok();
    let xdg = std::env::var("XDG_STATE_HOME").ok();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let platform = if cfg!(target_os = "macos") {
        daemon::DesktopPlatform::MacOs
    } else {
        daemon::DesktopPlatform::Linux
    };
    daemon::resolve_data_dir(
        platform,
        &home,
        override_value.as_deref(),
        xdg.as_deref(),
        &cwd,
    )
}

fn arm_blur_guard() {
    BLUR_GUARD_UNTIL.store(
        now_millis() + BLUR_GUARD.as_millis() as u64,
        Ordering::SeqCst,
    );
}

fn blur_guard_active() -> bool {
    now_millis() < BLUR_GUARD_UNTIL.load(Ordering::SeqCst)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
