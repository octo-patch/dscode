//! Named runtimes, shared with the terminal through `runtimes.json` in the state
//! directory (`scripts/runtimes.mjs`, docs/remote-runtime.md): `local` is this
//! machine's Host, every other alias a `dscode server` with its token. Fields
//! this client does not know are kept when it writes the file back.

use crate::error::{Error, Result};
use crate::launcher::Launcher;
use crate::target::Target;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// This machine's background Host. Reserved; never an entry in the file.
pub const LOCAL: &str = "local";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Remote {
    pub url: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

impl Remote {
    pub fn target(&self) -> Result<Target> {
        Target::remote(&self.url, self.token.clone())
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    runtimes: BTreeMap<String, Remote>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// The runtimes file of one state directory.
#[derive(Clone, Debug)]
pub struct Runtimes {
    path: PathBuf,
    file: File,
}

impl Runtimes {
    /// Read `path`; a missing file is the default configuration (just `local`).
    pub fn load(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let file = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|error| Error::config(format!("{} is not valid ({error}); fix or remove it", path.display())))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => File::default(),
            Err(error) => return Err(error.into()),
        };
        Ok(Runtimes { path, file })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The alias bare `dscode` attaches to.
    pub fn default_alias(&self) -> &str {
        self.file.default.as_deref().unwrap_or(LOCAL)
    }

    /// `local` first, then the configured remotes by name.
    pub fn aliases(&self) -> Vec<String> {
        std::iter::once(LOCAL.to_owned()).chain(self.file.runtimes.keys().cloned()).collect()
    }

    pub fn remote(&self, alias: &str) -> Option<&Remote> {
        self.file.runtimes.get(alias)
    }

    /// The address of runtime `alias`, as `resolveRuntime` in scripts/runtimes.mjs,
    /// and the folder its entry names. `local` asks the launcher to attach to
    /// this machine's Host or start one, which can take a while.
    pub fn resolve(&self, alias: &str, launcher: Option<&Launcher>) -> Result<(Target, Option<String>)> {
        if alias == LOCAL {
            let launcher = launcher.ok_or_else(|| Error::config("the local runtime needs the dscode launcher, which was not found"))?;
            #[cfg(unix)]
            return Ok((Target::Socket(launcher.ensure_host()?.socket), None));
            #[cfg(not(unix))]
            return Err(Error::config(format!("{} cannot run a local runtime on this system; add a server", launcher.program().display())));
        }
        let remote = self.remote(alias).ok_or_else(|| Error::config(format!("no runtime named {alias}")))?;
        Ok((remote.target()?, remote.cwd.clone()))
    }

    /// Add or replace a remote, as `dscode config --runtime ADDRESS --token TOKEN --alias NAME`.
    pub fn set_remote(&mut self, alias: &str, address: &str, token: &str, cwd: Option<&str>) -> Result<()> {
        check_alias(alias)?;
        let token = token.trim();
        if token.is_empty() {
            return Err(Error::config("a server needs its token (printed by `dscode server`)"));
        }
        if let Some(cwd) = cwd.filter(|cwd| !cwd.starts_with('/')) {
            return Err(Error::config(format!("the folder must be an absolute path on the server, not {cwd}")));
        }
        let url = runtime_url(address)?;
        let extra = self.file.runtimes.get(alias).map(|old| old.extra.clone()).unwrap_or_default();
        self.file.runtimes.insert(alias.to_owned(), Remote { url, token: token.to_owned(), cwd: cwd.map(str::to_owned), extra });
        Ok(())
    }

    pub fn remove(&mut self, alias: &str) -> Result<()> {
        self.file.runtimes.remove(alias).ok_or_else(|| Error::config(format!("no runtime named {alias}")))?;
        if self.file.default.as_deref() == Some(alias) {
            self.file.default = Some(LOCAL.to_owned());
        }
        Ok(())
    }

    pub fn set_default(&mut self, alias: &str) -> Result<()> {
        if alias != LOCAL && !self.file.runtimes.contains_key(alias) {
            return Err(Error::config(format!("no runtime named {alias}")));
        }
        self.file.default = Some(alias.to_owned());
        Ok(())
    }

    /// Write the file back: owner-only, since it holds tokens, and replaced
    /// atomically so a terminal never reads half of it.
    pub fn save(&self) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut file = self.file.clone();
        file.default.get_or_insert_with(|| LOCAL.to_owned());
        let mut text = serde_json::to_string_pretty(&file).expect("the runtimes file serializes");
        text.push('\n');
        let staged = self.path.with_extension(format!("json.{}.tmp", std::process::id()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut out = options.open(&staged)?;
        out.write_all(text.as_bytes())?;
        out.sync_all()?;
        fs::rename(&staged, &self.path)?;
        Ok(())
    }
}

fn check_alias(alias: &str) -> Result<()> {
    let valid_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
    let ok = alias.len() <= 64 && alias.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && alias.chars().all(valid_char);
    if !ok {
        return Err(Error::config("a name is letters, digits, \".\", \"_\" or \"-\" (at most 64), starting with a letter or digit"));
    }
    if alias.eq_ignore_ascii_case(LOCAL) {
        return Err(Error::config(format!("\"{LOCAL}\" is reserved for this machine's runtime")));
    }
    Ok(())
}

/// `host:port` or `http://host:port` → `http://host:port`, as `runtimeUrl` in scripts/runtimes.mjs.
pub fn runtime_url(address: &str) -> Result<String> {
    let address = address.trim();
    let authority = match address.split_once("://") {
        Some(("http", rest)) => rest,
        Some(_) => return Err(Error::config(format!("\"{address}\": only plain http://HOST:PORT is supported"))),
        None => address,
    };
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if authority.contains(['/', '?', '#', '@']) {
        return Err(Error::config(format!("\"{address}\" must be just HOST:PORT")));
    }
    let has_port = authority.rsplit_once(':').is_some_and(|(host, port)| !host.is_empty() && !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()));
    if !has_port {
        return Err(Error::config(format!("\"{address}\" needs a port (HOST:PORT)")));
    }
    let url = format!("http://{authority}");
    Target::remote(&url, "")?;
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dscode-runtimes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("runtimes.json")
    }

    #[test]
    fn normalizes_addresses() {
        assert_eq!(runtime_url("box:7700").unwrap(), "http://box:7700");
        assert_eq!(runtime_url("http://10.0.0.2:80/").unwrap(), "http://10.0.0.2:80");
        assert_eq!(runtime_url("[::1]:9000").unwrap(), "http://[::1]:9000");
        for bad in ["box", "https://box:1", "box:7700/x", "user@box:1", "box:port"] {
            assert!(runtime_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn missing_file_is_local_only() {
        let runtimes = Runtimes::load(scratch("missing")).unwrap();
        assert_eq!(runtimes.default_alias(), LOCAL);
        assert_eq!(runtimes.aliases(), vec![LOCAL]);
    }

    #[test]
    fn round_trips_and_keeps_unknown_fields() {
        let path = scratch("round-trip");
        fs::write(&path, r#"{"default":"box","runtimes":{"box":{"url":"http://box:1","token":"t","note":"kept"}},"future":1}"#).unwrap();
        let mut runtimes = Runtimes::load(&path).unwrap();
        assert_eq!(runtimes.default_alias(), "box");
        runtimes.set_remote("lab", "lab:7700", " dsk_x ", Some("/srv")).unwrap();
        assert!(runtimes.set_remote("Local", "x:1", "t", None).is_err());
        assert!(runtimes.set_remote("lab", "x:1", "t", Some("rel")).is_err());
        runtimes.save().unwrap();

        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["future"], 1);
        assert_eq!(saved["runtimes"]["box"]["note"], "kept");
        assert_eq!(saved["runtimes"]["lab"], serde_json::json!({"url": "http://lab:7700", "token": "dsk_x", "cwd": "/srv"}));
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&path).unwrap().permissions()) & 0o777, 0o600);

        let mut runtimes = Runtimes::load(&path).unwrap();
        assert_eq!(runtimes.aliases(), vec![LOCAL, "box", "lab"]);
        runtimes.remove("box").unwrap();
        assert_eq!(runtimes.default_alias(), LOCAL);
        assert!(runtimes.set_default("gone").is_err());
    }
}
