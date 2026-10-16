//! The visible transcript, folded from committed session events plus the one
//! live assistant message still streaming. Context the runtime injects into
//! user messages (time marks, runtime context, skill lists) is not shown.
//!
//! A long assistant message is split into several rows at Markdown block
//! boundaries (see [`Splitter`]). The virtual list then lays out only the
//! parts on screen, and a streaming reply re-lays out only its last part:
//! one row for a whole 200 KB reply cost over 100 ms a frame.

use dscode_client_core::protocol::types::{self, ContentBlock, SessionEvent, SessionEventKnown};
use gpui_kit::SharedString;
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

/// A row of an assistant message is cut once it holds this many bytes, at
/// the next block boundary.
const PART: usize = 2048;

/// One row. For a user message `text` is the message, for an assistant
/// message one part of it (`continued` on every part but the first); for a
/// tool call it is the tool's name, `detail` its most telling argument and
/// `error` the first line of a failed result.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub role: Role,
    pub text: SharedString,
    pub continued: bool,
    pub detail: String,
    pub status: ToolStatus,
    pub error: Option<String>,
}

impl Entry {
    fn message(role: Role, text: impl Into<SharedString>) -> Self {
        Entry { role, text: text.into(), continued: false, detail: String::new(), status: ToolStatus::Done, error: None }
    }

    fn part(text: &str, continued: bool) -> Self {
        Entry { continued, ..Entry::message(Role::Assistant, text.to_owned()) }
    }
}

/// Where a Markdown text splits into rows. A cut goes before a line that
/// starts in the first column and follows a blank line outside a code
/// fence, once the row since the last cut holds [`PART`] bytes, so every row
/// is whole blocks (a list may restart, keeping its numbering). Fed the text
/// as it grows; a cut, once made, never moves.
#[derive(Default, Clone)]
struct Splitter {
    /// Byte offsets where rows after the first start.
    cuts: Vec<usize>,
    /// Start of the first line not yet complete.
    line: usize,
    after_blank: bool,
    /// The open fence: its character and length.
    fence: Option<(char, usize)>,
}

impl Splitter {
    /// The rows of a whole text: the same as streaming it, so a committed
    /// reply keeps the rows it streamed in (its last line never opens a row).
    fn of(text: &str) -> Splitter {
        let mut splitter = Splitter::default();
        splitter.feed(text);
        splitter
    }

    /// Look at the lines of `text` (the whole text so far) completed since the last call.
    fn feed(&mut self, text: &str) {
        while let Some(end) = text[self.line..].find('\n').map(|offset| self.line + offset) {
            let line = &text[self.line..end];
            let start = self.cuts.last().copied().unwrap_or(0);
            let opens_column = line.chars().next().is_some_and(|c| !c.is_whitespace());
            if self.after_blank && opens_column && self.fence.is_none() && self.line - start >= PART {
                self.cuts.push(self.line);
            }
            self.fence = match (self.fence, fence_of(line)) {
                (None, Some(fence)) => Some(fence),
                (Some((c, n)), Some((d, m))) if c == d && m >= n && line.trim().chars().all(|x| x == c) => None,
                (open, _) => open,
            };
            self.after_blank = line.trim().is_empty();
            self.line = end + 1;
        }
    }

    fn rows(&self) -> usize {
        self.cuts.len() + 1
    }

    /// The text of row `index` of `text`.
    fn row<'t>(&self, text: &'t str, index: usize) -> &'t str {
        let start = if index == 0 { 0 } else { self.cuts[index - 1] };
        let end = self.cuts.get(index).copied().unwrap_or(text.len()).min(text.len());
        text[start..end].trim_end()
    }
}

/// A code fence opening or closing on `line`: its character and length.
fn fence_of(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let c = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = trimmed.chars().take_while(|x| *x == c).count();
    (n >= 3).then_some((c, n))
}

#[derive(Default)]
pub struct Transcript {
    entries: Vec<Entry>,
    live: Option<(String, Splitter)>,
    tools: HashMap<String, usize>,
}

impl Transcript {
    /// Rows to render: committed entries, then the rows of the live message if one is streaming.
    pub fn len(&self) -> usize {
        self.entries.len() + self.live.as_ref().map_or(0, |(_, splitter)| splitter.rows())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn row(&self, index: usize) -> Entry {
        match (self.entries.get(index), &self.live) {
            (Some(entry), _) => entry.clone(),
            (None, Some((text, splitter))) => {
                let part = index - self.entries.len();
                Entry::part(splitter.row(text, part), part > 0)
            }
            (None, None) => Entry::message(Role::Assistant, ""),
        }
    }

    pub fn start_live(&mut self) {
        self.live.get_or_insert_with(Default::default);
    }

    pub fn push_live(&mut self, text: &str) {
        let (live, splitter) = self.live.get_or_insert_with(Default::default);
        live.push_str(text);
        splitter.feed(live);
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
                    let splitter = Splitter::of(&text);
                    self.entries.extend((0..splitter.rows()).map(|part| Entry::part(splitter.row(&text, part), part > 0)));
                }
            }
            SessionEventKnown::ToolCall { data, .. } => {
                let detail = summarize_arguments(&data.arguments);
                self.entries.push(Entry { role: Role::Tool, detail, status: ToolStatus::Running, ..Entry::message(Role::Tool, data.name.clone()) });
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
    fn splits_long_replies_at_block_boundaries() {
        let fence = format!("```\n{}\n\nstill code\n```\n", "x".repeat(PART));
        let text = format!("# Title\n\n{}\n\n{fence}\nafter the fence\n\n  indented continuation\n\n- next block\n", "p".repeat(PART));
        let whole = Splitter::of(&text);
        let rows: Vec<_> = (0..whole.rows()).map(|i| whole.row(&text, i)).collect();
        // No cut inside the fence or before an indented line; parts are whole blocks.
        assert_eq!(rows.len(), 3, "{rows:#?}");
        assert!(rows[0].ends_with('p'));
        assert!(rows[1].starts_with("```") && rows[1].ends_with("```"));
        assert!(rows[2].starts_with("after the fence") && rows[2].contains("indented continuation"));
        // Fed a few bytes at a time, the cuts are the same and never move.
        let mut live = Splitter::default();
        let mut seen = Vec::new();
        for end in (0..=text.len()).step_by(7).chain([text.len()]) {
            live.feed(&text[..end]);
            assert!(live.cuts.starts_with(&seen));
            seen = live.cuts.clone();
        }
        assert_eq!(live.cuts, whole.cuts);
        // A short reply is one row.
        assert_eq!(Splitter::of("short\n\nreply").rows(), 1);
    }

    #[test]
    fn a_long_reply_streams_and_commits_as_the_same_rows() {
        let text = (0..40).map(|i| format!("Paragraph {i}: {}", "word ".repeat(30))).collect::<Vec<_>>().join("\n\n");
        let mut t = Transcript::default();
        t.fold(&user("hello", "user"));
        t.start_live();
        for piece in text.as_bytes().chunks(16) {
            t.push_live(std::str::from_utf8(piece).unwrap());
        }
        let streamed: Vec<_> = (0..t.len()).map(|i| t.row(i)).collect();
        assert!(streamed.len() > 3);
        t.fold(&assistant(json!([{"type": "text", "text": text}])));
        let committed: Vec<_> = (0..t.len()).map(|i| t.row(i)).collect();
        assert_eq!(streamed, committed);
        assert!(!committed[1].continued && committed[2].continued);
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
