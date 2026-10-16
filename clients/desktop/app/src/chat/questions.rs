//! The question card: `ask_user_question` and plan reviews (`exit_plan_mode`,
//! a question with a `plan-review` intent), answered above the composer. Every
//! question of a request shows at once; requests queue and show one at a time.
//!
//! A request with one single-choice question is answered by picking an
//! option. Otherwise options are picked (or toggled, for multi-select) and
//! Submit sends every answer; Submit waits until each question has a pick
//! or an "Other" answer. For a single-choice question an "Other" answer
//! replaces the picked option; for a plan review that is how feedback is
//! given (the plan is not approved). Dismiss cancels the request
//! (`ASK_CANCELLED`, as the web client sends).

use super::{ChatView, COLUMN};
use dscode_client_core::protocol::{typert, types};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

pub(super) struct Question {
    pub event_id: String,
    items: Vec<types::AskUserQuestionItem>,
    /// Per question, the picked options.
    picked: Vec<Vec<usize>>,
    /// Per question, the "Other" answer box; made on the first render, since an input needs the window.
    custom: Vec<Option<Entity<InputState>>>,
}

impl Question {
    pub fn new(event_id: String, payload: types::UserQuestionsRequestPayload) -> Self {
        let count = payload.questions.len();
        Question { event_id, items: payload.questions, picked: vec![Vec::new(); count], custom: vec![None; count] }
    }

    fn multi(item: &types::AskUserQuestionItem) -> bool {
        item.multi_select.unwrap_or(false)
    }

    /// One single-choice question with options: picking is answering.
    fn picks_answer(&self) -> bool {
        matches!(self.items.as_slice(), [item] if !Self::multi(item) && !item.options.is_empty())
    }

    fn custom_text(&self, index: usize, cx: &App) -> String {
        self.custom[index].as_ref().map(|input| input.read(cx).value().trim().to_owned()).unwrap_or_default()
    }

    fn customs(&self, cx: &App) -> Vec<String> {
        (0..self.items.len()).map(|index| self.custom_text(index, cx)).collect()
    }

    fn complete(&self, cx: &App) -> bool {
        complete(&self.picked, &self.customs(cx))
    }

    fn answer(&self, cx: &App) -> types::AskUserQuestionAnswer {
        answer(&self.items, &self.picked, &self.customs(cx))
    }
}

/// Whether every question has a pick or an "Other" answer.
fn complete(picked: &[Vec<usize>], customs: &[String]) -> bool {
    picked.iter().zip(customs).all(|(picked, custom)| !picked.is_empty() || !custom.is_empty())
}

/// The answer to send: per question the picked labels and the "Other" text,
/// which for a single-choice question replaces the pick.
fn answer(items: &[types::AskUserQuestionItem], picked: &[Vec<usize>], customs: &[String]) -> types::AskUserQuestionAnswer {
    let answers = items
        .iter()
        .zip(picked.iter().zip(customs))
        .map(|(item, (picked, custom))| {
            let custom = Some(custom.clone()).filter(|text| !text.is_empty());
            let selected = if custom.is_some() && !Question::multi(item) {
                Vec::new()
            } else {
                picked.iter().filter_map(|&at| item.options.get(at)).map(|option| option.label.clone()).collect()
            };
            types::AskUserQuestionAnswerItem { id: item.id.clone(), selected, custom }
        })
        .collect();
    types::AskUserQuestionAnswer { answers }
}

impl ChatView {
    /// Give the shown request's questions their "Other" boxes.
    pub(super) fn prepare_question(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(question) = self.questions.first_mut() else { return };
        for index in 0..question.items.len() {
            if question.custom[index].is_some() {
                continue;
            }
            let item = &question.items[index];
            let placeholder = match (item.intent.is_some(), item.options.is_empty()) {
                (true, _) => "Feedback instead (keeps planning)",
                (false, true) => "Your answer",
                (false, false) => "Other answer (optional)",
            };
            let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
            cx.subscribe_in(&input, window, |this, _, event: &InputEvent, _, cx| match event {
                InputEvent::PressEnter { .. } => this.submit_question(cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            })
            .detach();
            question.custom[index] = Some(input);
        }
    }

    fn pick_option(&mut self, index: usize, option: usize, cx: &mut Context<Self>) {
        let Some(question) = self.questions.first_mut() else { return };
        let picked = &mut question.picked[index];
        if Question::multi(&question.items[index]) {
            match picked.iter().position(|&at| at == option) {
                Some(at) => {
                    picked.remove(at);
                }
                None => picked.push(option),
            }
        } else {
            *picked = vec![option];
        }
        if question.picks_answer() && question.custom_text(0, cx).is_empty() {
            self.submit_question(cx);
        }
        cx.notify();
    }

    fn submit_question(&mut self, cx: &mut Context<Self>) {
        let Some(question) = self.questions.first() else { return };
        if !question.complete(cx) {
            return;
        }
        let answer = question.answer(cx);
        let question = self.questions.remove(0);
        if let Some(connection) = &self.connection {
            connection.answer::<typert::UserQuestionsRequest>(question.event_id, answer, self.connection_reporter());
        }
        cx.notify();
    }

    fn dismiss_question(&mut self, cx: &mut Context<Self>) {
        if self.questions.is_empty() {
            return;
        }
        let question = self.questions.remove(0);
        if let Some(connection) = &self.connection {
            connection.dismiss_question(question.event_id, self.connection_reporter());
        }
        cx.notify();
    }

    pub(super) fn render_question(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let question = self.questions.first()?;
        let theme = cx.theme();
        let (primary, muted, border, success) = (theme.primary, theme.muted_foreground, theme.border, theme.success);
        let plan = question.items.iter().any(|item| item.intent.is_some());
        let title = match (plan, self.questions.len()) {
            (true, _) => "Review the plan".to_owned(),
            (false, 1) => "DSCODE has a question".to_owned(),
            (false, queued) => format!("DSCODE has a question (1 of {queued})"),
        };

        let mut body = v_flex().gap_4();
        for (index, item) in question.items.iter().enumerate() {
            let multi = Question::multi(item);
            let approve = item.intent.as_ref().map(|intent| intent.approve.as_str());
            let mut options = v_flex().gap_1();
            for (at, option) in item.options.iter().enumerate() {
                let picked = question.picked[index].contains(&at);
                let mark = match (multi, picked) {
                    (true, true) => IconName::SquareCheck,
                    (true, false) => IconName::Square,
                    (false, true) => IconName::CircleDot,
                    (false, false) => IconName::Circle,
                };
                let approves = approve == Some(option.label.as_str());
                options = options.child(
                    Button::new(("question-option", index * 1000 + at))
                        .outline()
                        .w_full()
                        .selected(picked)
                        .when(picked, |button| button.border_color(primary))
                        .when(!multi, |button| button.role(Role::RadioButton))
                        .toggled(picked)
                        .accessibility_label(option.label.clone())
                        .child(
                            h_flex()
                                .w_full()
                                .py_1()
                                .gap_2()
                                .child(Icon::new(if approves { IconName::CircleCheck } else { mark }).small().when(approves, |icon| icon.text_color(success)))
                                .child(div().flex_shrink_0().font_weight(FontWeight::MEDIUM).child(option.label.clone()))
                                .when_some(option.description.clone(), |row, description| {
                                    row.child(div().flex_1().min_w_0().truncate().text_sm().text_color(muted).child(description))
                                }),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| this.pick_option(index, at, cx))),
                );
            }
            let detail = item.detail.clone().map(|detail| {
                if item.intent.is_some() {
                    // A plan: Markdown, scrolled within the card.
                    div()
                        .id(("question-plan", index))
                        .max_h(px(320.))
                        .overflow_y_scroll()
                        .px_3()
                        .py_2()
                        .rounded_lg()
                        .border_1()
                        .border_color(border)
                        .child(TextView::markdown(("question-detail", index), detail))
                        .into_any_element()
                } else {
                    div().text_sm().text_color(muted).child(detail).into_any_element()
                }
            });
            body = body.child(
                v_flex()
                    .gap_2()
                    .when_some(item.header.clone(), |col, header| col.child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(muted).child(header)))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(item.question.clone()))
                    .children(detail)
                    .when(!item.options.is_empty(), |col| col.child(options))
                    .children(question.custom[index].as_ref().map(|input| Input::new(input).small())),
            );
        }

        let submit = (!question.picks_answer()).then(|| {
            Button::new("question-submit").primary().label("Submit").disabled(!question.complete(cx)).on_click(cx.listener(|this, _, _, cx| this.submit_question(cx)))
        });
        let card = v_flex()
            .w_full()
            .max_w(px(COLUMN))
            .gap_3()
            .px_4()
            .py_3()
            .rounded_xl()
            .border_1()
            .border_color(primary.opacity(0.5))
            .bg(primary.opacity(0.04))
            .child(
                h_flex()
                    .gap_2()
                    .child(Icon::new(if plan { IconName::ClipboardList } else { IconName::MessageCircleQuestionMark }).text_color(primary))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(title)),
            )
            // A long request scrolls inside the card, so the composer stays in view.
            .child(div().id("question-body").max_h(px(480.)).overflow_y_scroll().child(body))
            .child(
                h_flex()
                    .gap_2()
                    .justify_end()
                    .child(Button::new("question-dismiss").ghost().label("Dismiss").on_click(cx.listener(|this, _, _, cx| this.dismiss_question(cx))))
                    .children(submit),
            );
        Some(card.into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::{answer, complete, types};
    use serde_json::json;

    fn items() -> Vec<types::AskUserQuestionItem> {
        serde_json::from_value(json!([
            {"id": "color", "question": "Color?", "options": [{"label": "Blue"}, {"label": "Red"}]},
            {"id": "checks", "question": "Checks?", "multiSelect": true, "options": [{"label": "Lint"}, {"label": "Unit"}, {"label": "集成"}]},
            {"id": "name", "question": "Branch?"},
            {"id": "plan", "question": "Approve?", "options": [{"label": "Approve"}, {"label": "Keep planning"}], "intent": {"kind": "plan-review", "approve": "Approve"}},
        ]))
        .unwrap()
    }

    #[test]
    fn answers_carry_picks_and_other_text() {
        let items = items();
        let picked = vec![vec![1], vec![0, 2], vec![], vec![0]];
        let customs = vec![String::new(), "also docs".into(), "feature/x".into(), String::new()];
        assert!(complete(&picked, &customs));
        let sent = serde_json::to_value(answer(&items, &picked, &customs)).unwrap();
        assert_eq!(sent, json!({"answers": [
            {"id": "color", "selected": ["Red"]},
            {"id": "checks", "selected": ["Lint", "集成"], "custom": "also docs"},
            {"id": "name", "selected": [], "custom": "feature/x"},
            {"id": "plan", "selected": ["Approve"]},
        ]}));
    }

    #[test]
    fn other_text_replaces_a_single_pick() {
        // A plan review with feedback is not approved: no label, the feedback as custom.
        let items = items();
        let picked = vec![vec![0], vec![], vec![], vec![0]];
        let customs = vec![String::new(), String::new(), String::new(), "split step 2".into()];
        assert!(!complete(&picked, &customs), "checks and name are unanswered");
        let sent = serde_json::to_value(answer(&items, &picked, &customs)).unwrap();
        assert_eq!(sent["answers"][3], json!({"id": "plan", "selected": [], "custom": "split step 2"}));
    }
}
