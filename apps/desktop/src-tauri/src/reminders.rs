use std::path::Path;

pub const NOTIFIED_CAP: usize = 200;
pub const NOTIFY_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
pub const NOTIFICATION_LINE_MAX: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderNotice {
    pub reminder_id: String,
    pub text: String,
    pub issued_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderDelivery {
    pub notify: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemindersSnapshot {
    pub reminders: Vec<ReminderNotice>,
    /// Length of the `reminders` array. The badge uses this, including entries
    /// that were skipped because they had no id.
    pub count: usize,
    pub delivery: Option<ReminderDelivery>,
}

pub fn parse_reminders_response(text: &str) -> Result<RemindersSnapshot, ()> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    let items = object
        .get("reminders")
        .and_then(serde_json::Value::as_array)
        .ok_or(())?;
    let count = items.len();
    let mut reminders = Vec::new();
    for item in items {
        let Some(id) = item
            .get("reminderId")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        reminders.push(ReminderNotice {
            reminder_id: id.to_string(),
            text: item
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            issued_at: item
                .get("issuedAt")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    let delivery = match object.get("delivery") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => Some(ReminderDelivery {
            notify: value
                .get("notify")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        }),
    };
    Ok(RemindersSnapshot {
        reminders,
        count,
        delivery,
    })
}

/// Reminders the shell should pop. Empty when `delivery` is missing or `notify` is false,
/// so the caller must not mark those ids.
pub fn select_reminders_to_notify(
    reminders: &[ReminderNotice],
    delivery: Option<&ReminderDelivery>,
    notified: &[String],
    now_ms: i64,
) -> Vec<ReminderNotice> {
    if !delivery.is_some_and(|gate| gate.notify) {
        return Vec::new();
    }
    let mut ranked = Vec::new();
    let mut seen = Vec::new();
    for item in reminders {
        if item.reminder_id.is_empty() || seen.iter().any(|id: &String| id == &item.reminder_id) {
            continue;
        }
        if notified.iter().any(|id| id == &item.reminder_id) {
            continue;
        }
        let Some(issued_ms) = parse_rfc3339_ms(&item.issued_at) else {
            continue;
        };
        let Some(age) = now_ms.checked_sub(issued_ms) else {
            continue;
        };
        if !(0..=NOTIFY_WINDOW_MS).contains(&age) {
            continue;
        }
        seen.push(item.reminder_id.clone());
        ranked.push((issued_ms, item.clone()));
    }
    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.reminder_id.cmp(&right.1.reminder_id))
    });
    ranked.into_iter().map(|(_, item)| item).collect()
}

/// Body for one notification. The slice is newest-first, as `select_reminders_to_notify` returns it.
pub fn notification_text(reminders: &[ReminderNotice]) -> String {
    let Some(newest) = reminders.first() else {
        return String::new();
    };
    let line = truncate_chars(&first_line(&newest.text), NOTIFICATION_LINE_MAX);
    if reminders.len() == 1 {
        return line;
    }
    format!("{line}（另有 {} 条）", reminders.len() - 1)
}

pub fn parse_notified_ids(text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(items) = value.get("ids").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for item in items {
        let Some(id) = item.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
            continue;
        };
        if let Some(pos) = ids.iter().position(|existing: &String| existing == id) {
            ids.remove(pos);
        }
        ids.push(id.to_string());
    }
    trim_notified(&mut ids);
    ids
}

/// Append newly notified ids (newest ends up last) and keep the most recent `NOTIFIED_CAP`.
pub fn remember_notified(existing: &[String], selected: &[ReminderNotice]) -> Vec<String> {
    let mut ids = existing.to_vec();
    for item in selected.iter().rev() {
        if item.reminder_id.is_empty() {
            continue;
        }
        if let Some(pos) = ids.iter().position(|id| id == &item.reminder_id) {
            ids.remove(pos);
        }
        ids.push(item.reminder_id.clone());
    }
    trim_notified(&mut ids);
    ids
}

pub fn load_notified(path: &Path) -> Vec<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_notified_ids(&text),
        Err(_) => Vec::new(),
    }
}

/// Write `{ "ids": [...] }`. A failure leaves the previous file alone and does not panic.
pub fn save_notified(path: &Path, ids: &[String]) {
    let Ok(payload) = serde_json::to_vec(&serde_json::json!({ "ids": ids })) else {
        return;
    };
    let Some(parent) = path.parent() else {
        let _ = std::fs::write(path, payload);
        return;
    };
    let tmp = parent.join(".shell-notified.json.tmp");
    if std::fs::write(&tmp, &payload).is_err() {
        return;
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn trim_notified(ids: &mut Vec<String>) {
    if ids.len() > NOTIFIED_CAP {
        let extra = ids.len() - NOTIFIED_CAP;
        ids.drain(..extra);
    }
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

fn parse_rfc3339_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    if text.len() < 20 {
        return None;
    }
    let year = text.get(0..4)?.parse::<i32>().ok()?;
    if text.as_bytes().get(4) != Some(&b'-') || text.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let month = text.get(5..7)?.parse::<u32>().ok()?;
    let day = text.get(8..10)?.parse::<u32>().ok()?;
    if text.as_bytes().get(10) != Some(&b'T') && text.as_bytes().get(10) != Some(&b't') {
        return None;
    }
    if text.as_bytes().get(13) != Some(&b':') || text.as_bytes().get(16) != Some(&b':') {
        return None;
    }
    let hour = text.get(11..13)?.parse::<u32>().ok()?;
    let minute = text.get(14..16)?.parse::<u32>().ok()?;
    let second = text.get(17..19)?.parse::<u32>().ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let rest = text.get(19..)?;
    let (millis, rest) = parse_fraction_ms(rest)?;
    let offset_ms = parse_offset_ms(rest)?;
    if day == 0 || day > days_in_month(year, month) {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let secs = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour) * 3_600)?
        .checked_add(i64::from(minute) * 60)?
        .checked_add(i64::from(second))?;
    secs.checked_mul(1_000)?
        .checked_add(millis)?
        .checked_sub(offset_ms)
}

fn parse_fraction_ms(rest: &str) -> Option<(i64, &str)> {
    if !rest.starts_with('.') {
        return Some((0, rest));
    }
    let digits_len = rest[1..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .count();
    if digits_len == 0 {
        return None;
    }
    let digits = &rest[1..1 + digits_len];
    let millis = if digits.len() >= 3 {
        digits[..3].parse::<i64>().ok()?
    } else if digits.len() == 2 {
        digits.parse::<i64>().ok()? * 10
    } else {
        digits.parse::<i64>().ok()? * 100
    };
    Some((millis, &rest[1 + digits_len..]))
}

fn parse_offset_ms(rest: &str) -> Option<i64> {
    if rest == "Z" || rest == "z" {
        return Some(0);
    }
    let (sign, rest) = if let Some(rest) = rest.strip_prefix('+') {
        (1_i64, rest)
    } else if let Some(rest) = rest.strip_prefix('-') {
        (-1, rest)
    } else {
        return None;
    };
    let (hours, minutes) = if rest.len() == 5 && rest.as_bytes().get(2) == Some(&b':') {
        (
            rest.get(0..2)?.parse::<i64>().ok()?,
            rest.get(3..5)?.parse::<i64>().ok()?,
        )
    } else if rest.len() == 4 && rest.bytes().all(|byte| byte.is_ascii_digit()) {
        (
            rest.get(0..2)?.parse::<i64>().ok()?,
            rest.get(2..4)?.parse::<i64>().ok()?,
        )
    } else {
        return None;
    };
    if !(0..=23).contains(&hours) || !(0..=59).contains(&minutes) {
        return None;
    }
    Some(sign * (hours * 60 + minutes) * 60 * 1000)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Days since the Unix epoch. Howard Hinnant's civil-from-days inverse.
fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) {
        return None;
    }
    let y = i64::from(year) - if month <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u64;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * u64::from(mp) + 2) / 5 + u64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe as i64 - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(id: &str, text: &str, issued_at: &str) -> ReminderNotice {
        ReminderNotice {
            reminder_id: id.to_string(),
            text: text.to_string(),
            issued_at: issued_at.to_string(),
        }
    }

    fn gate(notify: bool) -> ReminderDelivery {
        ReminderDelivery { notify }
    }

    struct TempDir(std::path::PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir() -> TempDir {
        let path = std::env::temp_dir().join(format!(
            "you-brain-notified-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    #[test]
    fn rfc3339_millis_match_known_instants() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.123Z"), Some(123));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01Z"), Some(1_000));
        assert_eq!(parse_rfc3339_ms("1970-01-02T00:00:00.000Z"), Some(86_400_000));
        assert_eq!(
            parse_rfc3339_ms("2000-01-01T00:00:00.000Z"),
            Some(946_684_800_000)
        );
        assert_eq!(parse_rfc3339_ms("1970-01-01T08:00:00.000+08:00"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.5Z"), Some(500));
        let feb29 = parse_rfc3339_ms("2024-02-29T00:00:00.000Z").unwrap();
        let mar1 = parse_rfc3339_ms("2024-03-01T00:00:00.000Z").unwrap();
        assert_eq!(mar1 - feb29, 86_400_000);
        assert!(parse_rfc3339_ms("2023-02-29T00:00:00.000Z").is_none());
        assert!(parse_rfc3339_ms("1900-02-29T00:00:00.000Z").is_none());
        assert!(parse_rfc3339_ms("not-a-time").is_none());
    }

    #[test]
    fn window_keeps_unnotified_reminders_from_the_last_day() {
        let now = parse_rfc3339_ms("2026-10-23T12:00:00.000Z").unwrap();
        assert_eq!(
            now - parse_rfc3339_ms("2026-10-22T12:00:00.000Z").unwrap(),
            NOTIFY_WINDOW_MS
        );
        let reminders = vec![
            notice("c", "边界", "2026-10-22T12:00:00.000Z"),
            notice("d", "过期", "2026-10-22T11:59:59.999Z"),
            notice("a", "新的\n第二行", "2026-10-23T11:00:00.000Z"),
            notice("b", "中间", "2026-10-22T13:00:00.000Z"),
            notice("e", "已通知", "2026-10-23T11:59:00.000Z"),
            notice("f", "未来", "2026-10-23T12:00:00.001Z"),
            notice("g", "坏时间", "yesterday"),
            notice("a", "重复", "2026-10-23T11:30:00.000Z"),
        ];
        let selected = select_reminders_to_notify(
            &reminders,
            Some(&gate(true)),
            &["e".to_string()],
            now,
        );
        assert_eq!(
            selected
                .iter()
                .map(|item| item.reminder_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn equal_issued_at_follows_reminder_id_order() {
        let now = parse_rfc3339_ms("2026-10-23T12:00:00.000Z").unwrap();
        let reminders = vec![
            notice("b", "B", "2026-10-23T11:00:00.000Z"),
            notice("a", "A", "2026-10-23T11:00:00.000Z"),
        ];
        let selected =
            select_reminders_to_notify(&reminders, Some(&gate(true)), &[], now);
        assert_eq!(selected[0].reminder_id, "a");
        assert_eq!(selected[1].reminder_id, "b");
    }

    #[test]
    fn notify_false_missing_delivery_and_empty_list_select_nothing() {
        let now = parse_rfc3339_ms("2026-10-23T12:00:00.000Z").unwrap();
        let reminders = vec![notice("a", "hi", "2026-10-23T11:00:00.000Z")];
        assert!(select_reminders_to_notify(&reminders, None, &[], now).is_empty());
        assert!(select_reminders_to_notify(&reminders, Some(&gate(false)), &[], now).is_empty());
        assert!(select_reminders_to_notify(&[], Some(&gate(true)), &[], now).is_empty());

        let blanks = parse_reminders_response(r#"{"reminders":[{},{}]}"#).unwrap();
        assert_eq!(blanks.count, 2);
        assert!(blanks.reminders.is_empty());

        let without_delivery = parse_reminders_response(
            r#"{"reminders":[{"reminderId":"a","text":"hi","issuedAt":"2026-10-23T11:00:00.000Z"}]}"#,
        )
        .unwrap();
        assert_eq!(without_delivery.count, 1);
        assert!(without_delivery.delivery.is_none());
        assert!(select_reminders_to_notify(
            &without_delivery.reminders,
            without_delivery.delivery.as_ref(),
            &[],
            now,
        )
        .is_empty());

        let inactive = parse_reminders_response(
            r#"{"reminders":[{"reminderId":"a","text":"hi","issuedAt":"2026-10-23T11:00:00.000Z"}],"delivery":{"notify":false,"reason":"other-device"}}"#,
        )
        .unwrap();
        assert_eq!(inactive.delivery, Some(gate(false)));
        assert!(select_reminders_to_notify(
            &inactive.reminders,
            inactive.delivery.as_ref(),
            &[],
            now,
        )
        .is_empty());
    }

    #[test]
    fn notification_text_uses_the_first_line_and_caps_it() {
        let exact: String = "甲".repeat(80);
        assert_eq!(
            notification_text(&[notice("a", &exact, "")]),
            exact
        );
        let long = format!("{}乙", "甲".repeat(80));
        assert_eq!(
            notification_text(&[notice("a", &long, "")]),
            "甲".repeat(80)
        );
        assert_eq!(
            notification_text(&[notice("a", "  第一行  \r\n第二行", "")]),
            "第一行"
        );
        let many = vec![
            notice("new", "最新一行\n不要这行", ""),
            notice("old", "更早的", ""),
            notice("older", "再早", ""),
        ];
        assert_eq!(notification_text(&many), "最新一行（另有 2 条）");
        let wide = "a".repeat(100);
        let body = notification_text(&[notice("a", &wide, ""), notice("b", "其他", "")]);
        assert!(body.starts_with(&"a".repeat(80)));
        assert!(body.ends_with("（另有 1 条）"));
        assert_eq!(
            body.chars().count(),
            80 + "（另有 1 条）".chars().count()
        );
        assert!(notification_text(&[]).is_empty());
    }

    #[test]
    fn notified_file_roundtrip_truncates_and_ignores_corruption() {
        assert!(parse_notified_ids("{").is_empty());
        assert!(parse_notified_ids("[]").is_empty());
        assert!(parse_notified_ids(r#"{"ids":null}"#).is_empty());
        assert_eq!(
            parse_notified_ids(r#"{"ids":["a",1,"a"," b "]}"#),
            vec!["a".to_string(), "b".to_string()]
        );

        let mut raw = Vec::new();
        for index in 0..250 {
            raw.push(format!("\"id-{index:03}\""));
        }
        let text = format!(r#"{{"ids":[{}]}}"#, raw.join(","));
        let parsed = parse_notified_ids(&text);
        assert_eq!(parsed.len(), NOTIFIED_CAP);
        assert_eq!(parsed[0], "id-050");
        assert_eq!(parsed[199], "id-249");

        let selected: Vec<_> = (0..250)
            .map(|index| notice(&format!("id-{index:03}"), "x", ""))
            .collect();
        let stored = remember_notified(&[], &selected);
        assert_eq!(stored.len(), NOTIFIED_CAP);
        assert_eq!(stored.first().unwrap(), "id-199");
        assert_eq!(stored.last().unwrap(), "id-000");

        let dir = temp_dir();
        let path = dir.0.join("shell-notified.json");
        assert!(load_notified(&path).is_empty());
        std::fs::write(&path, "{not json").unwrap();
        assert!(load_notified(&path).is_empty());

        save_notified(&path, &stored);
        assert_eq!(load_notified(&path), stored);
        assert!(!dir.0.join(".shell-notified.json.tmp").exists());
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.starts_with(r#"{"ids":["#));

        let missing = dir.0.join("missing").join("shell-notified.json");
        save_notified(&missing, &["a".to_string()]);
        assert!(!missing.exists());

        let blocked = dir.0.join("blocked");
        std::fs::create_dir_all(&blocked).unwrap();
        save_notified(&blocked, &["a".to_string()]);
    }

    #[test]
    fn a_reloaded_id_is_not_selected_again() {
        let now = parse_rfc3339_ms("2026-10-23T12:00:00.000Z").unwrap();
        let reminders = vec![notice("a", "hello", "2026-10-23T11:00:00.000Z")];
        let first = select_reminders_to_notify(&reminders, Some(&gate(true)), &[], now);
        assert_eq!(first.len(), 1);
        let dir = temp_dir();
        let path = dir.0.join("shell-notified.json");
        save_notified(&path, &remember_notified(&[], &first));
        let loaded = load_notified(&path);
        assert!(select_reminders_to_notify(&reminders, Some(&gate(true)), &loaded, now).is_empty());
    }
}
