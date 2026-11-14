use tauri::webview::Cookie;
use tauri::WebviewWindow;

const DSH_PREFIX: &str = "dsh-auth-";

fn is_dsh_cookie_name(name: &str) -> bool {
    name.strip_prefix(DSH_PREFIX).is_some_and(|hash| {
        hash.len() == 43
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

fn is_stale_dsh_cookie(cookie: &Cookie<'_>, keep: Option<&str>) -> bool {
    cookie.domain() == Some("127.0.0.1")
        && cookie.path() == Some("/")
        && is_dsh_cookie_name(cookie.name())
        && keep != Some(cookie.name())
}

/// dsh hashes its random port into 30-day cookie names, but cookies ignore ports.
/// Only prune its loopback namespace; other login state and localStorage stay intact.
/// Cookie APIs must run off the command/main thread (WebView2 can otherwise deadlock).
pub fn prune(window: &WebviewWindow, keep: Option<&str>) -> Result<usize, String> {
    let cookies = window
        .cookies()
        .map_err(|error| format!("读取 dsh 登录状态失败：{error}"))?;
    let mut removed = 0;
    for cookie in cookies {
        if is_stale_dsh_cookie(&cookie, keep) {
            window
                .delete_cookie(cookie)
                .map_err(|error| format!("清理旧 dsh 登录状态失败：{error}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn prepare_dsh_cookies(
    window: WebviewWindow,
    keep_cookie_name: String,
) -> Result<(), String> {
    if !is_dsh_cookie_name(&keep_cookie_name) {
        return Err("无效的 dsh 登录状态名称".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || prune(&window, Some(&keep_cookie_name)))
        .await
        .map_err(|_| "清理旧 dsh 登录状态失败".to_string())??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(hash: char) -> Cookie<'static> {
        Cookie::build((
            format!("{DSH_PREFIX}{}", hash.to_string().repeat(43)),
            "synthetic",
        ))
        .domain("127.0.0.1")
        .path("/")
        .http_only(true)
        .build()
    }

    #[test]
    fn removes_old_ports_but_keeps_the_active_session() {
        let active = cookie('a');
        let old = cookie('b');
        assert!(is_stale_dsh_cookie(&old, None));
        assert!(is_stale_dsh_cookie(&old, Some(active.name())));
        assert!(!is_stale_dsh_cookie(&active, Some(active.name())));
    }

    #[test]
    fn preserves_other_domains_paths_and_cookie_names() {
        let mut other_domain = cookie('a');
        other_domain.set_domain("example.com");
        assert!(!is_stale_dsh_cookie(&other_domain, None));
        let mut other_path = cookie('a');
        other_path.set_path("/another-app");
        assert!(!is_stale_dsh_cookie(&other_path, None));
        for name in ["login", "dsh-auth-settings", "dsh-auth-", "dsh-auth-中文"] {
            let unrelated = Cookie::build((name, "synthetic"))
                .domain("127.0.0.1")
                .path("/")
                .build();
            assert!(!is_stale_dsh_cookie(&unrelated, None));
        }
    }

    #[test]
    fn accepts_only_sha256_base64url_cookie_names() {
        assert!(is_dsh_cookie_name(&format!(
            "{DSH_PREFIX}{}",
            "a-_0".repeat(10) + "ABC"
        )));
        for hash in [
            "a".repeat(42),
            "a".repeat(44),
            "+".repeat(43),
            "=".repeat(43),
        ] {
            assert!(!is_dsh_cookie_name(&format!("{DSH_PREFIX}{hash}")));
        }
    }
}
