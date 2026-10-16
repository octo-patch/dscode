use crate::runtime::{self, Catalog, Choice, Connection, Live, Open, Page, Reporter, RuntimeEvent, Session};
use crate::transcript::{Entry, Role, ToolStatus, Transcript};
use dscode_client_core::protocol::types;
use dscode_client_core::runtimes::LOCAL;
use gpui_kit::component::button::{Button, ButtonRounded, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::text::TextView;
use gpui_kit::assets::IconName;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Disableable as _, Icon, Sizable as _, Theme, WindowExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

/// The conversation column's width; wider windows center it.
const COLUMN: f32 = 760.;
const SIDEBAR: f32 = 264.;

struct Approval {
    event_id: String,
    tool: String,
    reason: String,
}

/// How the window was started: what to connect to first and the launcher to use.
pub struct Startup {
    /// `None`: the default runtime from `runtimes.json`.
    pub choice: Option<Choice>,
    pub cwd: Option<String>,
    pub launcher: Option<std::path::PathBuf>,
    /// A session to open on the first connection instead of a new one.
    pub session: Option<String>,
}

/// The "Add a server" form.
struct ServerForm {
    alias: Entity<InputState>,
    address: Entity<InputState>,
    token: Entity<InputState>,
    cwd: Entity<InputState>,
    error: Option<SharedString>,
}

pub struct ChatView {
    transcript: Entity<Transcript>,
    scroller: Entity<MessageScrollerState>,
    input: Entity<TextareaState>,
    tx: flume::Sender<(u64, RuntimeEvent)>,
    /// Source of generations; `connection_generation` and `session_generation`
    /// are the ones whose events are still wanted.
    next_generation: u64,
    connection_generation: u64,
    session_generation: u64,
    catalog: Option<Catalog>,
    /// What this window is connected (or connecting) to; `None` until the catalog names the default.
    choice: Option<Choice>,
    cwd: Option<String>,
    resume_first: Option<String>,
    /// The first message of a draft, delivered once its session is created.
    pending: Option<String>,
    connection: Option<Connection>,
    session: Option<Session>,
    /// Shown in the header while a session opens, and its folder.
    opening: bool,
    version: Option<SharedString>,
    default_cwd: Option<String>,
    /// The model new turns use: the deployment default, or the last pick.
    model: Option<types::DshAgentModelSelection>,
    models: Vec<types::ModelRow>,
    /// The folder a draft will be created in; `None` is the runtime's default.
    draft_cwd: Option<String>,
    sessions: Vec<types::SessionRow>,
    running_sessions: HashSet<String>,
    form: Option<ServerForm>,
    error: Option<SharedString>,
    /// The connection is gone; the error bar offers to reconnect.
    lost: bool,
    /// An established connection broke: retry on a timer and reopen the shown session.
    reconnecting: bool,
    retries: u32,
    approvals: Vec<Approval>,
    /// Where older history of the shown session continues, if it does.
    older: Option<Page>,
    loading_older: bool,
}

impl ChatView {
    pub fn new(startup: Startup, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Theme::sync_system_appearance(Some(window), cx);
        cx.observe_window_appearance(window, |_, window, cx| Theme::sync_system_appearance(Some(window), cx)).detach();

        let transcript = cx.new(|_| Transcript::default());
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Ask DSCODE to build, fix or explain something…")
                .auto_grow(1, 10)
                .submit_on_enter(true)
        });
        cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { shift: false, .. } = event {
                this.send(window, cx);
            }
        })
        .detach();

        let (tx, rx) = flume::unbounded();
        cx.spawn(async move |this, cx| {
            while let Ok((generation, event)) = rx.recv_async().await {
                if this.update(cx, |view, cx| view.apply(generation, event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        runtime::load_catalog(startup.launcher, Reporter::new(0, tx.clone()));
        input.update(cx, |input, cx| input.focus(window, cx));

        let mut view = ChatView {
            transcript,
            scroller,
            input,
            tx,
            next_generation: 1,
            connection_generation: 0,
            session_generation: 0,
            catalog: None,
            choice: None,
            cwd: startup.cwd,
            resume_first: startup.session,
            pending: None,
            connection: None,
            session: None,
            opening: false,
            version: None,
            default_cwd: None,
            model: None,
            models: Vec::new(),
            draft_cwd: None,
            sessions: Vec::new(),
            running_sessions: HashSet::new(),
            form: None,
            error: None,
            lost: false,
            reconnecting: false,
            retries: 0,
            approvals: Vec::new(),
            older: None,
            loading_older: false,
        };
        // An address from the command line needs no catalog; a name waits for it.
        if let Some(choice) = startup.choice {
            let direct = matches!(choice, Choice::Direct(_));
            view.choice = Some(choice);
            if direct {
                view.connect(cx);
            }
        }
        view
    }

    fn generation(&mut self) -> u64 {
        self.next_generation += 1;
        self.next_generation
    }

    fn connection_reporter(&self) -> Reporter {
        Reporter::new(self.connection_generation, self.tx.clone())
    }

    fn session_reporter(&self) -> Reporter {
        Reporter::new(self.session_generation, self.tx.clone())
    }

    /// Leave the current runtime, if any, and connect to `self.choice`.
    fn connect(&mut self, cx: &mut Context<Self>) {
        let Some(choice) = self.choice.clone() else { return };
        if self.reconnecting {
            // Keep the conversation on screen; it is reloaded once the session reopens.
            if let Some(session) = self.session.take() {
                session.close();
            }
            self.session_generation = self.generation();
        } else {
            self.leave_session(cx);
        }
        if let Some(connection) = self.connection.take() {
            connection.close();
        }
        self.connection_generation = self.generation();
        self.version = None;
        self.model = None;
        self.models.clear();
        self.draft_cwd = None;
        self.sessions.clear();
        self.running_sessions.clear();
        self.error = None;
        self.lost = false;
        runtime::connect(choice, self.catalog.clone().unwrap_or_default(), self.cwd.clone(), self.connection_reporter());
        cx.notify();
    }

    fn switch(&mut self, choice: Choice, cx: &mut Context<Self>) {
        self.choice = Some(choice);
        self.reconnecting = false;
        self.retries = 0;
        self.resume_first = None;
        self.connect(cx);
    }

    /// Connect again to the same runtime and reopen the session that was shown.
    fn reconnect(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = &self.session {
            self.resume_first = Some(session.id().to_owned());
        }
        self.reconnecting = true;
        self.connect(cx);
    }

    /// Retry after 1, 2, 4… up to 15 seconds, unless the window moved on meanwhile.
    fn schedule_reconnect(&mut self, cx: &mut Context<Self>) {
        let delay = std::time::Duration::from_secs((1u64 << self.retries.min(4)).min(15));
        self.retries += 1;
        let generation = self.connection_generation;
        self.error = Some(format!("{} — reconnecting in {}s", self.error.as_deref().unwrap_or("connection lost"), delay.as_secs()).into());
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |view, cx| {
                if view.connection_generation == generation && view.lost && view.reconnecting {
                    view.reconnect(cx);
                }
            });
        })
        .detach();
    }

    /// Stop following the shown session and clear the conversation.
    fn leave_session(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.session.take() {
            session.close();
        }
        self.session_generation = self.generation();
        self.transcript.update(cx, |t, _| *t = Transcript::default());
        self.scroller.update(cx, |scroller, cx| scroller.reset(0, cx));
        self.approvals.clear();
        self.opening = false;
        self.older = None;
        self.loading_older = false;
    }

    fn open(&mut self, open: Open, cx: &mut Context<Self>) {
        let Some(connection) = self.connection.clone() else { return };
        self.leave_session(cx);
        self.opening = true;
        self.error = None;
        connection.open(open, self.session_reporter());
        cx.notify();
    }

    /// Show an empty draft; the session is created when its first message is sent,
    /// so opening the window or pressing "New session" leaves no empty sessions behind.
    fn new_session(&mut self, cx: &mut Context<Self>) {
        self.leave_session(cx);
        self.pending = None;
        cx.notify();
    }

    fn resume(&mut self, id: String, cx: &mut Context<Self>) {
        if self.session.as_ref().is_some_and(|session| session.id() == id) {
            return;
        }
        self.pending = None;
        self.open(Open::Resume(id), cx);
    }

    fn refresh_sessions(&self) {
        if let Some(connection) = &self.connection {
            connection.list_sessions(self.default_cwd.clone().unwrap_or_default(), self.connection_reporter());
        }
    }

    fn running(&self) -> bool {
        self.session.as_ref().is_some_and(|session| self.running_sessions.contains(session.id()))
    }

    fn apply(&mut self, generation: u64, event: RuntimeEvent, cx: &mut Context<Self>) {
        if let RuntimeEvent::Catalog(catalog) = event {
            if self.choice.is_none() {
                let default = catalog.runtimes.as_ref().map_or(LOCAL, |runtimes| runtimes.default_alias());
                self.choice = Some(Choice::Named(default.to_owned()));
            }
            self.catalog = Some(catalog);
            if self.connection.is_none() && !matches!(self.choice, Some(Choice::Direct(_))) {
                self.connect(cx);
            }
            cx.notify();
            return;
        }
        let wanted = if event.is_session_event() { self.session_generation } else { self.connection_generation };
        if generation != wanted {
            // Something this window already left; what finished opening late is closed again.
            match event {
                RuntimeEvent::Connected { connection, .. } => connection.close(),
                RuntimeEvent::Opened(session) => session.close(),
                _ => {}
            }
            return;
        }
        let before = self.transcript.read(cx).len();
        match event {
            RuntimeEvent::Catalog(_) => unreachable!("handled above"),
            RuntimeEvent::Connected { version, default_cwd, connection } => {
                self.reconnecting = false;
                self.retries = 0;
                self.version = Some(version.into());
                self.default_cwd = Some(default_cwd);
                connection.list_models(self.connection_reporter());
                self.connection = Some(connection);
                self.error = None;
                self.refresh_sessions();
                match self.resume_first.take() {
                    Some(id) => self.resume(id, cx),
                    None => self.new_session(cx),
                }
            }
            RuntimeEvent::Lost(message) => {
                let was_connected = self.connection.take().inspect(Connection::close).is_some();
                if was_connected {
                    if let Some(session) = &self.session {
                        self.resume_first = Some(session.id().to_owned());
                    }
                    self.reconnecting = true;
                }
                self.error = Some(message.into());
                self.lost = true;
                self.version = None;
                self.approvals.clear();
                self.running_sessions.clear();
                self.opening = false;
                if self.reconnecting {
                    self.schedule_reconnect(cx);
                }
            }
            RuntimeEvent::Failed(message) => self.error = Some(message.into()),
            RuntimeEvent::Sessions(rows) => self.sessions = rows,
            RuntimeEvent::DefaultModel(model) | RuntimeEvent::ModelSelected(model) => self.model = Some(model),
            RuntimeEvent::Models(rows) => self.models = rows,
            RuntimeEvent::Approval { session_id, event_id, payload } => {
                let ours = self.session.as_ref().is_some_and(|session| session.id() == session_id);
                match (&self.connection, ours) {
                    (_, true) => {
                        // Prefer the Chinese wording when the asker provided one.
                        let shown = payload.display_reason.map(|reason| reason.extra.get("zh").cloned().unwrap_or(reason.en));
                        let reason = shown.or(payload.reason).unwrap_or_default();
                        self.approvals.push(Approval { event_id, tool: payload.tool_name, reason });
                    }
                    (Some(connection), false) => connection.pass_on(event_id),
                    (None, false) => {}
                }
            }
            RuntimeEvent::Withdrawn(event_id) => self.approvals.retain(|a| a.event_id != event_id),
            RuntimeEvent::Running { session_id, running } => {
                let shown = self.session.as_ref().is_some_and(|session| session.id() == session_id);
                if running {
                    self.running_sessions.insert(session_id);
                } else {
                    self.running_sessions.remove(&session_id);
                    if shown {
                        self.transcript.update(cx, |t, _| t.settle());
                    }
                    // A finished turn may have titled the session.
                    self.refresh_sessions();
                }
            }
            RuntimeEvent::Opened(session) => {
                self.opening = false;
                if let Some(text) = self.pending.take() {
                    session.deliver(text, self.session_reporter());
                    self.refresh_sessions();
                }
                self.session = Some(session);
            }
            RuntimeEvent::Snapshot { events, page } => {
                self.older = page;
                self.transcript.update(cx, |t, _| {
                    for event in &events {
                        t.fold(event);
                    }
                });
            }
            RuntimeEvent::Older { events, page } => {
                self.older = page;
                self.loading_older = false;
                let added = self.transcript.update(cx, |t, _| t.prepend(&events));
                self.scroller.update(cx, |scroller, cx| {
                    scroller.prepend(added, cx);
                });
                cx.notify();
                return;
            }
            RuntimeEvent::Committed(events) => self.transcript.update(cx, |t, _| {
                for event in &events {
                    t.fold(event);
                }
            }),
            RuntimeEvent::Live(live) => self.transcript.update(cx, |t, _| match live {
                Live::Start => t.start_live(),
                Live::Text(text) => t.push_live(&text),
                Live::End => {}
            }),
            RuntimeEvent::SessionFailed(message) => {
                self.opening = false;
                self.loading_older = false;
                self.pending = None;
                self.error = Some(message.into());
            }
        }
        let after = self.transcript.read(cx).len();
        self.scroller.update(cx, |scroller, cx| {
            if after > before {
                scroller.append(after - before, cx);
            } else if after < before {
                scroller.reset(after, cx);
            }
            // The last row grows while it streams.
            if after > 0 {
                scroller.remeasure_items(after - 1..after, cx);
            }
        });
        cx.notify();
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().trim().to_owned();
        if text.is_empty() || self.connection.is_none() || self.opening {
            return;
        }
        match &self.session {
            Some(session) => session.deliver(text, self.session_reporter()),
            None => {
                let cwd = self.draft_folder();
                self.open(Open::New { cwd }, cx);
                self.pending = Some(text);
            }
        }
        self.input.update(cx, |input, cx| input.set_value("", window, cx));
    }

    /// The folder of the shown session, or the one a draft will be created in.
    fn folder(&self) -> String {
        let session = self.session.as_ref().and_then(|session| self.sessions.iter().find(|row| row.id == session.id()));
        match session {
            Some(row) => row.cwd.clone(),
            None => self.draft_folder(),
        }
    }

    fn draft_folder(&self) -> String {
        self.draft_cwd.clone().or_else(|| self.default_cwd.clone()).unwrap_or_else(|| ".".into())
    }

    fn pick_model(&mut self, row: types::ModelRow, cx: &mut Context<Self>) {
        if let Some(connection) = &self.connection {
            let session = self.session.as_ref().map(|session| session.id().to_owned());
            connection.select_model(session, row, self.connection_reporter());
        }
        cx.notify();
    }

    fn pick_folder(&mut self, folder: String, cx: &mut Context<Self>) {
        self.draft_cwd = Some(folder);
        cx.notify();
    }

    /// Ask for a folder with the system dialog (a runtime on this machine only).
    fn browse_folder(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Work in this folder".into()) });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                if let Some(path) = paths.into_iter().next() {
                    let _ = this.update(cx, |view, cx| view.pick_folder(path.to_string_lossy().into_owned(), cx));
                }
            }
        })
        .detach();
    }

    fn load_older(&mut self, cx: &mut Context<Self>) {
        let (Some(session), Some(page)) = (&self.session, self.older) else { return };
        if self.loading_older {
            return;
        }
        self.loading_older = true;
        session.load_older(page, self.session_reporter());
        cx.notify();
    }

    fn interrupt(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = &self.session {
            session.interrupt(self.session_reporter());
        }
        cx.notify();
    }

    fn answer(&mut self, allow: bool, cx: &mut Context<Self>) {
        if self.approvals.is_empty() {
            return;
        }
        let approval = self.approvals.remove(0);
        if let Some(connection) = &self.connection {
            let decision = if allow { types::ApprovalOutcome::AllowedOnce } else { types::ApprovalOutcome::Rejected };
            connection.answer(approval.event_id, decision, self.connection_reporter());
        }
        cx.notify();
    }
}

// Runtimes: the shared runtimes.json, the switcher and the "Add a server" dialog.
impl ChatView {
    /// Change `runtimes.json` (shared with the terminal) and show the result in the menu.
    fn edit_runtimes(&mut self, edit: impl FnOnce(&mut dscode_client_core::Runtimes) -> dscode_client_core::Result<()>) -> Result<(), String> {
        let catalog = self.catalog.as_mut().ok_or("the runtimes are still loading")?;
        let runtimes = catalog.runtimes.as_mut().ok_or_else(|| catalog.problem.clone().unwrap_or_default())?;
        // Start from the file as it is now: a terminal may have changed it since.
        let mut fresh = dscode_client_core::Runtimes::load(runtimes.path()).map_err(|e| e.to_string())?;
        edit(&mut fresh).and_then(|()| fresh.save()).map_err(|e| e.to_string())?;
        *runtimes = fresh;
        Ok(())
    }

    fn open_server_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let field = |placeholder: &'static str, masked: bool, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).masked(masked))
        };
        let form = ServerForm {
            alias: field("Name, e.g. devbox", false, window, cx),
            address: field("Address, HOST:PORT", false, window, cx),
            token: field("Token printed by `dscode server`", true, window, cx),
            cwd: field("Folder on the server (optional, absolute)", false, window, cx),
            error: None,
        };
        form.alias.update(cx, |input, cx| input.focus(window, cx));
        self.form = Some(form);
        let view = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, cx| {
            let Some(view) = view.upgrade() else { return dialog };
            let Some(form) = &view.read(cx).form else { return dialog };
            let danger = cx.theme().danger;
            let (on_add, on_cancel) = (view.downgrade(), view.downgrade());
            dialog
                .title("Add a server")
                .child(
                    v_flex()
                        .gap_2()
                        .child(Input::new(&form.alias))
                        .child(Input::new(&form.address))
                        .child(Input::new(&form.token))
                        .child(Input::new(&form.cwd))
                        .when_some(form.error.clone(), |col, error| col.child(div().text_sm().text_color(danger).child(error))),
                )
                .footer(
                    h_flex()
                        .gap_2()
                        .justify_end()
                        .child(Button::new("cancel-server").label("Cancel").on_click(move |_, window, cx| {
                            let _ = on_cancel.update(cx, |view, _| view.form = None);
                            window.close_dialog(cx);
                        }))
                        .child(Button::new("add-server").primary().label("Add and connect").on_click(move |_, window, cx| {
                            if on_add.update(cx, |view, cx| view.add_server(cx)).unwrap_or(false) {
                                window.close_dialog(cx);
                            }
                        })),
                )
        });
    }

    /// Save the form as a runtime and switch to it; false (with the reason in the form) when it is invalid.
    fn add_server(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(form) = &self.form else { return false };
        let value = |input: &Entity<InputState>| input.read(cx).value().trim().to_owned();
        let (alias, address, token, cwd) = (value(&form.alias), value(&form.address), value(&form.token), value(&form.cwd));
        let cwd = (!cwd.is_empty()).then_some(cwd);
        match self.edit_runtimes(|runtimes| runtimes.set_remote(&alias, &address, &token, cwd.as_deref())) {
            Ok(()) => {
                self.form = None;
                self.switch(Choice::Named(alias), cx);
                true
            }
            Err(error) => {
                if let Some(form) = &mut self.form {
                    form.error = Some(error.into());
                }
                cx.notify();
                false
            }
        }
    }

    fn forget(&mut self, alias: String, cx: &mut Context<Self>) {
        match self.edit_runtimes(|runtimes| runtimes.remove(&alias)) {
            Ok(()) if self.choice == Some(Choice::Named(alias)) => self.switch(Choice::Named(LOCAL.into()), cx),
            Ok(()) => cx.notify(),
            Err(error) => {
                self.error = Some(error.into());
                cx.notify();
            }
        }
    }

    fn make_default(&mut self, alias: String, cx: &mut Context<Self>) {
        if let Err(error) = self.edit_runtimes(|runtimes| runtimes.set_default(&alias)) {
            self.error = Some(error.into());
        }
        cx.notify();
    }

    /// The runtime switcher at the top of the sidebar.
    fn runtime_menu(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self.choice.clone();
        let theme = cx.theme();
        let dot = if self.connection.is_some() && !self.lost {
            theme.success
        } else if self.lost {
            theme.danger
        } else {
            theme.warning
        };
        let label = current.as_ref().map_or("…".to_owned(), Choice::to_string);
        let runtimes = self.catalog.as_ref().and_then(|catalog| catalog.runtimes.clone());
        let view = cx.entity().downgrade();
        let trigger = Button::new("runtime")
            .ghost()
            .accessibility_label(format!("Runtime: {label}"))
            .w_full()
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .child(div().size(px(8.)).rounded_full().bg(dot))
                    .child(Icon::new(IconName::Server).small())
                    .child(div().flex_1().truncate().font_weight(FontWeight::MEDIUM).child(label))
                    .child(Icon::new(IconName::ChevronsUpDown).xsmall()),
            );
        trigger.dropdown_menu(move |mut menu, _, _| {
            let aliases = runtimes.as_ref().map_or_else(|| vec![LOCAL.to_owned()], |r| r.aliases());
            let default = runtimes.as_ref().map_or(LOCAL, |r| r.default_alias()).to_owned();
            for alias in aliases {
                let choice = Choice::Named(alias.clone());
                let checked = current.as_ref() == Some(&choice);
                let shown = if alias == default { format!("{alias} (default)") } else { alias.clone() };
                let view = view.clone();
                menu = menu.item(PopupMenuItem::new(shown).checked(checked).on_click(move |_, _, cx| {
                    let _ = view.update(cx, |view, cx| view.switch(choice.clone(), cx));
                }));
            }
            if let Some(Choice::Direct(target)) = &current {
                menu = menu.item(PopupMenuItem::new(target.to_string()).checked(true));
            }
            menu = menu.separator();
            let add = view.clone();
            menu = menu.item(PopupMenuItem::new("Add a server…").icon(IconName::Plus).disabled(runtimes.is_none()).on_click(move |_, window, cx| {
                let _ = add.update(cx, |view, cx| view.open_server_form(window, cx));
            }));
            if let Some(Choice::Named(alias)) = current.clone() {
                if alias != default {
                    let (view, alias) = (view.clone(), alias.clone());
                    menu = menu.item(PopupMenuItem::new(format!("Use {alias} by default")).on_click(move |_, _, cx| {
                        let _ = view.update(cx, |view, cx| view.make_default(alias.clone(), cx));
                    }));
                }
                if alias != LOCAL {
                    let view = view.clone();
                    menu = menu.item(PopupMenuItem::new(format!("Forget {alias}")).on_click(move |_, _, cx| {
                        let _ = view.update(cx, |view, cx| view.forget(alias.clone(), cx));
                    }));
                }
            }
            menu
        })
    }
}

/// Sessions grouped by how long ago they were last active.
fn age_group(updated_ms: f64, now_ms: f64) -> &'static str {
    let hours = (now_ms - updated_ms) / 3_600_000.;
    if hours < 24. {
        "Last 24 hours"
    } else if hours < 24. * 7. {
        "Last 7 days"
    } else if hours < 24. * 30. {
        "Last 30 days"
    } else {
        "Older"
    }
}

/// The last component of a path, for chips and session rows.
fn folder_name(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or(trimmed).to_owned()
}

/// A path with the home folder written as `~`.
fn tidy_path(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && path.starts_with(&home) => format!("~{}", &path[home.len()..]),
        _ => path.to_owned(),
    }
}

fn session_title(row: &types::SessionRow) -> String {
    row.title.clone().filter(|title| !title.trim().is_empty()).unwrap_or_else(|| "Untitled session".into())
}

// Layout: sidebar, conversation, composer.
impl ChatView {
    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (sidebar, border, muted, accent, accent_fg, success) =
            (theme.sidebar, theme.sidebar_border, theme.muted_foreground, theme.sidebar_accent, theme.sidebar_accent_foreground, theme.success);
        let current = self.session.as_ref().map(|session| session.id().to_owned());
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0., |d| d.as_millis() as f64);

        let mut list = v_flex().gap_0p5();
        let mut group = "";
        for (index, row) in self.sessions.iter().enumerate() {
            let heading = age_group(row.updated_at, now);
            if heading != group {
                group = heading;
                list = list.child(div().px_2().pt_3().pb_1().text_xs().font_weight(FontWeight::MEDIUM).text_color(muted).child(heading));
            }
            let selected = current.as_deref() == Some(row.id.as_str());
            let running = self.running_sessions.contains(&row.id);
            let id = row.id.clone();
            list = list.child(
                h_flex()
                    .id(("session", index))
                    .px_2()
                    .py_1p5()
                    .gap_2()
                    .rounded_md()
                    .cursor_pointer()
                    .when(selected, |row| row.bg(accent).text_color(accent_fg))
                    .when(!selected, |row| row.hover(|row| row.bg(accent.opacity(0.5))))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(div().text_sm().truncate().child(session_title(row)))
                            .child(div().text_xs().text_color(muted).truncate().child(folder_name(&row.cwd))),
                    )
                    .when(running, |row| row.child(div().size(px(7.)).rounded_full().bg(success)))
                    .on_click(cx.listener(move |this, _, _, cx| this.resume(id.clone(), cx))),
            );
        }
        if self.sessions.is_empty() && self.connection.is_some() {
            list = list.child(div().px_2().pt_3().text_sm().text_color(muted).child("No earlier sessions"));
        }

        let footer = self.version.clone().map_or_else(
            || if self.lost { "Not connected".into() } else { "Connecting…".into() },
            |version| SharedString::from(format!("DSCODE {version}")),
        );
        v_flex()
            .w(px(SIDEBAR))
            .h_full()
            .flex_shrink_0()
            .bg(sidebar)
            .border_r_1()
            .border_color(border)
            .child(v_flex().p_2().gap_1().child(self.runtime_menu(cx)).child(
                Button::new("new-session")
                    .ghost()
                    .w_full()
                    .disabled(self.connection.is_none())
                    .child(h_flex().w_full().gap_2().child(Icon::new(IconName::SquarePen).small()).child("New session"))
                    .on_click(cx.listener(|this, _, _, cx| this.new_session(cx))),
            ))
            .child(div().id("sessions").flex_1().min_h_0().overflow_y_scroll().px_2().pb_2().child(list))
            .child(div().px_4().py_2().border_t_1().border_color(border).text_xs().text_color(muted).child(footer))
    }

    fn render_row(transcript: &Entity<Transcript>, index: usize, cx: &mut App) -> AnyElement {
        let theme = cx.theme();
        let (muted, secondary, border, danger, success) = (theme.muted_foreground, theme.secondary, theme.border, theme.danger, theme.success);
        let entry: Entry = transcript.read(cx).row(index);
        let body = match entry.role {
            Role::User => h_flex()
                .justify_end()
                .child(div().max_w(relative(0.85)).rounded_2xl().bg(secondary).px_4().py_2p5().child(entry.text))
                .into_any_element(),
            Role::Assistant if entry.text.is_empty() => {
                h_flex().gap_2().text_sm().text_color(muted).child(Spinner::new().small()).child("Thinking…").into_any_element()
            }
            Role::Assistant => TextView::markdown(("message", index), entry.text).into_any_element(),
            Role::Tool => {
                let icon = match entry.status {
                    ToolStatus::Running => Spinner::new().xsmall().into_any_element(),
                    ToolStatus::Done => Icon::new(IconName::CircleCheck).xsmall().text_color(success).into_any_element(),
                    ToolStatus::Failed => Icon::new(IconName::CircleX).xsmall().text_color(danger).into_any_element(),
                };
                v_flex()
                    .rounded_lg()
                    .border_1()
                    .border_color(border)
                    .px_3()
                    .py_2()
                    .gap_1()
                    .text_sm()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(icon)
                            .child(div().font_weight(FontWeight::MEDIUM).child(entry.text))
                            .child(div().flex_1().min_w_0().truncate().font_family("Menlo").text_xs().text_color(muted).child(entry.detail)),
                    )
                    .when_some(entry.error, |card, error| card.child(div().pl_6().text_xs().text_color(danger).child(error)))
                    .into_any_element()
            }
        };
        h_flex().w_full().justify_center().px_6().py_2().child(div().w_full().max_w(px(COLUMN)).child(body)).into_any_element()
    }

    fn render_empty(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let subtitle = match (&self.connection, self.opening) {
            (None, _) if self.lost => "Not connected — reconnect or pick another runtime.".to_owned(),
            (None, _) => "Connecting to the runtime…".to_owned(),
            (Some(_), true) if self.pending.is_some() => "Starting the session…".to_owned(),
            (Some(_), true) => "Opening the session…".to_owned(),
            (Some(_), false) => format!("Working in {}", tidy_path(&self.folder())),
        };
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_3()
            .child(Icon::new(IconName::Sparkles).large().text_color(muted))
            .child(div().text_2xl().font_weight(FontWeight::SEMIBOLD).child("What should we build?"))
            .child(div().text_sm().text_color(muted).child(subtitle))
    }

    /// The folder chip: fixed for an open session; for a draft, recent folders,
    /// the runtime's default and, on this machine, the system folder dialog.
    fn folder_chip(&self, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let folder = self.folder();
        let label = h_flex().gap_1().text_xs().text_color(muted).child(Icon::new(IconName::Folder).xsmall()).child(folder_name(&folder));
        if self.session.is_some() || self.connection.is_none() {
            return div().px_2().py_0p5().child(label).into_any_element();
        }
        let mut folders: Vec<String> = Vec::new();
        for cwd in self.default_cwd.iter().chain(self.sessions.iter().map(|row| &row.cwd)) {
            if !folders.contains(cwd) && folders.len() < 8 {
                folders.push(cwd.clone());
            }
        }
        let local = self.connection.as_ref().is_some_and(Connection::is_local);
        let view = cx.entity().downgrade();
        Button::new("folder")
            .ghost()
            .accessibility_label(format!("Folder: {}", tidy_path(&self.folder())))
            .xsmall()
            .child(label.child(Icon::new(IconName::ChevronDown).xsmall()))
            .dropdown_menu_with_anchor(Anchor::BottomLeft, move |mut menu, _, _| {
                menu = menu.label("Start the session in");
                for cwd in &folders {
                    let (view, chosen) = (view.clone(), cwd.clone());
                    menu = menu.item(PopupMenuItem::new(tidy_path(cwd)).checked(*cwd == folder).on_click(move |_, _, cx| {
                        let _ = view.update(cx, |view, cx| view.pick_folder(chosen.clone(), cx));
                    }));
                }
                if local {
                    let view = view.clone();
                    menu = menu.separator().item(PopupMenuItem::new("Choose a folder…").icon(IconName::FolderOpen).on_click(move |_, _, cx| {
                        let _ = view.update(cx, |view, cx| view.browse_folder(cx));
                    }));
                }
                menu
            })
            .into_any_element()
    }

    /// The model chip: every model the runtime's providers offer, by provider.
    fn model_chip(&self, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let Some(current) = self.model.clone() else { return div().into_any_element() };
        let shown = self
            .models
            .iter()
            .find(|row| row.provider == current.provider && row.model == current.model)
            .map_or_else(|| current.model.clone(), |row| row.model_name.clone());
        let label = h_flex().gap_1().text_xs().text_color(muted).child(Icon::new(IconName::Cpu).xsmall()).child(shown).child(Icon::new(IconName::ChevronDown).xsmall());
        let rows = self.models.clone();
        let view = cx.entity().downgrade();
        Button::new("model")
            .ghost()
            .accessibility_label(format!("Model: {}", current.model))
            .xsmall()
            .child(label)
            .dropdown_menu_with_anchor(Anchor::BottomLeft, move |mut menu, _, _| {
                if rows.is_empty() {
                    return menu.label("Loading models…");
                }
                let mut provider = None;
                for row in &rows {
                    if provider != Some(&row.provider_name) {
                        if provider.is_some() {
                            menu = menu.separator();
                        }
                        provider = Some(&row.provider_name);
                        menu = menu.label(row.provider_name.clone());
                    }
                    let checked = row.provider == current.provider && row.model == current.model;
                    let (view, picked) = (view.clone(), row.clone());
                    menu = menu.item(PopupMenuItem::new(row.model_name.clone()).checked(checked).on_click(move |_, _, cx| {
                        let _ = view.update(cx, |view, cx| view.pick_model(picked.clone(), cx));
                    }));
                }
                menu.max_h(px(420.)).scrollable(true)
            })
            .into_any_element()
    }

    fn render_composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (background, border, muted, warning) = (theme.background, theme.border, theme.muted_foreground, theme.warning);
        let action = if self.running() {
            Button::new("stop").icon(IconName::Square).rounded(ButtonRounded::Size(px(16.))).tooltip("Stop").on_click(cx.listener(|this, _, _, cx| this.interrupt(cx)))
        } else {
            Button::new("send")
                .primary()
                .icon(IconName::ArrowUp)
                .rounded(ButtonRounded::Size(px(16.)))
                .tooltip("Send")
                .disabled(self.connection.is_none() || self.opening)
                .on_click(cx.listener(|this, _, window, cx| this.send(window, cx)))
        };

        let approval = self.approvals.first().map(|approval| {
            h_flex()
                .gap_3()
                .px_4()
                .py_3()
                .rounded_xl()
                .border_1()
                .border_color(warning)
                .bg(warning.opacity(0.08))
                .child(Icon::new(IconName::ShieldAlert).text_color(warning))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(format!("Allow {}?", approval.tool)))
                        .child(div().text_sm().text_color(muted).child(approval.reason.clone())),
                )
                .child(Button::new("reject").label("Reject").on_click(cx.listener(|this, _, _, cx| this.answer(false, cx))))
                .child(Button::new("allow").primary().label("Allow once").on_click(cx.listener(|this, _, _, cx| this.answer(true, cx))))
        });

        let card = v_flex()
            .rounded_2xl()
            .border_1()
            .border_color(border)
            .bg(background)
            .shadow_md()
            .px_3()
            .pt_2()
            .pb_2()
            .gap_1()
            .child(Textarea::new(&self.input).appearance(false))
            .child(
                h_flex()
                    .gap_1()
                    .child(self.folder_chip(cx))
                    .child(self.model_chip(cx))
                    .child(div().flex_1())
                    .child(action),
            );
        h_flex()
            .w_full()
            .justify_center()
            .px_6()
            .pb_5()
            .pt_2()
            .child(v_flex().w_full().max_w(px(COLUMN)).gap_2().children(approval).child(card))
    }
}

impl Render for ChatView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (background, border, muted, danger) = (theme.background, theme.border, theme.muted_foreground, theme.danger);
        let transcript = self.transcript.clone();
        let current = self.session.as_ref().map(|session| session.id().to_owned());
        let title = current
            .as_deref()
            .and_then(|id| self.sessions.iter().find(|row| row.id == id))
            .map_or_else(|| "New session".to_owned(), session_title);

        let header = h_flex()
            .h(px(44.))
            .px_5()
            .gap_2()
            .border_b_1()
            .border_color(border)
            .child(div().flex_shrink_0().max_w(px(360.)).font_weight(FontWeight::MEDIUM).truncate().child(title))
            .when(self.connection.is_some(), |header| header.child(div().text_sm().text_color(muted).truncate().child(tidy_path(&self.folder()))))
            .child(div().flex_1())
            .when(self.running(), |header| header.child(h_flex().gap_2().text_sm().text_color(muted).child(Spinner::new().xsmall()).child("Working")));

        let conversation = if self.transcript.read(cx).is_empty() {
            div().flex_1().min_h_0().child(self.render_empty(cx)).into_any_element()
        } else {
            let earlier = self.older.is_some().then(|| {
                h_flex().absolute().top_2().w_full().justify_center().child(
                    Button::new("older")
                        .small()
                        .rounded(ButtonRounded::Size(px(14.)))
                        .icon(IconName::ArrowUp)
                        .label(if self.loading_older { "Loading…" } else { "Load earlier messages" })
                        .loading(self.loading_older)
                        .on_click(cx.listener(|this, _, _, cx| this.load_older(cx))),
                )
            });
            div()
                .relative()
                .flex_1()
                .min_h_0()
                .child(MessageScroller::new("transcript", self.scroller.clone(), move |index, _, cx| Self::render_row(&transcript, index, cx)))
                .children(earlier)
                .into_any_element()
        };

        let failure = self.error.clone().map(|error| {
            h_flex().w_full().justify_center().px_6().child(
                h_flex()
                    .w_full()
                    .max_w(px(COLUMN))
                    .gap_3()
                    .px_4()
                    .py_2()
                    .rounded_lg()
                    .bg(danger.opacity(0.08))
                    .text_sm()
                    .text_color(danger)
                    .child(Icon::new(IconName::CircleAlert).small())
                    .child(div().flex_1().child(error))
                    .when(self.lost, |bar| {
                        bar.child(Button::new("reconnect").label("Reconnect now").on_click(cx.listener(|this, _, _, cx| this.reconnect(cx))))
                    }),
            )
        });

        h_flex()
            .size_full()
            .bg(background)
            .child(self.render_sidebar(cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(header)
                    .child(conversation)
                    .children(failure)
                    .child(self.render_composer(cx)),
            )
    }
}
