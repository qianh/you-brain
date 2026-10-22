use std::time::Duration;

/// How often the shell reads idle time. A post inside this window is skipped.
pub const ACTIVITY_INTERVAL: Duration = Duration::from_secs(30);

/// `HIDIdleTime` is nanoseconds. Strictly below 60 seconds counts as activity.
pub const ACTIVE_IDLE_LIMIT_NS: u64 = 60 * 1_000_000_000;

/// `true` when the user was active and the last successful post is outside the interval.
pub fn should_post_activity(idle_ns: Option<u64>, since_last_post: Option<Duration>) -> bool {
    let Some(idle_ns) = idle_ns else {
        return false;
    };
    if idle_ns >= ACTIVE_IDLE_LIMIT_NS {
        return false;
    }
    !matches!(since_last_post, Some(elapsed) if elapsed < ACTIVITY_INTERVAL)
}

/// First `"HIDIdleTime" = <digits>` in `ioreg` text. The value is nanoseconds.
pub fn parse_hid_idle_ns(output: &str) -> Option<u64> {
    for line in output.lines() {
        if let Some(value) = hid_idle_on_line(line) {
            return Some(value);
        }
    }
    None
}

fn hid_idle_on_line(line: &str) -> Option<u64> {
    const MARKER: &str = "\"HIDIdleTime\"";
    let index = line.find(MARKER)?;
    let rest = line[index + MARKER.len()..].trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let digits = rest.chars().take_while(|ch| ch.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let (number, tail) = rest.split_at(digits);
    if !tail.is_empty() && !tail.starts_with(char::is_whitespace) {
        return None;
    }
    number.parse().ok()
}

/// macOS reads `HIDIdleTime` via `ioreg -c IOHIDSystem -d 4`.
/// `/usr/sbin/ioreg` is used first so a launchd PATH that omits `/usr/sbin` still works.
#[cfg(target_os = "macos")]
pub fn read_hid_idle_ns() -> Option<u64> {
    let output = run_ioreg()?;
    let text = String::from_utf8_lossy(&output.stdout);
    parse_hid_idle_ns(&text)
}

#[cfg(target_os = "macos")]
fn run_ioreg() -> Option<std::process::Output> {
    const ARGS: [&str; 4] = ["-c", "IOHIDSystem", "-d", "4"];
    if let Ok(output) = ioreg_command("/usr/sbin/ioreg", &ARGS).output() {
        return Some(output);
    }
    ioreg_command("ioreg", &ARGS).output().ok()
}

#[cfg(target_os = "macos")]
fn ioreg_command(program: &str, args: &[&str]) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.args(args).stdin(std::process::Stdio::null());
    command
}

/// 非 macOS 没有 IOHIDSystem。留空：不读取输入设备，也不上报活动。
#[cfg(not(target_os = "macos"))]
pub fn read_hid_idle_ns() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_normal_hid_idle_line() {
        let output = r#"  "HIDIdleTime" = 2500000000"#;
        assert_eq!(parse_hid_idle_ns(output), Some(2_500_000_000));
        assert_eq!(parse_hid_idle_ns(r#""HIDIdleTime"=0"#), Some(0));
    }

    #[test]
    fn missing_field_is_none() {
        let output = r#"
          "IOConsoleUsers" = ({})
          "HIDCursor" = 1
        "#;
        assert_eq!(parse_hid_idle_ns(output), None);
        assert_eq!(parse_hid_idle_ns(""), None);
    }

    #[test]
    fn garbage_does_not_yield_a_number() {
        assert_eq!(parse_hid_idle_ns("this is not ioreg output"), None);
        assert_eq!(parse_hid_idle_ns(r#""HIDIdleTime" = nope"#), None);
        assert_eq!(parse_hid_idle_ns(r#""HIDIdleTime" = 12abc"#), None);
        assert_eq!(parse_hid_idle_ns("HIDIdleTime = 5"), None);
    }

    #[test]
    fn finds_hid_idle_among_other_lines() {
        let output = r#"
+-o IOHIDSystem  <class IOHIDSystem, id 0x100000c3a, registered, matched, active, busy 0 (0 ms), retain 8>
  {
    "IOUserClientClass" = "IOHIDSystemUserClient"
    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes})
    "HIDIdleTime" = 42
    "HIDCursor" = 1
  }
"#;
        assert_eq!(parse_hid_idle_ns(output), Some(42));
    }

    #[test]
    fn posts_only_while_active_and_outside_the_interval() {
        assert!(should_post_activity(Some(0), None));
        assert!(should_post_activity(Some(ACTIVE_IDLE_LIMIT_NS - 1), None));
        assert!(!should_post_activity(Some(ACTIVE_IDLE_LIMIT_NS), None));
        assert!(!should_post_activity(None, None));
        assert!(!should_post_activity(
            Some(1_000),
            Some(ACTIVITY_INTERVAL - Duration::from_millis(1))
        ));
        assert!(should_post_activity(Some(1_000), Some(ACTIVITY_INTERVAL)));
    }
}
