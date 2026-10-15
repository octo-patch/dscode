//! Bridge between the blocking core client and the UI: connection work and
//! streams run on their own threads and report through one channel of
//! `RuntimeEvent`s, which the view drains on the GPUI executor.

use dscode_client_core::{Client, Error, StreamEvent, Target};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::thread;

pub enum RuntimeEvent {
    Connected { label: String, version: String, cwd: String, session: Session },
    Failed(String),
    /// Committed session events, oldest first (a snapshot page or one event).
    Committed(Vec<Value>),
    Live(Live),
    Approval { event_id: String, tool: String, reason: String },
    Withdrawn(String),
    Running(bool),
}

pub enum Live {
    Start,
    Text(String),
    End,
}

/// What the view needs to drive the session once it is open.
#[derive(Clone)]
pub struct Session {
    client: Client,
    session_id: String,
    client_id: Arc<Mutex<String>>,
}

impl Session {
    pub fn deliver(&self, text: String, events: flume::Sender<RuntimeEvent>) {
        let args = json!({"sessionId": self.session_id, "mode": "followup", "content": [{"type": "text", "text": text}]});
        self.background("session/deliver", args, events);
    }

    pub fn interrupt(&self, events: flume::Sender<RuntimeEvent>) {
        self.background("session/interrupt", json!({"sessionId": self.session_id}), events);
    }

    pub fn answer(&self, event_id: String, decision: &'static str, events: flume::Sender<RuntimeEvent>) {
        let client = self.client.clone();
        let client_id = self.client_id.lock().unwrap().clone();
        thread::spawn(move || {
            let outcome = json!({"kind": "result", "value": decision});
            if let Err(error) = client.call("$events/result", json!({"clientId": client_id, "eventId": event_id, "outcome": outcome})) {
                let _ = events.send(RuntimeEvent::Failed(format!("answering the approval failed: {error}")));
            }
        });
    }

    fn background(&self, operation: &'static str, args: Value, events: flume::Sender<RuntimeEvent>) {
        let client = self.client.clone();
        thread::spawn(move || {
            if let Err(error) = client.call_dscode(operation, args) {
                let _ = events.send(RuntimeEvent::Failed(format!("{operation}: {error}")));
            }
        });
    }
}

/// Connect, attach, open a new session and follow it. Returns at once;
/// `Connected` carries the session handle, and everything after it follows.
pub fn connect(target: Target, cwd: Option<String>, events: flume::Sender<RuntimeEvent>) {
    thread::spawn(move || {
        if let Err(error) = open(target, cwd, &events) {
            let _ = events.send(RuntimeEvent::Failed(error.to_string()));
        }
    });
}

fn open(target: Target, cwd: Option<String>, events: &flume::Sender<RuntimeEvent>) -> Result<(), Error> {
    let client = Client::new(target);
    let status = client.host_status()?;

    let attach = client.open_stream("$events", json!({}))?;
    let client_id = match attach.recv() {
        Some(StreamEvent::Item(item)) if item["type"] == "ready" => item["clientId"].as_str().unwrap_or_default().to_owned(),
        other => return Err(Error::Protocol(format!("expected ready on $events, got {other:?}"))),
    };

    let cwd = cwd.or(status.default_cwd).unwrap_or_else(|| ".".into());
    let created = client.call("session/create", json!({"request": {"cwd": cwd, "agentPreset": "dscode"}}))?;
    let session_id = created["sessionId"].as_str().ok_or_else(|| Error::Protocol("session/create returned no sessionId".into()))?.to_owned();
    let request = json!({"address": {"kind": "session", "sessionId": session_id}, "assistantStream": true, "maxMessages": 1000});
    let follow = client.open_stream("session/follow", json!({"request": request}))?;

    let session = Session { client: client.clone(), session_id: session_id.clone(), client_id: Arc::new(Mutex::new(client_id)) };
    let _ = events.send(RuntimeEvent::Connected { label: client.target().to_string(), version: status.version, cwd, session: session.clone() });

    // $events: approvals for the session this window drives; pass everything else on.
    {
        let (events, session) = (events.clone(), session.clone());
        thread::spawn(move || {
            while let Some(StreamEvent::Item(item)) = attach.recv() {
                match item["type"].as_str() {
                    Some("waterfall") => {
                        let event_id = item["eventId"].as_str().unwrap_or_default().to_owned();
                        if item["event"] == "approval/request" && item["agentId"] == session.session_id.as_str() {
                            let request = &item["request"];
                            let _ = events.send(RuntimeEvent::Approval {
                                event_id,
                                tool: request["toolName"].as_str().unwrap_or("tool").to_owned(),
                                reason: display_reason(&request["displayReason"]).or_else(|| display_reason(&request["reason"])).unwrap_or_default(),
                            });
                        } else {
                            let client_id = session.client_id.lock().unwrap().clone();
                            let _ = session.client.call("$events/result", json!({"clientId": client_id, "eventId": event_id, "outcome": {"kind": "next"}}));
                        }
                    }
                    Some("cancel") => {
                        let _ = events.send(RuntimeEvent::Withdrawn(item["eventId"].as_str().unwrap_or_default().to_owned()));
                    }
                    Some("emit") if item["event"] == "api-session/status" && item["args"][0] == session.session_id.as_str() => {
                        let _ = events.send(RuntimeEvent::Running(item["args"][1].as_bool().unwrap_or(false)));
                    }
                    _ => {}
                }
            }
            let _ = events.send(RuntimeEvent::Failed("the runtime connection closed".into()));
        });
    }

    // session/follow: the snapshot, committed events and live assistant frames.
    let events = events.clone();
    thread::spawn(move || loop {
        match follow.recv() {
            Some(StreamEvent::Item(item)) => {
                let event = match item["type"].as_str() {
                    Some("snapshot") => {
                        let records = item["records"].as_array().cloned().unwrap_or_default();
                        RuntimeEvent::Committed(records.into_iter().map(|record| record["event"].clone()).collect())
                    }
                    Some("event") => RuntimeEvent::Committed(vec![item["event"].clone()]),
                    Some("assistant-stream") => match live(&item["frame"]) {
                        Some(live) => RuntimeEvent::Live(live),
                        None => continue,
                    },
                    _ => continue,
                };
                if events.send(event).is_err() {
                    return;
                }
            }
            Some(StreamEvent::Failed(error)) => {
                let _ = events.send(RuntimeEvent::Failed(error.to_string()));
                return;
            }
            Some(StreamEvent::End) | None => return,
        }
    });
    Ok(())
}

fn live(frame: &Value) -> Option<Live> {
    match frame["type"].as_str()? {
        "start" => Some(Live::Start),
        "end" => Some(Live::End),
        "chunk" => {
            let chunk = &frame["chunk"];
            let text = chunk["text"].as_str().unwrap_or_default().to_owned();
            match chunk["type"].as_str()? {
                "text-delta" => Some(Live::Text(text)),
                _ => None,
            }
        }
        _ => None,
    }
}

/// `displayReason` is either a string or a `{en, zh}` pair.
fn display_reason(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).or_else(|| value["zh"].as_str().or(value["en"].as_str()).map(str::to_owned))
}
