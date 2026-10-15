use crate::error::{Error, Result};
use std::fmt;
#[cfg(unix)]
use std::path::PathBuf;

/// Where a runtime is reached: the local Host's owner-only Unix socket, or a
/// `dscode server` over TCP with its bearer token.
#[derive(Clone, PartialEq, Eq)]
pub enum Target {
    #[cfg(unix)]
    Socket(PathBuf),
    Remote { host: String, port: u16, token: String },
}

impl Target {
    /// Parse `http://host:port` the way the launcher records it. The port is read
    /// from the address as typed, so an explicit `:80` is kept.
    pub fn remote(url: &str, token: impl Into<String>) -> Result<Self> {
        let rest = url
            .strip_prefix("http://")
            .ok_or_else(|| Error::protocol(format!("unsupported runtime address {url}; expected http://host:port")))?;
        let authority = rest.split('/').next().unwrap_or_default();
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) if !host.is_empty() && (!host.contains(':') || host.ends_with(']')) => {
                let port = port.parse().map_err(|_| Error::protocol(format!("invalid port in {url}")))?;
                (host, port)
            }
            _ => (authority, 80),
        };
        if host.is_empty() {
            return Err(Error::protocol(format!("missing host in {url}")));
        }
        Ok(Target::Remote { host: host.trim_start_matches('[').trim_end_matches(']').to_owned(), port, token: token.into() })
    }

    /// Whether the runtime shares this machine's filesystem. Over TCP it does not,
    /// so attachments travel as content.
    pub fn shares_filesystem(&self) -> bool {
        match self {
            #[cfg(unix)]
            Target::Socket(_) => true,
            Target::Remote { .. } => false,
        }
    }
}

/// Display form without the token.
impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(unix)]
            Target::Socket(path) => write!(f, "{}", path.display()),
            Target::Remote { host, port, .. } if host.contains(':') => write!(f, "[{host}]:{port}"),
            Target::Remote { host, port, .. } => write!(f, "{host}:{port}"),
        }
    }
}

impl fmt::Debug for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Target({self})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(target: Target) -> (String, u16) {
        match target {
            Target::Remote { host, port, .. } => (host, port),
            #[cfg(unix)]
            Target::Socket(_) => unreachable!(),
        }
    }

    #[test]
    fn parses_remote_addresses() {
        assert_eq!(parts(Target::remote("http://box:7700", "t").unwrap()), ("box".into(), 7700));
        assert_eq!(parts(Target::remote("http://box:80", "t").unwrap()), ("box".into(), 80));
        assert_eq!(parts(Target::remote("http://box", "t").unwrap()), ("box".into(), 80));
        assert_eq!(parts(Target::remote("http://[::1]:9000/", "t").unwrap()), ("::1".into(), 9000));
        assert!(Target::remote("https://box:1", "t").is_err());
        assert!(Target::remote("http://box:x", "t").is_err());
    }

    #[test]
    fn display_hides_the_token() {
        let target = Target::remote("http://box:7700", "dsk_secret").unwrap();
        assert_eq!(target.to_string(), "box:7700");
        assert!(!format!("{target:?}").contains("secret"));
    }
}
