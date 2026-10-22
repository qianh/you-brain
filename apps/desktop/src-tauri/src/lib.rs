mod activity;
mod client;
mod daemon;
mod geometry;
mod reminders;
mod shortcut;
mod sse;
mod status_view;

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    /// Pid of the daemon process this shell started and has not yet seen go healthy.
    launching: Mutex<Option<u32>>,
    /// `None` until the first reminder poll loads `shell-notified.json`.
    notified: Mutex<Option<Vec<String>>>,
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
        .invoke_handler(tauri::generate_handler![open_main_window, quit])
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
                launching: Mutex::new(None),
                notified: Mutex::new(None),
            });
            install_tray(app)?;
            let data_dir = current_data_dir();
            let shell = read_shell(&data_dir);
            apply_autostart(app.handle(), shell.autostart.unwrap_or(true));
            let initial = shortcut::effective_shortcut(None, shell.shortcut.as_deref());
            register_shortcut(app.handle(), &initial);

            let handle = app.handle().clone();
            thread::spawn(move || supervise(handle));
            let activity = app.handle().clone();
            thread::spawn(move || report_activity(activity));
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
            "quit" => exit_app(app),
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
                // A process that is still booting is not "后台没有运行".
                if daemon_is_starting(&app, &data_dir) {
                    thread::sleep(Duration::from_secs(5));
                    continue;
                }
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

fn report_activity(app: tauri::AppHandle) {
    let mut last_post: Option<Instant> = None;
    loop {
        if current_endpoint(&app).is_some() {
            let since = last_post.map(|at| at.elapsed());
            let idle = activity::read_hid_idle_ns();
            if activity::should_post_activity(idle, since) {
                if let Some(endpoint) = current_endpoint(&app) {
                    let client = LoopbackClient::new(endpoint.port, &endpoint.token);
                    if client.report_activity().is_ok() {
                        last_post = Some(Instant::now());
                    }
                }
            }
        }
        thread::sleep(activity::ACTIVITY_INTERVAL);
    }
}

fn recv_poll(rx: &Receiver<()>) {
    let _ = rx.recv_timeout(STATUS_POLL);
    while rx.try_recv().is_ok() {}
}

fn launching_pid(app: &tauri::AppHandle) -> Option<u32> {
    app.state::<ShellState>()
        .launching
        .lock()
        .ok()
        .and_then(|guard| *guard)
}

fn daemon_is_starting(app: &tauri::AppHandle, data_dir: &std::path::Path) -> bool {
    if launching_pid(app).is_some_and(daemon::process_is_alive) {
        return true;
    }
    let (state, _) = inspect_daemon(data_dir);
    state == daemon::EndpointState::Unreachable
}

fn ensure_daemon(
    app: &tauri::AppHandle,
    data_dir: &std::path::Path,
) -> Result<DaemonEndpoint, String> {
    let (state, endpoint) = inspect_daemon(data_dir);
    if let Some(endpoint) = endpoint.filter(|_| !daemon::should_launch(state)) {
        if let Ok(mut attempt) = app.state::<ShellState>().launch_attempt.lock() {
            *attempt = 0;
        }
        if let Ok(mut launching) = app.state::<ShellState>().launching.lock() {
            *launching = None;
        }
        return Ok(endpoint);
    }
    let child_alive = launching_pid(app).is_some_and(daemon::process_is_alive);
    if daemon::supervise_action(state, child_alive) == daemon::SuperviseAction::Poll {
        return wait_healthy(data_dir, DAEMON_WAIT)
            .ok_or_else(|| "daemon 进程已在，HTTP 尚未就绪".to_string());
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
    let pid = daemon::spawn_detached(spec, data_dir, resources.as_deref())
        .map_err(|error| format!("拉起 daemon 失败：{error}"))?;
    if let Ok(mut launching) = app.state::<ShellState>().launching.lock() {
        *launching = Some(pid);
    }
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
    let snapshot = client.reminders().ok();
    let reminders = snapshot.as_ref().map(|item| item.count).unwrap_or(0);
    let view = status_view::present(&status, reminders);
    let body = status_view::notification_body(&status);
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
    if let Some(snapshot) = snapshot.as_ref() {
        notify_due_reminders(app, data_dir, snapshot);
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

fn notify_due_reminders(
    app: &tauri::AppHandle,
    data_dir: &std::path::Path,
    snapshot: &reminders::RemindersSnapshot,
) {
    let now_ms = i64::try_from(now_millis()).unwrap_or(0);
    let state = app.state::<ShellState>();
    let mut known = state
        .notified
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if known.is_none() {
        *known = Some(reminders::load_notified(&daemon::notified_file(data_dir)));
    }
    let existing = known.as_deref().unwrap_or(&[]);
    // Missing delivery or notify=false yields nothing, so those ids stay unmarked.
    let selected = reminders::select_reminders_to_notify(
        &snapshot.reminders,
        snapshot.delivery.as_ref(),
        existing,
        now_ms,
    );
    let body = reminders::notification_text(&selected);
    if body.is_empty() {
        return;
    }
    notify(app, "you-brain", &body);
    let updated = reminders::remember_notified(existing, &selected);
    reminders::save_notified(&daemon::notified_file(data_dir), &updated);
    *known = Some(updated);
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
    // A deep link already on this daemon origin must survive the supervisor.
    // The homepage URL is unchanged, so a main window at `/` still no-ops.
    if app.get_webview_window(MAIN).is_some() && main_target_on_port(app, port) {
        return;
    }
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
    position_panel(app, &window, anchor.as_ref());
    let _ = window.show();
    let _ = window.set_focus();
}

const MAX_APP_PATH: usize = 512;

/// Same-origin path only: starts with `/`, not `//`, no scheme, at most 512 bytes.
/// Query and hash are kept. Anything else is an error so the caller can open `/`.
fn normalize_app_path(raw: &str) -> Result<String, String> {
    if raw.len() > MAX_APP_PATH {
        return Err("路径过长".to_string());
    }
    if !raw.starts_with('/') || raw.starts_with("//") {
        return Err("路径必须是站内路径".to_string());
    }
    if raw.contains("://") || raw.contains('\\') || raw.chars().any(char::is_control) {
        return Err("路径必须是站内路径".to_string());
    }
    let base =
        url::Url::parse("http://127.0.0.1/").map_err(|_| "路径必须是站内路径".to_string())?;
    let joined = base
        .join(raw)
        .map_err(|_| "路径必须是站内路径".to_string())?;
    if joined.scheme() != "http"
        || joined.host_str() != Some("127.0.0.1")
        || joined.port().is_some()
    {
        return Err("路径必须是站内路径".to_string());
    }
    let path = joined.path();
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("路径必须是站内路径".to_string());
    }
    Ok(raw.to_string())
}

/// The SPA router reads `popstate`. `location.assign` and webview `navigate`
/// both load a new document, so an already-open daemon page stays in place.
fn spa_route_script(path: &str) -> String {
    let literal = serde_json::to_string(path).unwrap_or_else(|_| "\"/\"".to_string());
    format!(
        "history.pushState(null,\"\",{literal});dispatchEvent(new PopStateEvent(\"popstate\"));"
    )
}

fn exit_app(app: &tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    exit_app(&app);
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let requested = match path.as_deref() {
        None => None,
        Some(raw) => match normalize_app_path(raw) {
            Ok(path) => Some(path),
            Err(error) => {
                let handle = app.clone();
                let _ = handle.run_on_main_thread(move || show_main(&app));
                return Err(error);
            }
        },
    };
    let app_for_ui = app.clone();
    app.run_on_main_thread(move || show_main_at(&app_for_ui, requested.as_deref()))
        .map_err(|error| format!("打开完整窗口失败：{error}"))
}

fn show_main(app: &tauri::AppHandle) {
    show_main_at(app, None);
}

fn show_main_at(app: &tauri::AppHandle, path: Option<&str>) {
    if app.get_webview_window(MAIN).is_none() {
        if let Some(path) = path {
            if open_main_at_path(app, path) {
                reveal_main(app);
                return;
            }
        }
        let _ = build_main(app, WebviewUrl::App("index.html".into()));
        set_main_target(app, "app://index.html".into());
        if let Some(endpoint) = current_endpoint(app) {
            publish_daemon_windows(app, endpoint.port);
        }
        reveal_main(app);
        return;
    }
    if let Some(path) = path {
        route_existing_main(app, path);
    }
    reveal_main(app);
}

/// Create the main window on `http://127.0.0.1:{port}{path}`. The token stays
/// out of the URL; the daemon injects it into `index.html`.
fn open_main_at_path(app: &tauri::AppHandle, path: &str) -> bool {
    let Some(endpoint) = current_endpoint(app) else {
        return false;
    };
    let url = format!("http://127.0.0.1:{}{path}", endpoint.port);
    let Ok(parsed) = url.parse::<url::Url>() else {
        return false;
    };
    if build_main(app, WebviewUrl::External(parsed)).is_err() {
        return false;
    }
    set_main_target(app, url);
    true
}

fn route_existing_main(app: &tauri::AppHandle, path: &str) {
    let Some(target) = main_target(app) else {
        return;
    };
    // `app://` is the built-in page. Leave the existing handoff to the daemon homepage.
    let Some(origin) = daemon_origin(&target) else {
        return;
    };
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let _ = window.eval(&spa_route_script(path));
    set_main_target(app, format!("{origin}{path}"));
}

fn reveal_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_main_target(app: &tauri::AppHandle, url: String) {
    *app.state::<ShellState>()
        .main_target
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Some(url);
}

fn main_target(app: &tauri::AppHandle) -> Option<String> {
    app.state::<ShellState>()
        .main_target
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

fn main_target_on_port(app: &tauri::AppHandle, port: u16) -> bool {
    let Some(origin) = main_target(app).as_deref().and_then(daemon_origin) else {
        return false;
    };
    origin == format!("http://127.0.0.1:{port}") || origin == format!("http://localhost:{port}")
}

fn daemon_origin(target: &str) -> Option<String> {
    let url = url::Url::parse(target).ok()?;
    if url.scheme() != "http" {
        return None;
    }
    let host = url.host_str()?;
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    let port = url.port()?;
    Some(format!("http://{host}:{port}"))
}

fn position_panel(app: &tauri::AppHandle, window: &WebviewWindow, rect: Option<&tauri::Rect>) {
    let origin = match rect {
        Some(rect) if tray_anchor_usable(rect) => anchored_panel_origin(app, window, rect),
        // No rect, or an all-zero AppIndicator rect: pin to the current work area.
        _ => geometry::fallback_origin(panel_size(), current_work_area(app)),
    };
    let _ = window.set_position(tauri::LogicalPosition::new(origin.x, origin.y));
}

fn tray_anchor_usable(rect: &tauri::Rect) -> bool {
    geometry::tray_rect_usable(logical_rect(rect, 1.0))
}

fn panel_size() -> geometry::PxSize {
    geometry::PxSize {
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
    }
}

fn anchored_panel_origin(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    rect: &tauri::Rect,
) -> geometry::PxPoint {
    let physical = physical_origin(rect, window.scale_factor().unwrap_or(1.0));
    let monitor = monitor_at(app, physical.0, physical.1);
    let scale = monitor
        .as_ref()
        .map(tauri::Monitor::scale_factor)
        .unwrap_or_else(|| window.scale_factor().unwrap_or(1.0));
    let icon = logical_rect(rect, scale);
    let work_area = monitor
        .as_ref()
        .map(|monitor| logical_physical_rect(monitor.work_area(), scale))
        .unwrap_or(geometry::PxRect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        });
    geometry::panel_origin(icon, panel_size(), work_area, PANEL_GAP)
}

/// Monitor under the pointer, then the primary monitor. A missing tray rect
/// has no icon to search from.
fn current_work_area(app: &tauri::AppHandle) -> geometry::PxRect {
    if let Ok(cursor) = app.cursor_position() {
        if let Some(monitor) = monitor_at(app, cursor.x, cursor.y) {
            return logical_physical_rect(monitor.work_area(), monitor.scale_factor());
        }
    }
    if let Ok(Some(monitor)) = app.primary_monitor() {
        return logical_physical_rect(monitor.work_area(), monitor.scale_factor());
    }
    geometry::PxRect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    }
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

#[cfg(test)]
mod tests {
    use super::{daemon_origin, normalize_app_path, spa_route_script, MAX_APP_PATH};

    #[test]
    fn accepts_same_origin_paths() {
        assert_eq!(normalize_app_path("/").as_deref(), Ok("/"));
        assert_eq!(normalize_app_path("/today").as_deref(), Ok("/today"));
        assert_eq!(
            normalize_app_path("/topics/history").as_deref(),
            Ok("/topics/history")
        );
        assert_eq!(
            normalize_app_path("/settings?section=account#model").as_deref(),
            Ok("/settings?section=account#model")
        );
        assert_eq!(
            normalize_app_path("/search?q=hello#top").as_deref(),
            Ok("/search?q=hello#top")
        );
        let max = format!("/{}", "a".repeat(MAX_APP_PATH - 1));
        assert_eq!(max.len(), MAX_APP_PATH);
        assert!(normalize_app_path(&max).is_ok());
    }

    #[test]
    fn rejects_open_redirects_and_overlong_paths() {
        assert!(normalize_app_path("//evil.com").is_err());
        assert!(normalize_app_path("///evil.com").is_err());
        assert!(normalize_app_path("https://x").is_err());
        assert!(normalize_app_path("http://127.0.0.1/today").is_err());
        assert!(normalize_app_path("today").is_err());
        assert!(normalize_app_path("").is_err());
        assert!(normalize_app_path("/\\\\evil.com").is_err());
        assert!(normalize_app_path("/foo\n/bar").is_err());
        let long = format!("/{}", "a".repeat(MAX_APP_PATH));
        assert!(long.len() > MAX_APP_PATH);
        assert!(normalize_app_path(&long).is_err());
    }

    #[test]
    fn routes_inside_the_loaded_document() {
        let script = spa_route_script("/settings?section=account#model");
        assert!(script.contains("history.pushState"));
        assert!(script.contains("PopStateEvent"));
        assert!(!script.contains("location.assign"));
        assert!(script.contains("/settings?section=account#model"));
        assert_eq!(
            daemon_origin("http://127.0.0.1:4802/settings?section=account"),
            Some("http://127.0.0.1:4802".to_string())
        );
        assert_eq!(daemon_origin("app://index.html"), None);
    }
}
