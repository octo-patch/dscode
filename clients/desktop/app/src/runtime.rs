//! Bridge between the blocking core client and the UI: connection work and
//! streams run on their own threads and report through one channel of
//! `RuntimeEvent`s, which the view drains on the GPUI executor.
//!
//! A `Connection` is one runtime: `$events` (approvals, running state), the
//! default-model watch and the session list. A `Session` is one followed
//! session on it; the window switches sessions without reconnecting. Every
//! event carries the generation of the connection or session that sent it,
//! so the view drops what a runtime or session it has already left still
//! sends. Everything on the wire goes through the types generated from the
//! protocol schema.

use dscode_client_core::protocol::{self, ops, typert, types, Waterfall};
use dscode_client_core::runtimes::Runtimes;
use dscode_client_core::{Client, Error, Launcher, Target, TypedStream};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::thread;

pub enum RuntimeEvent {
    /// The launcher and the runtimes file, read once at start.
    Catalog(Catalog),

    // Connection events, tagged with the connection's generation.
    Connected { version: String, default_cwd: String, connection: Connection },
    /// Connecting failed or the connection broke; only reconnecting helps.
    Lost(String),
    /// An operation failed; the connection is still usable.
    Failed(String),
    Sessions(Vec<types::SessionRow>),
    DefaultModel(types::DshAgentModelSelection),
    Models(Vec<types::ModelRow>),
    /// A pick took effect for the shown session (or the next one).
    ModelSelected(types::DshAgentModelSelection),
    Approval { session_id: String, event_id: String, payload: types::ApprovalRequestPayload },
    Withdrawn(String),
    Running { session_id: String, running: bool },

    // Session events, tagged with the session's generation.
    Opened(Session),
    /// The opening window of a followed session; older history can be paged in from `page`.
    Snapshot { events: Vec<types::SessionEvent>, page: Option<Page> },
    /// One committed event, after the snapshot.
    Committed(Vec<types::SessionEvent>),
    /// A page of older history, oldest first, and where the next one starts.
    Older { events: Vec<types::SessionEvent>, page: Option<Page> },
    Live(Live),
    SessionFailed(String),
}

impl RuntimeEvent {
    /// Whether the event belongs to a followed session rather than the connection.
    pub fn is_session_event(&self) -> bool {
        matches!(
            self,
            RuntimeEvent::Opened(_)
                | RuntimeEvent::Snapshot { .. }
                | RuntimeEvent::Committed(_)
                | RuntimeEvent::Older { .. }
                | RuntimeEvent::Live(_)
                | RuntimeEvent::SessionFailed(_)
        )
    }
}

/// Where older history continues: the follow's log cut and the oldest event held.
#[derive(Clone, Copy, Debug)]
pub struct Page {
    through: f64,
    before: f64,
}

/// Messages per page, for the opening window and for each older page;
/// `DSCODE_DESKTOP_PAGE_MESSAGES` lowers it to exercise paging.
fn page_messages() -> f64 {
    std::env::var("DSCODE_DESKTOP_PAGE_MESSAGES").ok().and_then(|value| value.parse().ok()).filter(|n: &f64| *n >= 1.).unwrap_or(200.)
}

pub enum Live {
    Start,
    Text(String),
    End,
}

/// Sends events tagged with a generation.
#[derive(Clone)]
pub struct Reporter {
    generation: u64,
    tx: flume::Sender<(u64, RuntimeEvent)>,
}

impl Reporter {
    pub fn new(generation: u64, tx: flume::Sender<(u64, RuntimeEvent)>) -> Self {
        Reporter { generation, tx }
    }

    /// False once the view is gone.
    fn send(&self, event: RuntimeEvent) -> bool {
        self.tx.send((self.generation, event)).is_ok()
    }
}

/// What the window can connect to.
#[derive(Clone, PartialEq)]
pub enum Choice {
    /// A runtime by name: `local` through the launcher, others from `runtimes.json`.
    Named(String),
    /// An address from the command line.
    Direct(Target),
}

impl fmt::Display for Choice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Choice::Named(alias) => f.write_str(alias),
            #[cfg(unix)]
            Choice::Direct(Target::Socket(_)) => f.write_str("this machine (socket)"),
            Choice::Direct(target) => write!(f, "{target}"),
        }
    }
}

/// The launcher, when one was found, and the runtimes it records.
#[derive(Clone, Default)]
pub struct Catalog {
    pub launcher: Option<Launcher>,
    pub runtimes: Option<Runtimes>,
    /// Why the local runtime or the runtimes file is unavailable.
    pub problem: Option<String>,
}

impl Catalog {
    /// Find the launcher and read the runtimes file it points at.
    pub fn load(explicit: Option<&std::path::Path>) -> Catalog {
        let launcher = match Launcher::find(explicit) {
            Ok(launcher) => launcher,
            Err(error) => return Catalog { problem: Some(error.to_string()), ..Catalog::default() },
        };
        match launcher.locate().and_then(|location| Runtimes::load(location.runtimes)) {
            Ok(runtimes) => Catalog { launcher: Some(launcher), runtimes: Some(runtimes), problem: None },
            Err(error) => Catalog { launcher: Some(launcher), runtimes: None, problem: Some(error.to_string()) },
        }
    }
}

/// Read the catalog on a thread, so the window opens at once.
pub fn load_catalog(explicit: Option<std::path::PathBuf>, reporter: Reporter) {
    thread::spawn(move || {
        reporter.send(RuntimeEvent::Catalog(Catalog::load(explicit.as_deref())));
    });
}

/// One attached runtime. Cheap to clone.
#[derive(Clone)]
pub struct Connection {
    client: Client,
    client_id: String,
    streams: Arc<ConnectionStreams>,
}

struct ConnectionStreams {
    attach: TypedStream<types::RemoteEventDownlinkFrame>,
    models: Option<TypedStream<types::DshAgentModelSelection>>,
}

impl Connection {
    /// Leave the runtime: closing `$events` hands this window's pending
    /// approvals back to the Host, and the stream threads end quietly.
    pub fn close(&self) {
        self.streams.attach.stream().close();
        if let Some(models) = &self.streams.models {
            models.stream().close();
        }
    }

    fn closed(&self) -> bool {
        self.streams.attach.stream().is_closed()
    }

    /// Root sessions in every folder, newest first.
    pub fn list_sessions(&self, current_cwd: String, events: Reporter) {
        let client = self.client.clone();
        thread::spawn(move || {
            let options = types::SessionDirectoryOptions {
                current_cwd,
                cwd: types::CwdScope::All,
                query: String::new(),
                sessions: types::SessionScope::Roots,
                sort: types::SessionSort::Newest,
            };
            match client.invoke::<ops::SessionsList>(&types::SessionsListArgs { options }) {
                Ok(rows) => events.send(RuntimeEvent::Sessions(rows.0)),
                Err(error) => events.send(RuntimeEvent::Failed(format!("listing sessions failed: {error}"))),
            };
        });
    }

    /// Whether the runtime shares this machine's filesystem, so local folders can be picked.
    pub fn is_local(&self) -> bool {
        self.client.target().shares_filesystem()
    }

    /// The models every configured provider offers.
    pub fn list_models(&self, events: Reporter) {
        let client = self.client.clone();
        thread::spawn(move || match client.invoke::<ops::ModelsDirectory>(&types::NoArgs(HashMap::new())) {
            Ok(directory) => {
                if !directory.failures.is_empty() {
                    eprintln!("dscode-desktop: model listing failed for {}", directory.failures.join(", "));
                }
                events.send(RuntimeEvent::Models(directory.rows));
            }
            Err(error) => {
                events.send(RuntimeEvent::Failed(format!("listing models failed: {error}")));
            }
        });
    }

    /// Switch to `row`, as the terminal's /model does: prepare the provider
    /// route, apply it to the live session, and save it as the default so the
    /// next session starts from it too.
    pub fn select_model(&self, session_id: Option<String>, row: types::ModelRow, events: Reporter) {
        let client = self.client.clone();
        thread::spawn(move || {
            let selection = types::DshAgentModelSelection { provider: row.provider.clone(), model: row.model.clone(), reasoning_effort: None };
            let result = (|| -> Result<Option<String>, Error> {
                client.invoke::<ops::ModelsEnsureRoute>(&types::ModelsEnsureRouteArgs { provider: row.provider.clone() })?;
                if let Some(session_id) = session_id {
                    let request = types::SessionSelectModelRequest { model: row.model.clone(), provider: row.provider.clone(), reasoning_effort: None, session_id };
                    client.typert::<typert::SessionSelectModel>(&types::SessionSelectModelArgs { request })?;
                }
                let saved = client.invoke::<ops::ModelsSave>(&types::ModelsSaveArgs { selection: selection.clone() })?;
                Ok(saved.rejected.map(|reason| format!("model selection rejected: {reason}")).or(saved.save_error.map(|e| format!("the model applies to this session but was not saved as the default: {e}"))))
            })();
            match result {
                Ok(problem) => {
                    events.send(RuntimeEvent::ModelSelected(selection));
                    if let Some(problem) = problem {
                        events.send(RuntimeEvent::Failed(problem));
                    }
                }
                Err(error) => {
                    events.send(RuntimeEvent::Failed(format!("switching the model failed: {error}")));
                }
            }
        });
    }

    /// Open a session and follow it: a new one in `cwd`, or an existing one,
    /// which the Host resumes when it is not live.
    pub fn open(&self, open: Open, events: Reporter) {
        let connection = self.clone();
        thread::spawn(move || {
            if let Err(error) = connection.follow(open, &events) {
                events.send(RuntimeEvent::SessionFailed(error.to_string()));
            }
        });
    }

    fn follow(&self, open: Open, events: &Reporter) -> Result<(), Error> {
        let session_id = match open {
            Open::Resume(id) => id,
            Open::New { cwd } => {
                let request = types::SessionCreateRequest { agent_preset: Some("dscode".into()), cwd: Some(cwd), session_id: None, workspace_id: None };
                self.client.typert::<typert::SessionCreate>(&types::SessionCreateArgs { request })?.session_id
            }
        };
        let request = types::SessionFollowRequest {
            address: types::SessionAddress::Session { session_id: session_id.clone() },
            assistant_stream: Some(true),
            max_messages: Some(page_messages()),
            turn_window: None,
        };
        let follow = self.client.typert_stream::<typert::SessionFollow>(&types::SessionFollowArgs { request })?;
        let session = Session { connection: self.clone(), id: session_id, follow: Arc::new(follow) };
        if !events.send(RuntimeEvent::Opened(session.clone())) {
            return Ok(());
        }
        let events = events.clone();
        thread::spawn(move || {
            while let Some(frame) = session.follow.recv() {
                let event = match frame {
                    Ok(types::SessionFollowFrame::FollowFrameSnapshot { records, has_more, cursor, .. }) => {
                        let page = has_more.then(|| records.first().map(|first| Page { through: cursor, before: first.event.seq })).flatten();
                        RuntimeEvent::Snapshot { events: records.iter().filter_map(|record| known(&record.event)).collect(), page }
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
                if !events.send(event) {
                    return;
                }
            }
            if !session.follow.stream().is_closed() && !session.connection.closed() {
                events.send(RuntimeEvent::SessionFailed("the session stream closed".into()));
            }
        });
        Ok(())
    }

    pub fn answer(&self, event_id: String, decision: <typert::ApprovalRequest as Waterfall>::Answer, events: Reporter) {
        let (client, client_id) = (self.client.clone(), self.client_id.clone());
        thread::spawn(move || {
            let value = serde_json::to_value(decision).ok();
            let answer = types::RemoteEventResult { client_id, event_id, outcome: types::RemoteEventResultOutcome::Result { value } };
            if let Err(error) = client.typert::<typert::EventsResult>(&answer) {
                events.send(RuntimeEvent::Failed(format!("answering the approval failed: {error}")));
            }
        });
    }

    /// Decline a waterfall this window does not handle, so another client can.
    pub fn pass_on(&self, event_id: String) {
        let (client, client_id) = (self.client.clone(), self.client_id.clone());
        thread::spawn(move || {
            let answer = types::RemoteEventResult { client_id, event_id, outcome: types::RemoteEventResultOutcome::Next };
            if let Err(error) = client.typert::<typert::EventsResult>(&answer) {
                eprintln!("dscode-desktop: passing on a request failed: {error}");
            }
        });
    }
}

pub enum Open {
    New { cwd: String },
    Resume(String),
}

/// One followed session. Cheap to clone.
#[derive(Clone)]
pub struct Session {
    connection: Connection,
    id: String,
    follow: Arc<TypedStream<types::SessionFollowFrame>>,
}

impl Session {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Stop following; the session itself keeps running on the Host.
    pub fn close(&self) {
        self.follow.stream().close();
    }

    /// The page of history before `page`.
    pub fn load_older(&self, page: Page, events: Reporter) {
        let (client, id) = (self.connection.client.clone(), self.id.clone());
        thread::spawn(move || {
            let request = types::SessionPageRequest {
                address: types::SessionAddress::Session { session_id: id },
                before_seq: Some(page.before),
                max_messages: Some(page_messages()),
                through_seq: page.through,
                turn_window: None,
            };
            match client.typert::<typert::SessionPage>(&types::SessionPageArgs { request }) {
                Ok(older) => {
                    let next = older.has_more.then(|| older.records.first().map(|first| Page { through: page.through, before: first.event.seq })).flatten();
                    events.send(RuntimeEvent::Older { events: older.records.iter().filter_map(|record| known(&record.event)).collect(), page: next });
                }
                Err(error) => {
                    events.send(RuntimeEvent::SessionFailed(format!("loading earlier messages failed: {error}")));
                }
            }
        });
    }

    pub fn deliver(&self, text: String, events: Reporter) {
        let args = types::SessionDeliverArgs {
            content: vec![types::ContentBlock::TextBlock(types::TextBlock { text, type_: types::TextBlockType::Text })],
            context: None,
            mode: types::SessionDeliverArgsMode::Followup,
            session_id: self.id.clone(),
        };
        self.background::<ops::SessionDeliver>(args, events);
    }

    pub fn interrupt(&self, events: Reporter) {
        self.background::<ops::SessionInterrupt>(types::SessionInterruptArgs { session_id: self.id.clone() }, events);
    }

    fn background<M: protocol::Method>(&self, args: M::Args, events: Reporter)
    where
        M::Args: Send + 'static,
    {
        let client = self.connection.client.clone();
        thread::spawn(move || {
            if let Err(error) = client.invoke::<M>(&args) {
                events.send(RuntimeEvent::Failed(format!("{}: {error}", M::NAME)));
            }
        });
    }
}

/// Resolve `choice` and attach. Returns at once; `Connected` carries the
/// connection, and its `$events` and model updates follow.
pub fn connect(choice: Choice, catalog: Catalog, cwd: Option<String>, events: Reporter) {
    thread::spawn(move || {
        if let Err(error) = resolve(&choice, &catalog).and_then(|(target, default_cwd)| attach(target, cwd.or(default_cwd), &events)) {
            events.send(RuntimeEvent::Lost(describe(&choice, error)));
        }
    });
}

/// The address for a choice, and the folder its entry names, if any.
fn resolve(choice: &Choice, catalog: &Catalog) -> Result<(Target, Option<String>), Error> {
    match choice {
        Choice::Direct(target) => Ok((target.clone(), None)),
        Choice::Named(alias) => {
            let runtimes = catalog.runtimes.as_ref().ok_or_else(|| Error::Config(catalog.problem.clone().unwrap_or_else(|| "the runtimes are still loading".into())))?;
            runtimes.resolve(alias, catalog.launcher.as_ref())
        }
    }
}

/// A connection failure, worded for the runtime it was meant for.
fn describe(choice: &Choice, error: Error) -> String {
    match (choice, error.code()) {
        (Choice::Named(alias), Some("dscode/unauthorized")) => {
            format!("{alias} refused the token; copy the current one from the server's `dscode server` output")
        }
        (Choice::Named(alias), _) if alias == dscode_client_core::runtimes::LOCAL => format!("the local runtime: {error}"),
        _ => format!("{choice}: {error}"),
    }
}

fn attach(target: Target, cwd: Option<String>, events: &Reporter) -> Result<(), Error> {
    let client = Client::new(target);
    let status = client.host_status()?;
    let host_behind = protocol::compatibility(&status, protocol::PROTOCOL).map_err(|reason| Error::Protocol(format!("the runtime {reason}")))?;

    let attach = client.typert_stream::<typert::Events>(&types::NoArgs(HashMap::new()))?;
    let client_id = match attach.recv() {
        Some(Ok(types::RemoteEventDownlinkFrame::ReadyFrame(ready))) => ready.client_id,
        Some(Err(error)) => return Err(error),
        other => return Err(Error::Protocol(format!("expected ready on $events, got {other:?}"))),
    };
    // The model chip is a nicety; a Host without the watch still works.
    let models = client.watch::<ops::ModelsDefaults>(&types::NoArgs(HashMap::new())).ok();

    let connection = Connection { client, client_id, streams: Arc::new(ConnectionStreams { attach, models }) };
    let default_cwd = cwd.or(status.default_cwd).unwrap_or_else(|| ".".into());
    let version = if host_behind { format!("{} (older protocol)", status.version) } else { status.version };
    events.send(RuntimeEvent::Connected { version, default_cwd, connection: connection.clone() });

    if connection.streams.models.is_some() {
        let (events, connection) = (events.clone(), connection.clone());
        thread::spawn(move || {
            let Some(models) = &connection.streams.models else { return };
            while let Some(Ok(model)) = models.recv() {
                if !events.send(RuntimeEvent::DefaultModel(model)) {
                    return;
                }
            }
        });
    }

    // $events: approvals go to the view, which knows the session it shows; other waterfalls are passed on.
    let events = events.clone();
    thread::spawn(move || {
        while let Some(frame) = connection.streams.attach.recv() {
            let event = match frame {
                Ok(types::RemoteEventDownlinkFrame::InvocationFrame(invocation)) => {
                    if invocation.event != typert::ApprovalRequest::EVENT {
                        connection.pass_on(invocation.event_id);
                        continue;
                    }
                    match serde_json::from_value::<types::ApprovalRequestPayload>(invocation.request.clone().into()) {
                        Ok(payload) => RuntimeEvent::Approval { session_id: invocation.agent_id, event_id: invocation.event_id, payload },
                        Err(error) => {
                            eprintln!("dscode-desktop: unreadable approval request: {error}");
                            connection.pass_on(invocation.event_id);
                            continue;
                        }
                    }
                }
                Ok(types::RemoteEventDownlinkFrame::CancellationFrame(cancel)) => RuntimeEvent::Withdrawn(cancel.event_id),
                Ok(types::RemoteEventDownlinkFrame::EmitFrame(emit)) if emit.event == "api-session/status" => {
                    let Some(session_id) = emit.args.first().and_then(|id| id.as_str()) else { continue };
                    let running = emit.args.get(1).and_then(|running| running.as_bool()).unwrap_or(false);
                    RuntimeEvent::Running { session_id: session_id.to_owned(), running }
                }
                Ok(_) => continue,
                Err(error) => {
                    eprintln!("dscode-desktop: {error}");
                    continue;
                }
            };
            if !events.send(event) {
                return;
            }
        }
        if !connection.closed() {
            events.send(RuntimeEvent::Lost("the runtime connection closed".into()));
        }
    });
    Ok(())
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
