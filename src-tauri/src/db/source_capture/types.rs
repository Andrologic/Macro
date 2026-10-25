use super::version::Version;
use crate::db::models::ConversationContentToken;
use serde::{Deserialize, Serialize};
pub(super) const JOURNAL: i64 = 216;
pub(super) const FIELD: i64 = 160;
pub(super) const FRAGMENT: i64 = 112;
pub(super) const RELATION: i64 = 96;
pub(super) const LIMITS: &[&str] = &[
    "browser_unobserved",
    "files_skills_other_chats_unobserved",
    "opaque_json_semantics_unevaluated",
    "runtime_intentions_unattested",
    "not_normalized",
    "not_F_admission",
];
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub version: u8,
    pub conversation: String,
    pub generation: String,
    pub actor: String,
    pub content: ConversationContentToken,
    pub dependencies: Version,
    pub schema: i64,
    pub budget: i64,
    pub max_receipts: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Open {
    pub capture_id: String,
    pub conversation_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Cursor {
    pub field: i64,
    pub offset: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Copy {
    pub cursor: Cursor,
    pub expected_revision: i64,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct Receipt {
    pub capture_id: String,
    pub phase: i64,
    pub revision: i64,
    pub cursor: Cursor,
    pub rows: i64,
    pub fields: i64,
    pub bytes: i64,
    pub charge: i64,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(super) struct Ack {
    pub next: Cursor,
    pub total_bytes: i64,
    pub revision: i64,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Copied {
    pub receipt: Receipt,
    pub ack: Option<Ack>,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct FieldInfo {
    pub ordinal: i64,
    pub row: i64,
    pub family: i64,
    pub tag: i64,
    pub sql_type: i64,
    pub bytes: i64,
    pub sha256: Option<Vec<u8>>,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Stored {
    pub field: FieldInfo,
    pub offset: i64,
    pub sha256: Vec<u8>,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Readback {
    pub receipt: Receipt,
    pub binding: Binding,
    pub manifest: Option<Vec<u8>>,
    pub fragments: Vec<Stored>,
    pub next: Option<Cursor>,
    pub limits: &'static [&'static str],
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct StoredRelation {
    pub from: i64,
    pub kind: i64,
    pub position: i64,
    pub to: Option<i64>,
    pub status: i64,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct RawNativeCapture {
    pub receipt: Receipt,
    pub binding: Binding,
    pub manifest: Vec<u8>,
    pub limits: &'static [&'static str],
}
