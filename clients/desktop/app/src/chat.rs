use crate::runtime::{self, Live, RuntimeEvent, Session};
use crate::transcript::{Role, Transcript};
use dscode_client_core::protocol::types;
use dscode_client_core::Target;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

struct Approval {
    event_id: String,
    tool: String,
    reason: String,
}

pub struct ChatView {
    transcript: Entity<Transcript>,
    scroller: Entity<MessageScrollerState>,
    input: Entity<TextareaState>,
    session: Option<Session>,
    events: flume::Sender<RuntimeEvent>,
    status: SharedString,
    error: Option<SharedString>,
    running: bool,
    approvals: Vec<Approval>,
}

impl ChatView {
    pub fn new(target: Target, cwd: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let transcript = cx.new(|_| Transcript::default());
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Message DSCODE — Enter to send, Shift-Enter for a new line")
                .auto_grow(1, 8)
                .submit_on_enter(true)
        });
        cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { shift: false, .. } = event {
                this.send(window, cx);
            }
        })
        .detach();

        let (events, rx) = flume::unbounded();
        cx.spawn(async move |this, cx| {
            while let Ok(event) = rx.recv_async().await {
                if this.update(cx, |view, cx| view.apply(event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        let status = format!("Connecting to {target}…").into();
        runtime::connect(target, cwd, events.clone());
        input.update(cx, |input, cx| input.focus(window, cx));

        ChatView { transcript, scroller, input, session: None, events, status, error: None, running: false, approvals: Vec::new() }
    }

    fn apply(&mut self, event: RuntimeEvent, cx: &mut Context<Self>) {
        let before = self.transcript.read(cx).len();
        match event {
            RuntimeEvent::Connected { label, version, cwd, session } => {
                self.status = format!("{label} · DSCODE {version} · {cwd}").into();
                self.session = Some(session);
            }
            RuntimeEvent::Failed(message) => self.error = Some(message.into()),
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
            RuntimeEvent::Approval { event_id, payload } => {
                // Prefer the Chinese wording when the asker provided one.
                let shown = payload.display_reason.map(|reason| reason.extra.get("zh").cloned().unwrap_or(reason.en));
                let reason = shown.or(payload.reason).unwrap_or_default();
                self.approvals.push(Approval { event_id, tool: payload.tool_name, reason })
            }
            RuntimeEvent::Withdrawn(event_id) => self.approvals.retain(|a| a.event_id != event_id),
            RuntimeEvent::Running(running) => self.running = running,
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
        let Some(session) = &self.session else { return };
        if text.is_empty() {
            return;
        }
        session.deliver(text, self.events.clone());
        self.input.update(cx, |input, cx| input.set_value("", window, cx));
    }

    fn answer(&mut self, allow: bool, cx: &mut Context<Self>) {
        if self.approvals.is_empty() {
            return;
        }
        let approval = self.approvals.remove(0);
        if let Some(session) = &self.session {
            let decision = if allow { types::ApprovalOutcome::AllowedOnce } else { types::ApprovalOutcome::Rejected };
            session.answer(approval.event_id, decision, self.events.clone());
        }
        cx.notify();
    }

    fn render_row(transcript: &Entity<Transcript>, index: usize, cx: &mut App) -> AnyElement {
        let theme = cx.theme();
        let (muted, secondary, danger) = (theme.muted_foreground, theme.secondary, theme.danger);
        let (role, text, failed) = transcript.read(cx).row(index);
        let text = text.to_owned();
        let row = div().w_full().px_6().py_2();
        match role {
            Role::User => row
                .child(h_flex().justify_end().child(div().max_w(relative(0.8)).rounded_lg().bg(secondary).px_4().py_2().child(text)))
                .into_any_element(),
            Role::Assistant if text.is_empty() => row.text_color(muted).child("…").into_any_element(),
            Role::Assistant => row.child(TextView::markdown(("message", index), text)).into_any_element(),
            Role::Tool => row
                .text_sm()
                .font_family("Menlo")
                .text_color(if failed { danger } else { muted })
                .child(format!("▸ {text}"))
                .into_any_element(),
        }
    }
}

impl Render for ChatView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (background, border, muted, warning, danger) = (theme.background, theme.border, theme.muted_foreground, theme.warning, theme.danger);
        let transcript = self.transcript.clone();

        let header = h_flex()
            .px_4()
            .py_2()
            .gap_2()
            .border_b_1()
            .border_color(border)
            .text_sm()
            .text_color(muted)
            .child(div().flex_1().truncate().child(self.status.clone()))
            .when(self.running, |header| header.child("working…"));

        let approval = self.approvals.first().map(|approval| {
            h_flex()
                .px_4()
                .py_3()
                .gap_3()
                .border_t_1()
                .border_color(warning)
                .child(
                    v_flex()
                        .flex_1()
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(format!("Approve {}?", approval.tool)))
                        .child(div().text_sm().text_color(muted).child(approval.reason.clone())),
                )
                .child(Button::new("reject").label("Reject").on_click(cx.listener(|this, _, _, cx| this.answer(false, cx))))
                .child(Button::new("allow").primary().label("Allow once").on_click(cx.listener(|this, _, _, cx| this.answer(true, cx))))
        });

        let composer = h_flex()
            .p_3()
            .gap_2()
            .items_end()
            .border_t_1()
            .border_color(border)
            .child(div().flex_1().child(Textarea::new(&self.input)))
            .child(if self.running {
                Button::new("stop").label("Stop").on_click(cx.listener(|this, _, _, cx| {
                    if let Some(session) = &this.session {
                        session.interrupt(this.events.clone());
                    }
                    cx.notify();
                }))
            } else {
                Button::new("send").primary().label("Send").on_click(cx.listener(|this, _, window, cx| this.send(window, cx)))
            });

        v_flex()
            .size_full()
            .bg(background)
            .child(header)
            .child(
                div().flex_1().min_h_0().child(MessageScroller::new("transcript", self.scroller.clone(), move |index, _, cx| {
                    Self::render_row(&transcript, index, cx)
                })),
            )
            .when_some(self.error.clone(), |view, error| view.child(div().px_4().py_2().text_sm().text_color(danger).child(error)))
            .children(approval)
            .child(composer)
    }
}
