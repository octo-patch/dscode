use std::fmt;
use std::io;

/// A failure talking to a DSCODE runtime.
#[derive(Debug)]
pub enum Error {
    /// The connection could not be made or broke.
    Io(io::Error),
    /// The runtime answered with something that does not follow the protocol.
    Protocol(String),
    /// The runtime refused the operation with a stable code (`dscode/*` or an
    /// upstream `RemoteFailure` code). These are the operation's own failures and
    /// are never retried.
    Remote { code: String, message: String },
    /// A local setting, file or the `dscode` launcher is wrong or missing.
    Config(String),
}

impl Error {
    pub(crate) fn protocol(message: impl Into<String>) -> Self {
        Error::Protocol(message.into())
    }

    pub(crate) fn config(message: impl Into<String>) -> Self {
        Error::Config(message.into())
    }

    /// Parse an `{code, message}` failure object.
    pub(crate) fn remote(value: &serde_json::Value) -> Self {
        let field = |name: &str| value.get(name).and_then(|v| v.as_str()).map(str::to_owned);
        Error::Remote {
            code: field("code").unwrap_or_else(|| "dscode/internal".into()),
            message: field("message").or_else(|| field("code")).unwrap_or_else(|| "remote failure".into()),
        }
    }

    /// The remote failure code, if the runtime refused the operation.
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Remote { code, .. } => Some(code),
            _ => None,
        }
    }

    /// Whether reconnecting may help: connection failures are retried, refusals are not.
    pub fn is_transient(&self) -> bool {
        matches!(self, Error::Io(_))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(error) => write!(f, "connection failed: {error}"),
            Error::Protocol(message) => write!(f, "protocol error: {message}"),
            Error::Remote { code, message } => write!(f, "{message} ({code})"),
            Error::Config(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error::Io(error)
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
