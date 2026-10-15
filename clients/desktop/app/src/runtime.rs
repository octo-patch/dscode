//! Bridge between the blocking core client and the UI: connection work and
//! streams run on their own threads and report through one channel of
//! `RuntimeEvent`s, which the view drains on the GPUI executor. Everything on
//! the wire goes through the types generated from the protocol schema.

use dscode_client_core::protocol::{self, ops, typert, types, Waterfall};
use dscode_client_core::{Client, Error, Target};
use std::collections::HashMap;
use std::thread;

pub enum RuntimeEvent {
    Connected { label: String, version: String, cwd: String, session: Session },
    Failed(String),
    /// Committed session events, oldest first (a snapshot page or one event).
    Committed(Vec<types::SessionEvent>),
    Live(Live),
    Approval { event_id: String, payload: types::ApprovalRequestPayload },
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
    client_id: String,
}

impl Session {
    pub fn deliver(&self, text: String, events: flume::Sender<RuntimeEvent>) {
        let args = types::SessionDeliverArgs {
            content: vec![types::ContentBlock::TextBlock(types::TextBlock { text, type_: types::TextBlockType::Text })],
            context: None,
            mode: types::SessionDeliverArgsMode::Followup,
            session_id: self.session_id.clone(),
        };
        self.background::<ops::SessionDeliver>(args, events);
    }

    pub fn interrupt(&self, events: flume::Sender<RuntimeEvent>) {
        self.background::<ops::SessionInterrupt>(types::SessionInterruptArgs { session_id: self.session_id.clone() }, events);
    }

    pub fn answer(&self, event_id: String, decision: <typert::ApprovalRequest as Waterfall>::Answer, events: flume::Sender<RuntimeEvent>) {
        let (client, client_id) = (self.client.clone(), self.client_id.clone());
        thread::spawn(move || {
            let value = serde_json::to_value(decision).ok();
            let answer = types::RemoteEventResult { client_id, event_id, outcome: types::RemoteEventResultOutcome::Result { value } };
            if let Err(error) = client.typert::<typert::EventsResult>(&answer) {
                let _ = events.send(RuntimeEvent::Failed(format!("answering the approval failed: {error}")));
            }
        });
    }

    fn background<M: protocol::Method>(&self, args: M::Args, events: flume::Sender<RuntimeEvent>)
    where
        M::Args: Send + 'static,
    {
        let client = self.client.clone();
        thread::spawn(move || {
            if let Err(error) = client.invoke::<M>(&args) {
                let _ = events.send(RuntimeEvent::Failed(format!("{}: {error}", M::NAME)));
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
    let host_behind = protocol::compatibility(&status, protocol::PROTOCOL).map_err(|reason| Error::Protocol(format!("the runtime {reason}")))?;

    let attach = client.typert_stream::<typert::Events>(&types::NoArgs(HashMap::new()))?;
    let client_id = match attach.recv() {
        Some(Ok(types::RemoteEventDownlinkFrame::ReadyFrame(ready))) => ready.client_id,
        Some(Err(error)) => return Err(error),
        other => return Err(Error::Protocol(format!("expected ready on $events, got {other:?}"))),
    };

    let cwd = cwd.or(status.default_cwd).unwrap_or_else(|| ".".into());
    let request = types::SessionCreateRequest { agent_preset: Some("dscode".into()), cwd: Some(cwd.clone()), session_id: None, workspace_id: None };
    let session_id = client.typert::<typert::SessionCreate>(&types::SessionCreateArgs { request })?.session_id;
    let follow_request = types::SessionFollowRequest {
        address: types::SessionAddress::Session { session_id: session_id.clone() },
        assistant_stream: Some(true),
        max_messages: Some(1000.0),
        turn_window: None,
    };
    let follow = client.typert_stream::<typert::SessionFollow>(&types::SessionFollowArgs { request: follow_request })?;

    let session = Session { client: client.clone(), session_id: session_id.clone(), client_id };
    let version = if host_behind { format!("{} (older protocol; some features may be missing)", status.version) } else { status.version };
    let _ = events.send(RuntimeEvent::Connected { label: client.target().to_string(), version, cwd, session: session.clone() });

    // $events: approvals for the session this window drives; pass everything else on.
    {
        let (events, session) = (events.clone(), session.clone());
        thread::spawn(move || {
            while let Some(frame) = attach.recv() {
                let event = match frame {
                    Ok(types::RemoteEventDownlinkFrame::InvocationFrame(invocation)) => {
                        let ours = invocation.event == typert::ApprovalRequest::EVENT && invocation.agent_id == session.session_id;
                        let payload = ours.then(|| serde_json::from_value::<types::ApprovalRequestPayload>(invocation.request.clone().into()));
                        match payload {
                            Some(Ok(payload)) => RuntimeEvent::Approval { event_id: invocation.event_id, payload },
                            other => {
                                if let Some(Err(error)) = other {
                                    eprintln!("dscode-desktop: unreadable approval request: {error}");
                                }
                                pass_on(&session, invocation.event_id);
                                continue;
                            }
                        }
                    }
                    Ok(types::RemoteEventDownlinkFrame::CancellationFrame(cancel)) => RuntimeEvent::Withdrawn(cancel.event_id),
                    Ok(types::RemoteEventDownlinkFrame::EmitFrame(emit)) if emit.event == "api-session/status" => {
                        if emit.args.first().and_then(|id| id.as_str()) != Some(session.session_id.as_str()) {
                            continue;
                        }
                        RuntimeEvent::Running(emit.args.get(1).and_then(|running| running.as_bool()).unwrap_or(false))
                    }
                    Ok(_) => continue,
                    Err(error) => {
                        eprintln!("dscode-desktop: {error}");
                        continue;
                    }
                };
                if events.send(event).is_err() {
                    return;
                }
            }
            let _ = events.send(RuntimeEvent::Failed("the runtime connection closed".into()));
        });
    }

    // session/follow: the snapshot, committed events and live assistant frames.
    let events = events.clone();
    thread::spawn(move || {
        while let Some(frame) = follow.recv() {
            let event = match frame {
                Ok(types::SessionFollowFrame::FollowFrameSnapshot { records, .. }) => {
                    RuntimeEvent::Committed(records.iter().filter_map(|record| known(&record.event)).collect())
                }
                Ok(types::SessionFollowFrame::EventEntry(entry)) => match known(&entry.event) {
                    Some(event) => RuntimeEvent::Committed(vec![event]),
                    None => continue,
                },
                Ok(types::SessionFollowFrame::FollowFrameAssistantStream { frame, .. }) => match live(frame) {
                    Some(live) => RuntimeEvent::Live(live),
                    None => continue,
                },
                Err(error) => {
                    eprintln!("dscode-desktop: {error}");
                    continue;
                }
            };
            if events.send(event).is_err() {
                return;
            }
        }
        let _ = events.send(RuntimeEvent::Failed("the session stream closed".into()));
    });
    Ok(())
}

/// Decline a waterfall this window does not handle, so another client can.
fn pass_on(session: &Session, event_id: String) {
    let answer = types::RemoteEventResult { client_id: session.client_id.clone(), event_id, outcome: types::RemoteEventResultOutcome::Next };
    if let Err(error) = session.client.typert::<typert::EventsResult>(&answer) {
        eprintln!("dscode-desktop: passing on a request failed: {error}");
    }
}

/// A follow event as a session event; a known kind with the wrong shape is reported and skipped.
fn known(event: &types::SessionWireEvent) -> Option<types::SessionEvent> {
    event.known().map_err(|error| eprintln!("dscode-desktop: unreadable {} event: {error}", event.type_)).ok()
}

fn live(frame: types::SessionAssistantStreamFrame) -> Option<Live> {
    match frame {
        types::SessionAssistantStreamFrame::Start { .. } => Some(Live::Start),
        types::SessionAssistantStreamFrame::End { .. } => Some(Live::End),
        // Upstream types the chunk as JSON; it is the model's stream chunk.
        types::SessionAssistantStreamFrame::Chunk { chunk, .. } => {
            match serde_json::to_value(chunk).and_then(serde_json::from_value::<types::StreamChunk>) {
                Ok(types::StreamChunk::TextDelta { text, .. }) => Some(Live::Text(text)),
                _ => None,
            }
        }
    }
}
