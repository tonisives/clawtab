//! Durable local requests and the daemon's notification surface.
mod alerts;
pub mod cli;
pub mod native;
mod service;
pub mod settings;
mod store;
pub mod templates;
pub mod types;

pub(crate) use service::resolve_source;
pub use service::{initialize, service, viewed_pane, Service};
pub use types::*;
