//! Local read selectors and output data only, never F authority.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ArchiveSelector {
    Entries,
    Records {
        ordinal: Option<String>,
        uuid: Option<String>,
    },
    Resources {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    Body {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    Citation {
        #[serde(rename = "citationId")]
        citation_id: String,
        field: String,
    },
    Asset {
        #[serde(rename = "assetId")]
        asset_id: String,
    },
}
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveOpenInput {
    pub conversation_id: String,
    pub selector: ArchiveSelector,
}
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReadHandle {
    pub read_id: String,
    pub generation: String,
    pub conversation_id: String,
    pub manifest: String,
}
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivePageInput {
    pub read_id: String,
    pub cursor_id: Option<String>,
    pub limit: u8,
}
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveResource {
    pub uuid: String,
    pub kind: String,
    pub field: String,
    pub ordinal: String,
    pub message_id: Option<String>,
    pub position: String,
    pub mime_type: Option<String>,
    pub bytes: String,
    pub sha256: String,
}
#[derive(Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArchiveItem {
    Entry {
        ordinal: String,
        #[serde(rename = "targetUuid")]
        target_uuid: Option<String>,
        #[serde(rename = "headerJson")]
        header_json: String,
        origin: Option<crate::db::models::PortableMessageOrigin>,
    },
    Record {
        ordinal: String,
        #[serde(rename = "targetUuid")]
        target_uuid: Option<String>,
        #[serde(rename = "headerJson")]
        header_json: String,
        offset: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
        sha256: String,
    },
    Resource {
        resource: ArchiveResource,
    },
    Fragment {
        resource: ArchiveResource,
        offset: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
        sha256: String,
    },
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePage {
    pub page_id: String,
    pub items: Vec<ArchiveItem>,
    pub next_cursor_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveRange {
    pub start: String,
    pub end: String,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveUse {
    RenderText,
    ContextText,
    Image,
}
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveMaterializeInput {
    pub read_id: String,
    pub resource_uuid: String,
    pub r#use: ArchiveUse,
    pub range: Option<ArchiveRange>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveBacking {
    pub backing_id: String,
    pub conversation_id: String,
    pub manifest: String,
    pub resource: ArchiveResource,
    pub start: String,
    pub end: String,
    pub complete: bool,
    pub text: Option<String>,
    pub ready_data_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ArchiveReleaseInput {
    pub id: String,
}
