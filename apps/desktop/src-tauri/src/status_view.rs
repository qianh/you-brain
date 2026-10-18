#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusSnapshot {
    pub drive_reachable: Option<bool>,
    pub last_sync_at: Option<String>,
    pub pending_outbox: u64,
    pub warnings: Vec<String>,
    pub refine_error: Option<String>,
    pub consolidation_stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayPresentation {
    pub title: String,
    pub tooltip: String,
    /// Empty when there is nothing to badge. Compared across polls to decide notifications.
    pub attention: String,
}

pub fn parse_status_json(text: &str) -> Result<StatusSnapshot, ()> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| ())?;
    parse_status_value(&value)
}

pub fn parse_status_value(value: &serde_json::Value) -> Result<StatusSnapshot, ()> {
    if !value.is_object() {
        return Err(());
    }
    Ok(StatusSnapshot {
        drive_reachable: optional_bool(value.pointer("/drive/reachable")),
        last_sync_at: optional_string(value.pointer("/sync/lastSyncAt")),
        pending_outbox: value
            .pointer("/sync/pendingOutbox")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        warnings: warning_messages(value.get("warnings")),
        refine_error: optional_string(value.pointer("/refine/lastError")),
        consolidation_stale: value
            .pointer("/consolidation/stale")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn reminder_count(value: &serde_json::Value) -> usize {
    value
        .get("reminders")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

pub fn present(status: &StatusSnapshot, reminders: usize) -> TrayPresentation {
    let anomalies = anomaly_lines(status);
    let attention = attention_key(&anomalies, reminders);
    let title = if !anomalies.is_empty() {
        format!("异常 {}", anomalies.len())
    } else if reminders > 0 {
        format!("提醒 {reminders}")
    } else if status.pending_outbox > 0 {
        format!("待同步 {}", status.pending_outbox)
    } else if status.last_sync_at.is_some() {
        "已同步".to_string()
    } else {
        "未同步".to_string()
    };
    let mut tooltip = format!(
        "you-brain\n同步：{}\n待上传：{}\n提醒：{reminders}",
        status.last_sync_at.as_deref().unwrap_or("从未"),
        status.pending_outbox,
    );
    if !anomalies.is_empty() {
        tooltip.push_str("\n异常：");
        tooltip.push_str(&anomalies.join("；"));
    }
    TrayPresentation {
        title,
        tooltip,
        attention,
    }
}

pub fn disconnected() -> TrayPresentation {
    TrayPresentation {
        title: "未连接".to_string(),
        tooltip: "you-brain\ndaemon 未连接".to_string(),
        attention: String::new(),
    }
}

pub fn notification_body(status: &StatusSnapshot, reminders: usize) -> String {
    let anomalies = anomaly_lines(status);
    if let Some(message) = anomalies.first() {
        return format!("异常：{message}");
    }
    if reminders > 0 {
        return format!("有 {reminders} 条提醒");
    }
    String::new()
}

pub fn should_notify(previous: Option<&str>, next: &str) -> bool {
    previous.is_some() && !next.is_empty() && previous != Some(next)
}

fn anomaly_lines(status: &StatusSnapshot) -> Vec<String> {
    let mut lines = status.warnings.clone();
    if status.drive_reachable == Some(false) && !lines.iter().any(|line| line.contains("Drive")) {
        lines.push("Drive 不可达".to_string());
    }
    if let Some(error) = &status.refine_error {
        if !lines.iter().any(|line| line == error) {
            lines.push(error.clone());
        }
    }
    if status.consolidation_stale && !lines.iter().any(|line| line.contains("沉淀")) {
        lines.push("沉淀已过期".to_string());
    }
    lines
}

fn attention_key(anomalies: &[String], reminders: usize) -> String {
    if anomalies.is_empty() && reminders == 0 {
        return String::new();
    }
    format!("r:{reminders}\n{}", anomalies.join("\n"))
}

fn warning_messages(value: Option<&serde_json::Value>) -> Vec<String> {
    let Some(items) = value.and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            item.get("message")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(str::to_string)
        })
        .collect()
}

fn optional_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn optional_bool(value: Option<&serde_json::Value>) -> Option<bool> {
    value.and_then(serde_json::Value::as_bool)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> StatusSnapshot {
        StatusSnapshot {
            drive_reachable: Some(true),
            last_sync_at: Some("2026-10-18T02:00:00Z".into()),
            pending_outbox: 0,
            warnings: Vec::new(),
            refine_error: None,
            consolidation_stale: false,
        }
    }

    #[test]
    fn healthy_status_shows_synced_without_a_badge() {
        let view = present(&sample(), 0);
        assert_eq!(view.title, "已同步");
        assert!(view.attention.is_empty());
        assert!(view.tooltip.contains("同步：2026-10-18T02:00:00Z"));
        assert!(!view.tooltip.contains("异常"));
    }

    #[test]
    fn warnings_and_reminders_set_the_badge() {
        let mut status = sample();
        status.warnings.push("队列堵塞".into());
        status.drive_reachable = Some(false);
        let view = present(&status, 2);
        assert_eq!(view.title, "异常 2");
        assert!(view.tooltip.contains("提醒：2"));
        assert!(view.tooltip.contains("队列堵塞"));
        assert!(view.tooltip.contains("Drive 不可达"));
        assert!(!view.attention.is_empty());
    }

    #[test]
    fn reminders_alone_use_the_reminder_title() {
        let view = present(&sample(), 3);
        assert_eq!(view.title, "提醒 3");
        assert_eq!(notification_body(&sample(), 3), "有 3 条提醒");
    }

    #[test]
    fn pending_and_never_synced_stay_quiet() {
        let mut status = sample();
        status.last_sync_at = None;
        status.pending_outbox = 4;
        assert_eq!(present(&status, 0).title, "待同步 4");
        status.pending_outbox = 0;
        assert_eq!(present(&status, 0).title, "未同步");
        assert_eq!(disconnected().title, "未连接");
    }

    #[test]
    fn notification_fires_only_when_attention_changes() {
        assert!(!should_notify(None, "r:1\n"));
        assert!(!should_notify(Some(""), ""));
        assert!(should_notify(Some(""), "r:1\nboom"));
        assert!(!should_notify(Some("r:1\nboom"), "r:1\nboom"));
        assert!(!should_notify(Some("r:1\nboom"), ""));
    }

    #[test]
    fn parses_the_daemon_status_shape() {
        let status = parse_status_json(
            r#"{"deviceId":null,"drive":{"reachable":false,"accountEmail":null},"sync":{"lastSyncAt":null,"pendingOutbox":2},"search":{"ready":false,"documents":0},"refine":{"pending":0,"lastError":"timeout"},"consolidation":{"lastFinishedAt":null,"stale":true},"warnings":[{"code":"DRIVE","message":"offline"}]}"#,
        )
        .unwrap();
        assert_eq!(status.drive_reachable, Some(false));
        assert_eq!(status.pending_outbox, 2);
        assert_eq!(status.warnings, vec!["offline".to_string()]);
        assert_eq!(status.refine_error.as_deref(), Some("timeout"));
        assert!(status.consolidation_stale);
        assert!(parse_status_json("[]").is_err());
        let reminders = serde_json::json!({"reminders":[{},{}]});
        assert_eq!(reminder_count(&reminders), 2);
    }
}
