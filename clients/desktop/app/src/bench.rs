//! Frame timing for performance checks, printed to stderr.
//!
//! `DSCODE_DESKTOP_FRAMES=1` times every frame of the window from the start
//! of `ChatView::render` to the end of paint (build, layout, prepaint and
//! paint; not GPU time) and prints a summary every two seconds of activity.
//! The window then floats above the others without taking focus, since a
//! covered window presents no frames.
//! `DSCODE_DESKTOP_SCROLL_BENCH=1` also scrolls through the opened session,
//! one row per frame from the last row to the first and back, and prints the
//! summary of that pass, then quits.

use gpui_kit::*;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Frames(Rc<RefCell<Samples>>);

struct Samples {
    times: Vec<Duration>,
    since: Instant,
    /// No summary every two seconds: a pass reports its own.
    held: bool,
}

impl Frames {
    pub fn from_env() -> Option<Frames> {
        std::env::var_os("DSCODE_DESKTOP_FRAMES").map(|_| Frames(Rc::new(RefCell::new(Samples { times: Vec::new(), since: Instant::now(), held: false }))))
    }

    /// An invisible element, painted last, that records the frame begun at `start`.
    pub fn probe(&self, start: Instant) -> impl IntoElement {
        let frames = self.clone();
        canvas(|_, _, _| {}, move |_, _, _, _| frames.record(start.elapsed())).absolute().size_full()
    }

    fn record(&self, time: Duration) {
        let mut samples = self.0.borrow_mut();
        if samples.times.is_empty() {
            samples.since = Instant::now();
        }
        samples.times.push(time);
        if !samples.held && samples.since.elapsed() >= Duration::from_secs(2) {
            drop(samples);
            self.report("frames");
        }
    }

    /// Start a pass: what came before it is reported on its own.
    pub fn hold(&self) {
        if !std::mem::replace(&mut self.0.borrow_mut().held, true) {
            self.report("before the pass");
        }
    }

    /// Print and clear what was recorded.
    pub fn report(&self, label: &str) {
        let mut times = std::mem::take(&mut self.0.borrow_mut().times);
        if times.is_empty() {
            return;
        }
        times.sort();
        let ms = |d: Duration| d.as_secs_f64() * 1000.;
        let at = |q: f64| ms(times[((times.len() - 1) as f64 * q).round() as usize]);
        let over = |limit: f64| times.iter().filter(|t| ms(**t) > limit).count();
        eprintln!(
            "dscode-desktop {label}: {} frames, p50 {:.1} ms, p95 {:.1} ms, max {:.1} ms, over 16 ms {}, over 33 ms {}",
            times.len(),
            at(0.5),
            at(0.95),
            at(1.0),
            over(16.7),
            over(33.3),
        );
    }
}

/// The scroll pass of `DSCODE_DESKTOP_SCROLL_BENCH`.
pub struct ScrollBench {
    /// The row to show next; `None` before the session's rows arrive.
    next: Option<usize>,
    upward: bool,
    pub done: bool,
}

impl ScrollBench {
    pub fn from_env() -> Option<ScrollBench> {
        std::env::var_os("DSCODE_DESKTOP_SCROLL_BENCH").map(|_| ScrollBench { next: None, upward: true, done: false })
    }

    /// The row to scroll to in this frame, or `None` when the pass is over.
    pub fn step(&mut self, rows: usize) -> Option<usize> {
        if self.done || rows == 0 {
            return None;
        }
        let row = *self.next.get_or_insert(rows - 1);
        match (self.upward, row) {
            (true, 0) => self.upward = false,
            (true, _) => self.next = Some(row - 1),
            (false, row) if row + 1 >= rows => self.done = true,
            (false, _) => self.next = Some(row + 1),
        }
        Some(row)
    }
}
