//! 终端会话提醒：daemon 把「会话等你回复 / 已完成」记成带序号的条目，
//! 壳每次刷新时取一次，只处理自己还没弹过的待处理（open）条目：发系统通知并拉起置顶弹框。

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeckNotice {
    pub seq: u64,
    pub open: bool,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeckNotices {
    /// daemon 每次启动换一个；变了说明 daemon 重启过，序号从头算。
    pub epoch: String,
    pub latest: u64,
    pub notices: Vec<DeckNotice>,
}

/// 壳记住的位置：哪一次 daemon 运行、弹到了第几条。只在内存里，壳重启后从当前位置开始。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeCursor {
    pub epoch: String,
    pub seq: u64,
}

/// 解析 `GET /api/deck/notices`。缺 `epoch`、`latest` 或 `notices` 整体算失败；
/// 单条缺 `seq` 或 `title` 只跳过那一条。
pub fn parse_deck_notices(text: &str) -> Result<DeckNotices, ()> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    let epoch = object
        .get("epoch")
        .and_then(serde_json::Value::as_str)
        .filter(|epoch| !epoch.is_empty())
        .ok_or(())?
        .to_string();
    let latest = object
        .get("latest")
        .and_then(serde_json::Value::as_u64)
        .ok_or(())?;
    let items = object
        .get("notices")
        .and_then(serde_json::Value::as_array)
        .ok_or(())?;
    let mut notices = Vec::new();
    for item in items {
        let Some(seq) = item.get("seq").and_then(serde_json::Value::as_u64) else {
            continue;
        };
        let Some(title) = item
            .get("title")
            .and_then(serde_json::Value::as_str)
            .filter(|title| !title.is_empty())
        else {
            continue;
        };
        notices.push(DeckNotice {
            seq,
            open: item.get("status").and_then(serde_json::Value::as_str) != Some("closed"),
            title: title.to_string(),
            body: item
                .get("body")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(DeckNotices {
        epoch,
        latest,
        notices,
    })
}

/// 选出这一轮要弹的条目，并给出新的位置（总是 `(response.epoch, response.latest)`）。
/// - 没有位置（壳刚启动）：一条都不弹，只记下当前位置，不补弹启动前的状态。
/// - 同一次 daemon 运行：弹序号比位置大的。
/// - daemon 重启过（epoch 变了）：弹响应里的全部；daemon 自己的第一次快照已保证不补发旧状态。
pub fn select_notices(
    cursor: Option<&NoticeCursor>,
    response: &DeckNotices,
) -> (Vec<DeckNotice>, NoticeCursor) {
    let next = NoticeCursor {
        epoch: response.epoch.clone(),
        seq: response.latest,
    };
    let selected = match cursor {
        None => Vec::new(),
        Some(cursor) if cursor.epoch == response.epoch => response
            .notices
            .iter()
            .filter(|notice| notice.seq > cursor.seq && notice.open)
            .cloned()
            .collect(),
        Some(_) => response
            .notices
            .iter()
            .filter(|notice| notice.open)
            .cloned()
            .collect(),
    };
    (selected, next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(seq: u64) -> DeckNotice {
        DeckNotice {
            seq,
            open: true,
            title: format!("会话 {seq} 已完成"),
            body: String::new(),
        }
    }

    fn response(epoch: &str, seqs: &[u64], latest: u64) -> DeckNotices {
        DeckNotices {
            epoch: epoch.to_string(),
            latest,
            notices: seqs.iter().map(|seq| notice(*seq)).collect(),
        }
    }

    fn cursor(epoch: &str, seq: u64) -> NoticeCursor {
        NoticeCursor {
            epoch: epoch.to_string(),
            seq,
        }
    }

    #[test]
    fn first_fetch_sets_cursor_without_notifying() {
        let (selected, next) = select_notices(None, &response("e1", &[1, 2, 3, 4], 4));
        assert!(selected.is_empty());
        assert_eq!(next, cursor("e1", 4));
    }

    #[test]
    fn same_epoch_selects_only_newer() {
        let (selected, next) =
            select_notices(Some(&cursor("e1", 2)), &response("e1", &[1, 2, 3, 4], 4));
        assert_eq!(
            selected.iter().map(|item| item.seq).collect::<Vec<_>>(),
            vec![3, 4]
        );
        assert_eq!(next, cursor("e1", 4));
    }

    #[test]
    fn new_epoch_selects_all() {
        let (selected, next) = select_notices(Some(&cursor("e1", 9)), &response("e2", &[1, 2], 2));
        assert_eq!(
            selected.iter().map(|item| item.seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(next, cursor("e2", 2));
    }

    #[test]
    fn nothing_new_keeps_cursor() {
        let (selected, next) =
            select_notices(Some(&cursor("e1", 4)), &response("e1", &[1, 2, 3, 4], 4));
        assert!(selected.is_empty());
        assert_eq!(next, cursor("e1", 4));
    }

    #[test]
    fn parse_reads_a_well_formed_response() {
        let parsed = parse_deck_notices(
            r#"{"epoch":"e1","latest":2,"notices":[{"seq":2,"pane":7,"kind":"waiting","title":"账本 在等你回复","body":"继续吗？","at":"t"}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.epoch, "e1");
        assert_eq!(parsed.latest, 2);
        assert_eq!(
            parsed.notices,
            vec![DeckNotice {
                seq: 2,
                open: true,
                title: "账本 在等你回复".into(),
                body: "继续吗？".into()
            }]
        );
    }

    #[test]
    fn skips_already_closed_notices_when_selecting() {
        let parsed = parse_deck_notices(
            r#"{"epoch":"e1","latest":3,"notices":[{"seq":2,"status":"closed","title":"旧的"},{"seq":3,"status":"open","title":"新的"}]}"#,
        )
        .unwrap();
        let (selected, next) = select_notices(Some(&cursor("e1", 1)), &parsed);
        assert_eq!(selected.iter().map(|n| n.seq).collect::<Vec<_>>(), vec![3]);
        assert_eq!(next, cursor("e1", 3));
    }

    #[test]
    fn parse_rejects_malformed_and_skips_bad_items() {
        assert!(parse_deck_notices("not json").is_err());
        assert!(parse_deck_notices(r#"{"latest":1,"notices":[]}"#).is_err());
        assert!(parse_deck_notices(r#"{"epoch":"e1","notices":[]}"#).is_err());
        assert!(parse_deck_notices(r#"{"epoch":"e1","latest":1}"#).is_err());
        let parsed = parse_deck_notices(
            r#"{"epoch":"e1","latest":3,"notices":[{"seq":1,"body":"无标题"},{"title":"无序号"},{"seq":3,"title":"好的"}]}"#,
        )
        .unwrap();
        assert_eq!(
            parsed.notices.iter().map(|item| item.seq).collect::<Vec<_>>(),
            vec![3]
        );
    }
}
