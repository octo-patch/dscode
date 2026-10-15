use crate::error::{Error, Result};
use crate::http::{self, Conn};
use crate::protocol::{Method, Watch};
use crate::stream::{Stream, TypedStream};
use crate::target::Target;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// One runtime connection target and the three carrier routes on it. Cheap to
/// clone; every unary call uses its own connection and every stream owns one.
#[derive(Clone, Debug)]
pub struct Client {
    target: Target,
}

/// `host/status`: who answers, and whether it is the release this client speaks.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub version: String,
    pub pid: u32,
    #[serde(default)]
    pub clients: u32,
    #[serde(default)]
    pub streams: u32,
    #[serde(default)]
    pub sessions: u32,
    #[serde(default)]
    pub default_cwd: Option<String>,
    #[serde(default)]
    pub idle_exit_ms: u64,
}

impl Client {
    pub fn new(target: Target) -> Self {
        Client { target }
    }

    pub fn target(&self) -> &Target {
        &self.target
    }

    /// Typert unary call (`POST /api/<method>`); resolves the result's `value`.
    pub fn call(&self, method: &str, args: Value) -> Result<Value> {
        self.call_with_timeout(method, args, None)
    }

    pub fn call_with_timeout(&self, method: &str, args: Value, timeout: Option<Duration>) -> Result<Value> {
        let rpc_id = uuid::Uuid::new_v4().to_string();
        let body = json!({"type": "client-request", "rpcId": rpc_id, "method": method, "payload": {"args": args}});
        let (status, text) = self.post(&format!("/api/{method}"), &body, timeout)?;
        let envelope: Value = serde_json::from_str(&text)
            .map_err(|_| Error::protocol(format!("/api {method} returned {status}: {}", truncate(&text, 200))))?;
        if envelope["type"] != "server-response" || (status != 401 && envelope["rpcId"] != rpc_id.as_str()) {
            return Err(Error::protocol(format!("unexpected /api response ({status})")));
        }
        unwrap_result(&envelope["result"])
    }

    /// DSCODE registry operation (`POST /dscode/<name>`); resolves its value.
    pub fn call_dscode(&self, name: &str, args: Value) -> Result<Value> {
        self.call_dscode_with_timeout(name, args, None)
    }

    pub fn call_dscode_with_timeout(&self, name: &str, args: Value, timeout: Option<Duration>) -> Result<Value> {
        let path = format!("/dscode/{}", http::encode_component(name));
        let (status, text) = self.post(&path, &json!({"args": args}), timeout)?;
        let result: Value = serde_json::from_str(&text)
            .map_err(|_| Error::protocol(format!("DSCODE {name} returned {status}: {}", truncate(&text, 200))))?;
        unwrap_result(&result)
    }

    /// A DSCODE method from the generated contract, with typed arguments and result.
    pub fn invoke<M: Method>(&self, args: &M::Args) -> Result<M::Result> {
        let args = serde_json::to_value(args).map_err(|error| Error::protocol(format!("{}: {error}", M::NAME)))?;
        let value = self.call_dscode(M::NAME, args)?;
        serde_json::from_value(value).map_err(|error| Error::protocol(format!("{} returned an unexpected shape: {error}", M::NAME)))
    }

    /// A DSCODE stream from the generated contract, decoding each item.
    pub fn watch<W: Watch>(&self, args: &W::Args) -> Result<TypedStream<W::Item>> {
        let args = serde_json::to_value(args).map_err(|error| Error::protocol(format!("{}: {error}", W::NAME)))?;
        Ok(TypedStream::new(self.open_dscode_stream(W::NAME, args)?))
    }

    /// `host/status` with the launcher's two-second probe timeout.
    pub fn host_status(&self) -> Result<HostStatus> {
        let value = self.call_dscode_with_timeout("host/status", json!({}), Some(Duration::from_secs(2)))?;
        serde_json::from_value(value).map_err(|error| Error::protocol(format!("host/status: {error}")))
    }

    /// Open a Typert stream (`$events`, `session/follow`) with `{args}` as its payload.
    pub fn open_stream(&self, endpoint: &str, args: Value) -> Result<Stream> {
        Stream::open(&self.target, endpoint, json!({"args": args}))
    }

    /// Open a DSCODE registry stream (`status/watch` → endpoint `dscode/status/watch`).
    pub fn open_dscode_stream(&self, name: &str, args: Value) -> Result<Stream> {
        self.open_stream(&format!("dscode/{name}"), args)
    }

    fn post(&self, path: &str, body: &Value, timeout: Option<Duration>) -> Result<(u16, String)> {
        let body = serde_json::to_vec(body).expect("JSON values serialize");
        let mut conn = Conn::connect(&self.target, Some(timeout.unwrap_or(CONNECT_TIMEOUT)))?;
        conn.set_timeouts(timeout)?;
        conn.write_all(http::head(&self.target, path, "application/json", Some(body.len())).as_bytes())?;
        conn.write_all(&body)?;
        conn.flush()?;
        http::read_response(conn)?.text()
    }
}

/// `{ok: true, value}` → value; `{ok: false, error}` → the remote failure.
fn unwrap_result(result: &Value) -> Result<Value> {
    match result.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(result.get("value").cloned().unwrap_or(Value::Null)),
        Some(false) => Err(Error::remote(&result["error"])),
        None => Err(Error::protocol(format!("result without ok: {}", truncate(&result.to_string(), 200)))),
    }
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_results() {
        assert_eq!(unwrap_result(&json!({"ok": true, "value": 3})).unwrap(), json!(3));
        assert_eq!(unwrap_result(&json!({"ok": true})).unwrap(), Value::Null);
        let error = unwrap_result(&json!({"ok": false, "error": {"code": "dscode/session-not-live", "message": "no agent"}})).unwrap_err();
        assert_eq!(error.code(), Some("dscode/session-not-live"));
        assert!(matches!(unwrap_result(&json!({})), Err(Error::Protocol(_))));
    }
}
