use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopPlatform {
    MacOs,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonEndpoint {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonJsonError {
    InvalidJson,
    MissingFields,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointState {
    Missing,
    Invalid,
    Dead,
    Unreachable,
    Healthy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarCandidate {
    pub path: PathBuf,
    pub native: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchSpec {
    Sidecar(PathBuf),
    Command { program: String, args: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSequence {
    pub primary: LaunchSpec,
    pub fallback: Option<LaunchSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchError {
    Missing,
    BadCommand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandError {
    Empty,
    UnclosedQuote,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShellFile {
    pub shortcut: Option<String>,
    pub autostart: Option<bool>,
}

pub fn resolve_data_dir(
    platform: DesktopPlatform,
    home: &Path,
    data_dir_env: Option<&str>,
    xdg_state_home: Option<&str>,
    cwd: &Path,
) -> PathBuf {
    if let Some(value) = nonempty(data_dir_env) {
        return normalize(resolve_user_path(value, home, cwd));
    }
    let relative = match platform {
        DesktopPlatform::MacOs => home.join("Library/Application Support/you-brain"),
        DesktopPlatform::Linux => {
            let state = match nonempty(xdg_state_home) {
                Some(value) => resolve_user_path(value, home, cwd),
                None => home.join(".local/state"),
            };
            state.join("you-brain")
        }
    };
    normalize(relative)
}

pub fn daemon_file(data_dir: &Path) -> PathBuf {
    data_dir.join("daemon.json")
}

pub fn shell_file(data_dir: &Path) -> PathBuf {
    data_dir.join("shell.json")
}

pub fn parse_daemon_json(text: &str) -> Result<DaemonEndpoint, DaemonJsonError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| DaemonJsonError::InvalidJson)?;
    let object = value.as_object().ok_or(DaemonJsonError::MissingFields)?;
    let port = object
        .get("port")
        .and_then(json_port)
        .ok_or(DaemonJsonError::MissingFields)?;
    let token = object
        .get("token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| token.len() >= 16)
        .ok_or(DaemonJsonError::MissingFields)?;
    let pid = object
        .get("pid")
        .and_then(json_pid)
        .ok_or(DaemonJsonError::MissingFields)?;
    Ok(DaemonEndpoint {
        port,
        token: token.to_string(),
        pid,
    })
}

pub fn classify_endpoint(
    parsed: Option<Result<(), DaemonJsonError>>,
    pid_alive: bool,
    status_ok: bool,
) -> EndpointState {
    match parsed {
        None => EndpointState::Missing,
        Some(Err(_)) => EndpointState::Invalid,
        Some(Ok(())) if !pid_alive => EndpointState::Dead,
        Some(Ok(())) if !status_ok => EndpointState::Unreachable,
        Some(Ok(())) => EndpointState::Healthy,
    }
}

pub fn should_launch(state: EndpointState) -> bool {
    !matches!(state, EndpointState::Healthy)
}

pub fn status_is_healthy(http_status: Option<u16>) -> bool {
    matches!(http_status, Some(code) if (200..300).contains(&code))
}

pub fn is_native_executable(header: &[u8]) -> bool {
    if header.len() < 4 {
        return false;
    }
    let le = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let be = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    matches!(le, 0xFEED_FACE | 0xFEED_FACF | 0xCEFA_EDFE | 0xCFFA_EDFE)
        || matches!(be, 0xCAFE_BABE | 0xBEBA_FECA)
        || header.starts_with(b"\x7FELF")
}

const SHELL_BINARY: &str = "you-brain-desktop";
const SIDECAR_BINARY: &str = "you-brain";

pub fn sidecar_search_paths(
    resource_dir: Option<&Path>,
    exe: &Path,
    manifest_dir: &Path,
    triple: &str,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(dir) = resource_dir {
        paths.push(dir.join(SIDECAR_BINARY));
        paths.push(dir.join("binaries").join(SIDECAR_BINARY));
    }
    if let Some(parent) = exe.parent() {
        paths.push(parent.join(SIDECAR_BINARY));
    }
    paths.push(
        manifest_dir
            .join("binaries")
            .join(format!("{SIDECAR_BINARY}-{triple}")),
    );
    paths
}

/// First sidecar candidate that is not the menu-bar shell itself.
pub fn resolve_sidecar(
    resource_dir: Option<&Path>,
    exe: &Path,
    manifest_dir: &Path,
    triple: &str,
) -> Option<SidecarCandidate> {
    sidecar_search_paths(resource_dir, exe, manifest_dir, triple)
        .into_iter()
        .find_map(|path| inspect_sidecar(&path, exe))
}

pub fn inspect_sidecar(path: &Path, current_exe: &Path) -> Option<SidecarCandidate> {
    if path.file_name().and_then(|name| name.to_str()) == Some(SHELL_BINARY) {
        return None;
    }
    if same_file(path, current_exe) {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let mut header = [0_u8; 4];
    let read = file.read(&mut header).ok()?;
    Some(SidecarCandidate {
        path: path.to_path_buf(),
        native: is_native_executable(&header[..read]),
    })
}

pub fn parse_command(input: &str) -> Result<(String, Vec<String>), CommandError> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => in_quote = !in_quote,
            '\\' if in_quote => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ch if ch.is_whitespace() && !in_quote => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if in_quote {
        return Err(CommandError::UnclosedQuote);
    }
    if !current.is_empty() {
        parts.push(current);
    }
    let mut parts = parts.into_iter();
    let program = parts.next().ok_or(CommandError::Empty)?;
    Ok((program, parts.collect()))
}

pub fn launch_sequence(
    sidecar: Option<SidecarCandidate>,
    env_cmd: Option<&str>,
) -> Result<LaunchSequence, LaunchError> {
    let command = match env_cmd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Some(parse_command(value).map_err(|_| LaunchError::BadCommand)?),
        None => None,
    };
    let command_spec = command.map(|(program, args)| LaunchSpec::Command { program, args });
    match sidecar {
        Some(candidate) if candidate.native => Ok(LaunchSequence {
            primary: LaunchSpec::Sidecar(candidate.path),
            fallback: command_spec,
        }),
        Some(candidate) if command_spec.is_none() => Ok(LaunchSequence {
            primary: LaunchSpec::Sidecar(candidate.path),
            fallback: None,
        }),
        _ => command_spec
            .map(|primary| LaunchSequence {
                primary,
                fallback: None,
            })
            .ok_or(LaunchError::Missing),
    }
}

pub fn launch_environment(
    spec: &LaunchSpec,
    data_dir: &Path,
    resource_dir: Option<&Path>,
    home_dir: Option<&str>,
) -> Vec<(&'static str, PathBuf)> {
    let mut env = vec![("YOU_BRAIN_DATA_DIR", data_dir.to_path_buf())];
    if let Some(home) = nonempty(home_dir) {
        env.push(("YOU_BRAIN_HOME", PathBuf::from(home)));
    }
    if matches!(spec, LaunchSpec::Sidecar(_)) {
        if let Some(dir) = resource_dir {
            env.push(("YOU_BRAIN_WEB_DIR", dir.join("web")));
            env.push(("YOU_BRAIN_VENDOR_DIR", dir.join("vendor")));
        }
    }
    env
}

pub fn spawn_detached(
    spec: &LaunchSpec,
    data_dir: &Path,
    resource_dir: Option<&Path>,
) -> std::io::Result<()> {
    let mut command = match spec {
        LaunchSpec::Sidecar(path) => {
            let mut command = Command::new(path);
            command.arg("daemon");
            command
        }
        LaunchSpec::Command { program, args } => {
            let mut command = Command::new(program);
            command.args(args);
            command
        }
    };
    let home = std::env::var("YOU_BRAIN_HOME").ok();
    for (key, value) in launch_environment(spec, data_dir, resource_dir, home.as_deref()) {
        command.env(key, value);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    // A new process group keeps the daemon alive after the menu-bar shell exits.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let _child = command.spawn()?;
    Ok(())
}

pub fn process_is_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    #[cfg(unix)]
    {
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

pub fn parse_shell_file(text: &str) -> ShellFile {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return ShellFile::default();
    };
    ShellFile {
        shortcut: value
            .get("shortcut")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        autostart: value.get("autostart").and_then(serde_json::Value::as_bool),
    }
}

pub fn shared_shortcut(config_json: &serde_json::Value) -> Option<String> {
    config_json
        .pointer("/ui/shortcut")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn resolve_user_path(value: &str, home: &Path, cwd: &Path) -> PathBuf {
    let expanded = if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(value)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    }
}

fn normalize(path: PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn json_port(value: &serde_json::Value) -> Option<u16> {
    let number = value.as_u64()?;
    u16::try_from(number).ok().filter(|port| *port != 0)
}

fn json_pid(value: &serde_json::Value) -> Option<u32> {
    let number = value.as_u64()?;
    if number == 0 || number > i32::MAX as u64 {
        return None;
    }
    u32::try_from(number).ok()
}

fn same_file(left: &Path, right: &Path) -> bool {
    if same_inode(left, right) {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

#[cfg(unix)]
fn same_inode(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(left) = std::fs::metadata(left) else {
        return false;
    };
    let Ok(right) = std::fs::metadata(right) else {
        return false;
    };
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_inode(_left: &Path, _right: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[cfg(unix)]
    struct TempDir(PathBuf);

    #[cfg(unix)]
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn macos_data_dir_uses_application_support() {
        let dir = resolve_data_dir(
            DesktopPlatform::MacOs,
            Path::new("/Users/test"),
            None,
            None,
            Path::new("/work"),
        );
        assert_eq!(
            dir,
            PathBuf::from("/Users/test/Library/Application Support/you-brain")
        );
        assert_eq!(
            daemon_file(&dir),
            PathBuf::from("/Users/test/Library/Application Support/you-brain/daemon.json")
        );
    }

    #[test]
    fn data_dir_env_overrides_and_expands_home() {
        let dir = resolve_data_dir(
            DesktopPlatform::MacOs,
            Path::new("/Users/test"),
            Some("~/yb-data"),
            None,
            Path::new("/work"),
        );
        assert_eq!(dir, PathBuf::from("/Users/test/yb-data"));
    }

    #[test]
    fn empty_data_dir_env_is_ignored_and_relative_env_uses_cwd() {
        let untouched = resolve_data_dir(
            DesktopPlatform::Linux,
            Path::new("/home/test"),
            Some("  "),
            None,
            Path::new("/work"),
        );
        assert_eq!(
            untouched,
            PathBuf::from("/home/test/.local/state/you-brain")
        );

        let relative = resolve_data_dir(
            DesktopPlatform::Linux,
            Path::new("/home/test"),
            Some("relative-data"),
            Some("/custom/state"),
            Path::new("/work"),
        );
        assert_eq!(relative, PathBuf::from("/work/relative-data"));

        let xdg = resolve_data_dir(
            DesktopPlatform::Linux,
            Path::new("/home/test"),
            None,
            Some("/custom/state"),
            Path::new("/work"),
        );
        assert_eq!(xdg, PathBuf::from("/custom/state/you-brain"));
    }

    #[test]
    fn parses_daemon_json_and_rejects_bad_payloads() {
        let endpoint =
            parse_daemon_json(r#"{"port":8787,"token":"0123456789abcdef","pid":42,"extra":true}"#)
                .unwrap();
        assert_eq!(endpoint.port, 8787);
        assert_eq!(endpoint.token, "0123456789abcdef");
        assert_eq!(endpoint.pid, 42);

        assert_eq!(
            parse_daemon_json("{").unwrap_err(),
            DaemonJsonError::InvalidJson
        );
        assert_eq!(
            parse_daemon_json(r#"{"port":1}"#).unwrap_err(),
            DaemonJsonError::MissingFields
        );
        assert!(parse_daemon_json(r#"{"port":0,"token":"0123456789abcdef","pid":1}"#).is_err());
        assert!(parse_daemon_json(r#"{"port":1,"token":"short-token","pid":1}"#).is_err());
        assert!(parse_daemon_json(r#"{"port":1.5,"token":"0123456789abcdef","pid":1}"#).is_err());
        assert!(parse_daemon_json(r#"{"port":1,"token":"0123456789abcdef","pid":0}"#).is_err());
    }

    #[test]
    fn launch_decision_matches_missing_dead_or_unreachable() {
        let cases = [
            (None, false, false, EndpointState::Missing, true),
            (
                Some(Err(DaemonJsonError::InvalidJson)),
                false,
                false,
                EndpointState::Invalid,
                true,
            ),
            (Some(Ok(())), false, true, EndpointState::Dead, true),
            (Some(Ok(())), true, false, EndpointState::Unreachable, true),
            (Some(Ok(())), true, true, EndpointState::Healthy, false),
        ];
        for (parsed, alive, status, state, launch) in cases {
            assert_eq!(classify_endpoint(parsed, alive, status), state);
            assert_eq!(should_launch(state), launch);
        }
        assert!(status_is_healthy(Some(200)));
        assert!(status_is_healthy(Some(204)));
        assert!(!status_is_healthy(Some(401)));
        assert!(!status_is_healthy(None));
    }

    #[test]
    fn command_parser_keeps_quoted_arguments() {
        let (program, args) = parse_command(r#"bun "/path/with spaces/index.ts" daemon"#).unwrap();
        assert_eq!(program, "bun");
        assert_eq!(args, vec!["/path/with spaces/index.ts", "daemon"]);
        assert_eq!(parse_command("   ").unwrap_err(), CommandError::Empty);
        assert_eq!(
            parse_command(r#"bun "unterminated"#).unwrap_err(),
            CommandError::UnclosedQuote
        );
    }

    #[test]
    fn native_sidecar_wins_over_the_dev_command() {
        let native = SidecarCandidate {
            path: PathBuf::from("/App/you-brain"),
            native: true,
        };
        let sequence = launch_sequence(
            Some(native),
            Some("bun /repo/packages/cli/src/index.ts daemon"),
        )
        .unwrap();
        assert_eq!(
            sequence.primary,
            LaunchSpec::Sidecar(PathBuf::from("/App/you-brain"))
        );
        assert_eq!(
            sequence.fallback,
            Some(LaunchSpec::Command {
                program: "bun".into(),
                args: vec!["/repo/packages/cli/src/index.ts".into(), "daemon".into()],
            })
        );
    }

    #[test]
    fn placeholder_sidecar_defers_to_the_dev_command() {
        let placeholder = SidecarCandidate {
            path: PathBuf::from("/dev/you-brain"),
            native: false,
        };
        let sequence = launch_sequence(
            Some(placeholder.clone()),
            Some("bun cli/src/index.ts daemon"),
        )
        .unwrap();
        assert_eq!(
            sequence.primary,
            LaunchSpec::Command {
                program: "bun".into(),
                args: vec!["cli/src/index.ts".into(), "daemon".into()],
            }
        );
        assert_eq!(sequence.fallback, None);

        let only_placeholder = launch_sequence(Some(placeholder), None).unwrap();
        assert_eq!(
            only_placeholder.primary,
            LaunchSpec::Sidecar(PathBuf::from("/dev/you-brain"))
        );
        assert!(launch_sequence(None, Some(" ")).is_err());
    }

    #[test]
    fn executable_magic_recognizes_mach_o_and_elf() {
        assert!(is_native_executable(&[0xCF, 0xFA, 0xED, 0xFE]));
        assert!(is_native_executable(&[0xCA, 0xFE, 0xBA, 0xBE]));
        assert!(is_native_executable(b"\x7FELF"));
        assert!(!is_native_executable(b"#!/b"));
        assert!(!is_native_executable(b"abc"));
    }

    #[test]
    fn sidecar_launch_points_at_bundled_web_and_vendor() {
        let data = Path::new("/Library/Application Support/you-brain");
        let resources = Path::new("/App/Contents/Resources");
        let sidecar = LaunchSpec::Sidecar(PathBuf::from("/App/Contents/MacOS/you-brain"));
        assert_eq!(
            launch_environment(&sidecar, data, Some(resources), None),
            vec![
                ("YOU_BRAIN_DATA_DIR", data.to_path_buf()),
                ("YOU_BRAIN_WEB_DIR", resources.join("web")),
                ("YOU_BRAIN_VENDOR_DIR", resources.join("vendor")),
            ]
        );
        assert_eq!(
            launch_environment(&sidecar, data, Some(resources), Some("/tmp/yb-home")),
            vec![
                ("YOU_BRAIN_DATA_DIR", data.to_path_buf()),
                ("YOU_BRAIN_HOME", PathBuf::from("/tmp/yb-home")),
                ("YOU_BRAIN_WEB_DIR", resources.join("web")),
                ("YOU_BRAIN_VENDOR_DIR", resources.join("vendor")),
            ]
        );
        assert_eq!(
            launch_environment(&sidecar, data, Some(resources), Some("  ")),
            vec![
                ("YOU_BRAIN_DATA_DIR", data.to_path_buf()),
                ("YOU_BRAIN_WEB_DIR", resources.join("web")),
                ("YOU_BRAIN_VENDOR_DIR", resources.join("vendor")),
            ]
        );
        let dev = LaunchSpec::Command {
            program: "bun".into(),
            args: vec!["daemon".into()],
        };
        assert_eq!(
            launch_environment(&dev, data, Some(resources), Some("/tmp/yb-home")),
            vec![
                ("YOU_BRAIN_DATA_DIR", data.to_path_buf()),
                ("YOU_BRAIN_HOME", PathBuf::from("/tmp/yb-home")),
            ]
        );
        assert_eq!(
            launch_environment(&sidecar, data, None, None),
            vec![("YOU_BRAIN_DATA_DIR", data.to_path_buf())]
        );
    }

    #[test]
    fn sidecar_paths_cover_bundle_and_repo_locations() {
        let paths = sidecar_search_paths(
            Some(Path::new("/App/Contents/Resources")),
            Path::new("/App/Contents/MacOS/you-brain-desktop"),
            Path::new("/repo/apps/desktop/src-tauri"),
            "x86_64-apple-darwin",
        );
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/App/Contents/Resources/you-brain"),
                PathBuf::from("/App/Contents/Resources/binaries/you-brain"),
                PathBuf::from("/App/Contents/MacOS/you-brain"),
                PathBuf::from(
                    "/repo/apps/desktop/src-tauri/binaries/you-brain-x86_64-apple-darwin"
                ),
            ]
        );
    }

    #[test]
    #[cfg(unix)]
    fn renamed_shell_finds_macos_sidecar_and_skips_itself() {
        let root = std::env::temp_dir().join(format!(
            "you-brain-sidecar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _guard = TempDir(root.clone());
        let macos = root.join("Contents/MacOS");
        let resources = root.join("Contents/Resources");
        let manifest = root.join("src-tauri");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::create_dir_all(&manifest).unwrap();
        let shell = macos.join("you-brain-desktop");
        let sidecar = macos.join("you-brain");
        let macho = [0xCF_u8, 0xFA, 0xED, 0xFE];
        std::fs::write(&shell, macho).unwrap();
        std::fs::write(&sidecar, macho).unwrap();
        let triple = "aarch64-apple-darwin";

        let found = resolve_sidecar(Some(&resources), &shell, &manifest, triple).unwrap();
        assert_eq!(found.path, sidecar);
        assert!(found.native);

        assert!(inspect_sidecar(&shell, &shell).is_none());
        let other = root.join("not-the-shell");
        std::fs::write(&other, macho).unwrap();
        assert!(inspect_sidecar(&shell, &other).is_none());

        std::fs::remove_file(&sidecar).unwrap();
        std::os::unix::fs::symlink(&shell, &sidecar).unwrap();
        assert!(resolve_sidecar(Some(&resources), &shell, &manifest, triple).is_none());

        std::fs::remove_file(&sidecar).unwrap();
        std::fs::hard_link(&shell, &sidecar).unwrap();
        assert!(resolve_sidecar(Some(&resources), &shell, &manifest, triple).is_none());

        std::fs::remove_file(&sidecar).unwrap();
        std::fs::write(&sidecar, macho).unwrap();
        assert!(resolve_sidecar(Some(&resources), &sidecar, &manifest, triple).is_none());
    }

    #[test]
    fn shell_file_reads_shortcut_and_autostart() {
        let file = parse_shell_file(r#"{"shortcut":"Ctrl+Alt+Y","autostart":false}"#);
        assert_eq!(file.shortcut.as_deref(), Some("Ctrl+Alt+Y"));
        assert_eq!(file.autostart, Some(false));
        assert_eq!(parse_shell_file("{"), ShellFile::default());
    }

    #[test]
    fn current_process_is_alive_and_a_finished_child_is_not() {
        assert!(process_is_alive(std::process::id()));
        assert!(!process_is_alive(0));
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        assert!(process_is_alive(pid));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!process_is_alive(pid));
    }
}
