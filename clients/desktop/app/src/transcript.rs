//! The visible transcript, folded from committed session events plus the one
//! live assistant message still streaming. Context the runtime injects into
//! user messages (time marks, runtime context, skill lists) is not shown.

use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    Tool,
}

pub struct Entry {
    pub role: Role,
    pub text: String,
    pub failed: bool,
}

#[derive(Default)]
pub struct Transcript {
    entries: Vec<Entry>,
    live: Option<String>,
    tools: HashMap<String, usize>,
}

impl Transcript {
    /// Rows to render: committed entries, then the live message if one is streaming.
    pub fn len(&self) -> usize {
        self.entries.len() + usize::from(self.live.is_some())
    }

    pub fn row(&self, index: usize) -> (Role, &str, bool) {
        match self.entries.get(index) {
            Some(entry) => (entry.role, &entry.text, entry.failed),
            None => (Role::Assistant, self.live.as_deref().unwrap_or_default(), false),
        }
    }

    pub fn start_live(&mut self) {
        self.live.get_or_insert_with(String::new);
    }

    pub fn push_live(&mut self, text: &str) {
        self.live.get_or_insert_with(String::new).push_str(text);
    }

    pub fn fold(&mut self, event: &Value) {
        let data = &event["data"];
        match event["type"].as_str() {
            Some("user/message") if data["source"]["kind"] == "user" => {
                self.push(Role::User, text_of(&data["content"]), false);
            }
            Some("assistant/message") => {
                // The committed message replaces whatever streamed live for it.
                self.live = None;
                let text = text_of(&data["message"]["content"]);
                if !text.trim().is_empty() {
                    self.push(Role::Assistant, text, false);
                }
            }
            Some("tool/call") => {
                let name = data["name"].as_str().unwrap_or("tool");
                let summary = summarize_arguments(data["arguments"].as_str().unwrap_or_default());
                self.push(Role::Tool, format!("{name} {summary}").trim_end().to_owned(), false);
                if let Some(id) = data["callId"].as_str() {
                    self.tools.insert(id.to_owned(), self.entries.len() - 1);
                }
            }
            Some("tool/result") => {
                let message = &data["message"];
                let failed = message["isError"].as_bool().unwrap_or(false);
                let index = message["toolCallId"].as_str().and_then(|id| self.tools.get(id)).copied();
                if let Some(entry) = index.and_then(|index| self.entries.get_mut(index)) {
                    entry.failed = failed;
                    if failed {
                        let reason = text_of(&message["content"]);
                        entry.text = format!("{}\n{}", entry.text, reason.lines().next().unwrap_or_default());
                    }
                }
            }
            _ => {}
        }
    }

    fn push(&mut self, role: Role, text: String, failed: bool) {
        self.entries.push(Entry { role, text, failed });
    }
}

/// Text blocks of a content array, joined.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

/// The most telling argument of a tool call, on one line.
fn summarize_arguments(raw: &str) -> String {
    let Ok(Value::Object(arguments)) = serde_json::from_str::<Value>(raw) else {
        return String::new();
    };
    let value = ["command", "file_path", "path", "pattern", "url", "query"]
        .iter()
        .find_map(|key| arguments.get(*key).and_then(Value::as_str))
        .unwrap_or_default();
    let line = value.lines().next().unwrap_or_default();
    match line.char_indices().nth(120) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn folds_a_turn() {
        let mut t = Transcript::default();
        t.fold(&json!({"type": "user/message", "data": {"content": [{"type": "text", "text": "Time mark"}], "source": {"kind": "dscode-time-marks"}}}));
        t.fold(&json!({"type": "user/message", "data": {"content": [{"type": "text", "text": "hello"}], "source": {"kind": "user"}}}));
        t.start_live();
        t.push_live("Hi");
        assert_eq!(t.len(), 2);
        assert_eq!(t.row(1).1, "Hi");
        t.fold(&json!({"type": "assistant/message", "data": {"message": {"content": [{"type": "tool-call"}]}}}));
        t.fold(&json!({"type": "tool/call", "data": {"callId": "c1", "name": "write", "arguments": "{\"file_path\":\"/x\"}"}}));
        t.fold(&json!({"type": "tool/result", "data": {"message": {"toolCallId": "c1", "isError": true, "content": [{"type": "text", "text": "Error: rejected\nmore"}]}}}));
        t.fold(&json!({"type": "assistant/message", "data": {"message": {"content": [{"type": "text", "text": "Done."}]}}}));
        let rows: Vec<_> = (0..t.len()).map(|i| t.row(i)).map(|(r, s, f)| (r, s.to_owned(), f)).collect();
        assert!(rows == vec![
            (Role::User, "hello".into(), false),
            (Role::Tool, "write /x\nError: rejected".into(), true),
            (Role::Assistant, "Done.".into(), false),
        ]);
    }
}
