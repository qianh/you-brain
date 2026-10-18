#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub kind: String,
}

pub fn drain_sse(buffer: &str) -> (Vec<SseEvent>, String) {
    let mut events = Vec::new();
    let mut rest = buffer.replace("\r\n", "\n");
    while let Some(split) = rest.find("\n\n") {
        let raw = rest[..split].to_string();
        rest = rest[split + 2..].to_string();
        if let Some(event) = parse_sse_block(&raw) {
            events.push(event);
        }
    }
    (events, rest)
}

pub fn parse_sse_block(block: &str) -> Option<SseEvent> {
    let data = block
        .split('\n')
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&data).ok()?;
    let kind = value.get("kind")?.as_str()?.to_string();
    if kind.is_empty() {
        return None;
    }
    Some(SseEvent { kind })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_complete_frames_and_keeps_the_tail() {
        let payload = "event: message\ndata: {\"id\":1,\"kind\":\"status\",\"at\":\"t\"}\n\ndata: {\"id\":0,\"kind\":\"ready\",\"at\":\"t\"}";
        let (events, rest) = drain_sse(payload);
        assert_eq!(
            events,
            vec![SseEvent {
                kind: "status".into()
            }]
        );
        assert!(rest.contains("ready"));
    }

    #[test]
    fn ignores_malformed_frames() {
        let (events, rest) = drain_sse("data: not-json\n\n");
        assert!(events.is_empty());
        assert!(rest.is_empty());
    }

    #[test]
    fn keeps_a_trailing_partial_separator() {
        let (events, rest) = drain_sse("data: not-json\n\n\n");
        assert!(events.is_empty());
        assert_eq!(rest, "\n");
    }

    #[test]
    fn normalizes_crlf() {
        let (events, _) = drain_sse("data: {\"kind\":\"today\"}\r\n\r\n");
        assert_eq!(events[0].kind, "today");
    }
}
