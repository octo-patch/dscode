//! DSCODE desktop client (spike). Connects to a runtime, opens a new session
//! and chats with it.
//!
//!     dscode-desktop --socket PATH [--cwd DIR]
//!     dscode-desktop --url http://host:port --token TOKEN [--cwd DIR]
//!
//! Without flags it uses DSCODE_RUNTIME_SOCKET, or DSCODE_RUNTIME_URL and
//! DSCODE_RUNTIME_TOKEN, as the terminal client does.

mod chat;
mod runtime;
mod transcript;

use chat::ChatView;
use dscode_client_core::Target;
use gpui_kit::*;
use std::env;
use std::process::ExitCode;

fn target_from_args() -> Result<(Target, Option<String>), String> {
    let mut args = env::args().skip(1);
    let (mut socket, mut url, mut token, mut cwd) = (env::var("DSCODE_RUNTIME_SOCKET").ok(), env::var("DSCODE_RUNTIME_URL").ok(), env::var("DSCODE_RUNTIME_TOKEN").unwrap_or_default(), None);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--socket" => (socket, url) = (Some(value()?), None),
            "--url" => url = Some(value()?),
            "--token" => token = value()?,
            "--cwd" => cwd = Some(value()?),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let target = match (url, socket) {
        (Some(url), _) => Target::remote(&url, token).map_err(|e| e.to_string())?,
        #[cfg(unix)]
        (None, Some(socket)) => Target::Socket(socket.into()),
        _ => return Err("pass --socket PATH or --url URL --token TOKEN".into()),
    };
    Ok((target, cwd))
}

fn main() -> ExitCode {
    let (target, cwd) = match target_from_args() {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("dscode-desktop: {error}");
            return ExitCode::from(2);
        }
    };
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let bounds = Bounds::centered(None, size(px(920.), px(760.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("DSCODE".into()), ..Default::default() }),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| ChatView::new(target, cwd, window, cx)))
            .expect("failed to open the window");
        cx.on_window_closed(|cx, _| cx.quit()).detach();
        cx.activate(true);
    });
    ExitCode::SUCCESS
}
