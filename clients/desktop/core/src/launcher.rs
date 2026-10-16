//! The local runtime through the `dscode` launcher. The launcher owns the state
//! directory, the Host socket and the decision whether a running Host can be
//! attached, replaced or must be refused (`ensureHost` in scripts/host.mjs), so
//! this client asks it rather than re-deriving any of that:
//! `dscode host locate` and `dscode host start --json`.

use crate::error::{Error, Result};
use crate::protocol::Protocol;
use serde::Deserialize;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where an installation keeps its state, as `location()` in scripts/host.mjs prints it.
#[derive(Clone, Debug, Deserialize)]
pub struct Location {
    pub home: PathBuf,
    /// The Host socket; after `ensure_host` a Host answers on it.
    pub socket: PathBuf,
    /// The shared `runtimes.json`.
    pub runtimes: PathBuf,
    /// The launcher's DSCODE release and protocol.
    pub version: String,
    pub protocol: Protocol,
}

#[derive(Clone, Debug)]
pub struct Launcher {
    program: PathBuf,
}

impl Launcher {
    /// `explicit`, else `$DSCODE_CLI`, else `dscode` on the search path. An app
    /// started from the Dock or Finder gets a minimal PATH, so the usual install
    /// folders are searched too.
    pub fn find(explicit: Option<&Path>) -> Result<Self> {
        if let Some(program) = explicit.map(Path::to_path_buf).or_else(|| env::var_os("DSCODE_CLI").map(PathBuf::from)) {
            return if program.is_file() {
                Ok(Launcher { program })
            } else {
                Err(Error::config(format!("the dscode launcher {} does not exist", program.display())))
            };
        }
        env::split_paths(&search_path())
            .map(|dir| dir.join("dscode"))
            .find(|candidate| candidate.is_file())
            .map(|program| Launcher { program })
            .ok_or_else(|| Error::config("dscode is not installed (not found on PATH or in ~/.local/bin); install it or pass --dscode PATH"))
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Where the state lives, without starting anything.
    pub fn locate(&self) -> Result<Location> {
        self.run(&["host", "locate"])
    }

    /// Attach to the running Host or start one, waiting until it answers (up to
    /// the launcher's 90 seconds).
    pub fn ensure_host(&self) -> Result<Location> {
        self.run(&["host", "start", "--json"])
    }

    fn run(&self, args: &[&str]) -> Result<Location> {
        let shown = format!("{} {}", self.program.display(), args.join(" "));
        let output = Command::new(&self.program)
            .args(args)
            .env("PATH", search_path())
            .output()
            .map_err(|error| Error::config(format!("could not run {shown}: {error}")))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            let detail = stderr.trim();
            if detail.starts_with("Usage: dscode host") {
                return Err(Error::config(format!("{} is too old for the desktop client (no `host locate`); update DSCODE", self.program.display())));
            }
            return Err(Error::config(format!("{shown} failed: {}", if detail.is_empty() { stdout.trim() } else { detail })));
        }
        parse_location(&stdout).ok_or_else(|| Error::config(format!("{shown} printed no location: {}", stdout.trim())))
    }
}

/// The last line that is a location; the launcher may print notices before it.
fn parse_location(stdout: &str) -> Option<Location> {
    stdout.lines().rev().find_map(|line| serde_json::from_str(line.trim()).ok())
}

/// PATH plus the folders `dscode` and `node` are usually installed in.
fn search_path() -> OsString {
    let mut dirs: Vec<PathBuf> = env::var_os("PATH").map(|path| env::split_paths(&path).collect()).unwrap_or_default();
    let home = env::var_os("HOME").map(PathBuf::from);
    let extra = [home.map(|home| home.join(".local/bin")), Some("/opt/homebrew/bin".into()), Some("/usr/local/bin".into())];
    for dir in extra.into_iter().flatten() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    env::join_paths(dirs).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_last_location_line() {
        let out = "update available\n{\"home\":\"/h\",\"socket\":\"/tmp/s/host.sock\",\"runtimes\":\"/h/runtimes.json\",\"version\":\"0.7.49\",\"protocol\":{\"major\":1,\"minor\":0}}\n";
        let location = parse_location(out).unwrap();
        assert_eq!(location.socket, PathBuf::from("/tmp/s/host.sock"));
        assert_eq!(location.protocol, Protocol { major: 1, minor: 0 });
        assert!(parse_location("DSCODE Host ready: /tmp/s/host.sock\n").is_none());
    }

    #[test]
    fn an_explicit_launcher_must_exist() {
        assert!(Launcher::find(Some(Path::new("/nonexistent/dscode"))).is_err());
    }
}
