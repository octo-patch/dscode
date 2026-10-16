//! DSCODE desktop client (spike). Connects to a runtime, opens a new session
//! and chats with it.
//!
//!     dscode-desktop [--runtime NAME] [--dscode PATH] [--cwd DIR] [--session ID]
//!     dscode-desktop --socket PATH [--cwd DIR]
//!     dscode-desktop --url http://host:port --token TOKEN [--cwd DIR]
//!
//! Without an address it attaches to the default runtime of `runtimes.json`,
//! shared with `dscode config`: `local` starts or attaches to this machine's
//! Host through the `dscode` launcher (`--dscode`, `$DSCODE_CLI` or PATH). The
//! window's runtime menu switches between them and adds servers.
//! DSCODE_RUNTIME_SOCKET, or DSCODE_RUNTIME_URL and DSCODE_RUNTIME_TOKEN, act
//! as the address flags, as for the terminal client.

mod chat;
mod runtime;
mod transcript;

use chat::{ChatView, Startup};
use dscode_client_core::Target;
use gpui_kit::*;
use runtime::Choice;
use std::env;
use std::process::ExitCode;

fn startup_from_args() -> Result<Startup, String> {
    let mut args = env::args().skip(1);
    let (mut socket, mut url, mut token) = (env::var("DSCODE_RUNTIME_SOCKET").ok(), env::var("DSCODE_RUNTIME_URL").ok(), env::var("DSCODE_RUNTIME_TOKEN").unwrap_or_default());
    let (mut runtime, mut cwd, mut launcher, mut session) = (None, None, None, None);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--socket" => (socket, url) = (Some(value()?), None),
            "--url" => url = Some(value()?),
            "--token" => token = value()?,
            "--runtime" => runtime = Some(value()?),
            "--dscode" => launcher = Some(value()?.into()),
            "--cwd" => cwd = Some(value()?),
            "--session" => session = Some(value()?),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let choice = match (runtime, url, socket) {
        (Some(name), _, _) => Some(Choice::Named(name)),
        (None, Some(url), _) => Some(Choice::Direct(Target::remote(&url, token).map_err(|e| e.to_string())?)),
        #[cfg(unix)]
        (None, None, Some(socket)) => Some(Choice::Direct(Target::Socket(socket.into()))),
        _ => None,
    };
    Ok(Startup { choice, cwd, launcher, session })
}

fn main() -> ExitCode {
    let startup = match startup_from_args() {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("dscode-desktop: {error}");
            return ExitCode::from(2);
        }
    };
    gpui_kit::application().with_assets(gpui_kit::assets::AllAssets).run(move |cx| {
        gpui_kit::init(cx);
        let bounds = Bounds::centered(None, size(px(1180.), px(800.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("DSCODE".into()), ..Default::default() }),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| ChatView::new(startup, window, cx)))
            .expect("failed to open the window");
        cx.on_window_closed(|cx, _| cx.quit()).detach();
        cx.activate(true);
    });
    ExitCode::SUCCESS
}
