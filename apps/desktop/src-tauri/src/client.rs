use std::io::Read;
use std::time::Duration;

use crate::daemon::shared_shortcut;
use crate::status_view::{parse_status_json, reminder_count, StatusSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientError {
    Unreachable,
    Status(u16),
    BadBody,
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable => formatter.write_str("无法连接 daemon"),
            Self::Status(code) => write!(formatter, "daemon 返回 HTTP {code}"),
            Self::BadBody => formatter.write_str("daemon 返回的不是 JSON"),
        }
    }
}

pub struct LoopbackClient {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl LoopbackClient {
    pub fn new(port: u16, token: &str) -> Self {
        Self {
            base: format!("http://127.0.0.1:{port}"),
            token: token.to_string(),
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(2))
                .timeout_read(Duration::from_secs(4))
                .redirects(0)
                .build(),
        }
    }

    pub fn get_status(&self) -> Result<StatusSnapshot, ClientError> {
        parse_status_json(&self.get_text("/api/status")?).map_err(|_| ClientError::BadBody)
    }

    /// HTTP status of a loopback GET. `None` when the socket never answered.
    pub fn http_status(&self, path: &str) -> Option<u16> {
        match self
            .agent
            .get(&format!("{}{path}", self.base))
            .set("Authorization", &self.authorization())
            .call()
        {
            Ok(response) => Some(response.status()),
            Err(ureq::Error::Status(code, _)) => Some(code),
            Err(ureq::Error::Transport(_)) => None,
        }
    }

    pub fn reminder_count(&self) -> Result<usize, ClientError> {
        Ok(reminder_count(&self.get_json("/api/reminders")?))
    }

    pub fn shared_shortcut(&self) -> Result<Option<String>, ClientError> {
        Ok(shared_shortcut(&self.get_json("/api/config")?))
    }

    pub fn sync(&self) -> Result<(), ClientError> {
        let response = self
            .agent
            .post(&format!("{}/api/actions/sync", self.base))
            .set("Authorization", &self.authorization())
            .send_bytes(&[])
            .map_err(classify_transport)?;
        if !(200..300).contains(&response.status()) {
            return Err(ClientError::Status(response.status()));
        }
        Ok(())
    }

    pub fn open_events(&self) -> Result<Box<dyn Read + Send>, ClientError> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .timeout_read(Duration::from_secs(120))
            .redirects(0)
            .build();
        let response = agent
            .get(&format!("{}/api/events", self.base))
            .set("Authorization", &self.authorization())
            .set("Accept", "text/event-stream")
            .call()
            .map_err(classify_transport)?;
        if response.status() != 200 {
            return Err(ClientError::Status(response.status()));
        }
        Ok(Box::new(response.into_reader()))
    }

    fn get_json(&self, path: &str) -> Result<serde_json::Value, ClientError> {
        let body = self.get_text(path)?;
        serde_json::from_str(&body).map_err(|_| ClientError::BadBody)
    }

    fn get_text(&self, path: &str) -> Result<String, ClientError> {
        let response = self
            .agent
            .get(&format!("{}{path}", self.base))
            .set("Authorization", &self.authorization())
            .call()
            .map_err(classify_transport)?;
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(ClientError::Status(status));
        }
        response.into_string().map_err(|_| ClientError::BadBody)
    }

    fn authorization(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

fn classify_transport(error: ureq::Error) -> ClientError {
    match error {
        ureq::Error::Status(code, _) => ClientError::Status(code),
        ureq::Error::Transport(_) => ClientError::Unreachable,
    }
}
