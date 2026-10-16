//! The visible transcript, folded from committed session events plus the one
//! live assistant message still streaming. Context the runtime injects into
//! user messages (time marks, runtime context, skill lists) is not shown.

use dscode_client_core::protocol::types::{self, ContentBlock, SessionEvent, SessionEventKnown};
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToolStatus {
    Running,
    Done,
    Failed,
}

/// One row. For a user or assistant message `text` is the message; for a
/// tool call it is the tool's name, `detail` its most telling argument and
/// `error` the first line of a failed result.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub role: Role,
    pub text: String,
    pub detail: String,
    pub status: ToolStatus,
    pub error: Option<String>,
}

impl Entry {
    fn message(role: Role, text: String) -> Self {
        Entry { role, text, detail: String::new(), status: ToolStatus::Done, error: None }
    }
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

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn row(&self, index: usize) -> Entry {
        match self.entries.get(index) {
            Some(entry) => entry.clone(),
            None => Entry::message(Role::Assistant, self.live.clone().unwrap_or_default()),
        }
    }

    pub fn start_live(&mut self) {
        self.live.get_or_insert_with(String::new);
    }

    pub fn push_live(&mut self, text: &str) {
        self.live.get_or_insert_with(String::new).push_str(text);
    }

    pub fn fold(&mut self, event: &SessionEvent) {
        // Kinds this view does not show, and kinds the contract does not know, change nothing.
        let SessionEvent::Known(event) = event else { return };
        match event {
            SessionEventKnown::UserMessage { data, .. } if is_typed_by_user(&data.source) => {
                self.entries.push(Entry::message(Role::User, text_of(&data.content)));
            }
            SessionEventKnown::AssistantMessage { data, .. } => {
                // The committed message replaces whatever streamed live for it.
                self.live = None;
                let text = text_of(&data.message.content);
                if !text.trim().is_empty() {
                    self.entries.push(Entry::message(Role::Assistant, text));
                }
            }
            SessionEventKnown::ToolCall { data, .. } => {
                let detail = summarize_arguments(&data.arguments);
                self.entries.push(Entry { role: Role::Tool, text: data.name.clone(), detail, status: ToolStatus::Running, error: None });
                self.tools.insert(data.call_id.clone(), self.entries.len() - 1);
            }
            SessionEventKnown::ToolResult { data, .. } => {
                let message = &data.message;
                let failed = message.is_error.unwrap_or(false);
                let index = self.tools.get(&message.tool_call_id).copied();
                if let Some(entry) = index.and_then(|index| self.entries.get_mut(index)) {
                    entry.status = if failed { ToolStatus::Failed } else { ToolStatus::Done };
                    if failed {
                        entry.error = text_of(&message.content).lines().next().map(str::to_owned);
                    }
                }
            }
            _ => {}
        }
    }

    /// Put older history in front of what is held; returns how many rows it added.
    /// A call whose result is in the newer part shows as done.
    pub fn prepend(&mut self, events: &[SessionEvent]) -> usize {
        let mut older = Transcript::default();
        for event in events {
            older.fold(event);
        }
        older.settle();
        let added = older.entries.len();
        for index in self.tools.values_mut() {
            *index += added;
        }
        older.entries.append(&mut self.entries);
        self.entries = older.entries;
        added
    }

    /// Calls still waiting for a result end with the turn (interrupted or abandoned).
    pub fn settle(&mut self) {
        for entry in &mut self.entries {
            if entry.status == ToolStatus::Running {
                entry.status = ToolStatus::Done;
            }
        }
    }
}

/// Whether a user message is something the person typed, rather than context
/// the runtime injected (time marks, runtime context, skill lists).
fn is_typed_by_user(source: &types::MessageSource) -> bool {
    serde_json::to_value(source).is_ok_and(|source| source["kind"] == "user")
}

/// Text blocks of a content array, joined.
fn text_of(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::TextBlock(block) => Some(block.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The most telling argument of a tool call, on one line.
fn summarize_arguments(raw: &str) -> String {
    let Ok(serde_json::Value::Object(arguments)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return String::new();
    };
    let value = ["command", "file_path", "path", "pattern", "url", "query"]
        .iter()
        .find_map(|key| arguments.get(*key).and_then(serde_json::Value::as_str))
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
    use serde_json::{json, Value};

    /// Events as the Host sends them, decoded through the generated types.
    fn event(kind: &str, seq: u32, data: Value) -> SessionEvent {
        let mut event = json!({"type": kind, "seq": seq, "time": 1, "data": data});
        if ["user/message", "assistant/message", "tool/result"].contains(&kind) {
            event["surfaceOp"] = json!("append");
        }
        serde_json::from_value(event).unwrap_or_else(|error| panic!("{kind}: {error}"))
    }

    fn user(text: &str, kind: &str) -> SessionEvent {
        event("user/message", 1, json!({"role": "user", "id": "u", "content": [{"type": "text", "text": text}], "source": {"kind": kind}}))
    }

    fn assistant(content: Value) -> SessionEvent {
        event("assistant/message", 2, json!({"turn": 1, "step": 1, "stream": [], "message": {"role": "assistant", "id": "a", "content": content, "source": {"kind": "model", "provider": "p", "model": "m"}}}))
    }

    #[test]
    fn folds_a_turn() {
        let mut t = Transcript::default();
        t.fold(&user("Time mark", "dscode-time-marks"));
        t.fold(&user("hello", "user"));
        t.start_live();
        t.push_live("Hi");
        assert_eq!(t.len(), 2);
        assert_eq!(t.row(1).text, "Hi");
        t.fold(&assistant(json!([{"type": "tool-call", "id": "c1", "name": "write", "arguments": "{}"}])));
        t.fold(&event("tool/call", 3, json!({"turn": 1, "step": 1, "callId": "c1", "name": "write", "arguments": "{\"file_path\":\"/x\"}"})));
        t.fold(&event(
            "tool/result",
            4,
            json!({"turn": 1, "step": 1, "message": {"role": "tool", "id": "r", "toolCallId": "c1", "isError": true, "source": {"kind": "tool", "callId": "c1"}, "content": [{"type": "text", "text": "Error: rejected\nmore"}]}}),
        ));
        t.fold(&assistant(json!([{"type": "text", "text": "Done."}])));
        // A kind the contract does not know is skipped, not an error.
        t.fold(&serde_json::from_value(json!({"type": "made/up", "seq": 9, "time": 1, "data": {}})).unwrap());
        let rows: Vec<_> = (0..t.len()).map(|i| t.row(i)).map(|e| (e.role, e.text, e.detail, e.status, e.error)).collect();
        assert_eq!(rows, vec![
            (Role::User, "hello".into(), String::new(), ToolStatus::Done, None),
            (Role::Tool, "write".into(), "/x".into(), ToolStatus::Failed, Some("Error: rejected".into())),
            (Role::Assistant, "Done.".into(), String::new(), ToolStatus::Done, None),
        ]);
    }

    #[test]
    fn prepends_older_history() {
        let mut t = Transcript::default();
        t.fold(&user("newer", "user"));
        t.fold(&event("tool/call", 5, json!({"turn": 2, "step": 1, "callId": "c2", "name": "read", "arguments": "{\"path\":\"/b\"}"})));
        let older = [
            user("older", "user"),
            event("tool/call", 2, json!({"turn": 1, "step": 1, "callId": "c1", "name": "bash", "arguments": "{\"command\":\"ls\"}"})),
        ];
        assert_eq!(t.prepend(&older), 2);
        // The newer call's result still finds its row after the shift.
        t.fold(&event(
            "tool/result",
            6,
            json!({"turn": 2, "step": 1, "message": {"role": "tool", "id": "r", "toolCallId": "c2", "isError": true, "source": {"kind": "tool", "callId": "c2"}, "content": [{"type": "text", "text": "no such file"}]}}),
        ));
        let rows: Vec<_> = (0..t.len()).map(|i| t.row(i)).map(|e| (e.text, e.status)).collect();
        assert_eq!(rows, vec![
            ("older".into(), ToolStatus::Done),
            ("bash".into(), ToolStatus::Done),
            ("newer".into(), ToolStatus::Done),
            ("read".into(), ToolStatus::Failed),
        ]);
    }
}
