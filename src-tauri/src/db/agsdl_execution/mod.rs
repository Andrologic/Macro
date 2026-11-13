pub(crate) mod approvals;
pub(crate) mod diagnostics;
pub(crate) mod discovery;
// Shared transactional primitives for the native 0.3 repositories.
// Native flow authorities own admission and epochs.
pub(crate) mod call_protocol030;
pub(crate) mod card_associations;
pub(crate) mod discovery030;
pub mod dto;
#[path = "v030/flow.rs"]
pub(crate) mod flow030;
pub(crate) mod flow_store030;
pub(crate) mod flow_work_protocol030;
pub(crate) mod intents;
pub(crate) mod json_lexemes030;
pub(crate) mod public;
pub(crate) mod public030;
#[path = "v030/replay_verify030.rs"]
pub(crate) mod replay_verify030;
#[path = "v030/runtime_projection.rs"]
pub(crate) mod runtime_projection030;
pub(crate) mod start030;
pub(crate) mod work_dto030;
use argentic_runtime::persistence::dto::*;
use argentic_runtime::persistence::{decimal, durable, encode, next, opaque, order, require};
pub(crate) use argentic_runtime::persistence::{failure, validate_json, Result};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, Sqlite, SqliteConnection, SqlitePool, Transaction};
use std::collections::BTreeMap;
