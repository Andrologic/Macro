use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CONTROL_BYTES: usize = 4096;
pub const FRAGMENT_BYTES: usize = 4093;
pub const PAGE_FRAGMENTS: usize = 32;
// Logical retained slots/index keys, not SQLite pages or heap allocations.
pub(super) const JOURNAL_BYTES: i64 = 152;
pub(super) const RECORD_BYTES: i64 = 104;
pub(super) const FRAGMENT_META_BYTES: i64 = 96;
pub(super) const MAPPING_BYTES: i64 = 104;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub origin: String,
    pub account_incarnation: String,
    pub source_instance: String,
    pub source_conversation: String,
    pub transfer: String,
    pub source_epoch: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bindings {
    pub target_instance: String,
    pub source_generation: String,
    pub target_generation: String,
    pub actor: String,
    pub initial_session: String,
    pub policy_revision: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    SyntheticHistoryV1,
    PortableChatHistoryV1,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Begin {
    pub version: u8,
    pub identity: Identity,
    pub bindings: Bindings,
    pub profile: Profile,
    pub records: u64,
    pub bytes: u64,
    pub manifest_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextPurpose {
    SourceIdentity,
    Summary,
    Fact,
    Title,
    Url,
    Label,
    PortableMetadata,
    OriginalText,
    HistoricalData,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mime {
    TextPlain,
    ImagePng,
    ImageJpeg,
    ImageWebp,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    AssetForMessage,
    CitationForMessage,
    DataForMessage,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecordKind {
    Message {
        role: Role,
    },
    HistoricalText {
        purpose: TextPurpose,
    },
    Citation,
    Asset {
        mime: Mime,
    },
    Association {
        from: u64,
        to: u64,
        position: u64,
        relation: Relation,
    },
}
impl RecordKind {
    pub(super) fn tag(&self) -> i64 {
        match self {
            Self::Message { .. } => 0,
            Self::HistoricalText { .. } => 1,
            Self::Citation => 2,
            Self::Asset { .. } => 3,
            Self::Association { .. } => 4,
        }
    }
    pub(super) fn text(&self) -> bool {
        !matches!(
            self,
            Self::Asset {
                mime: Mime::ImagePng | Mime::ImageJpeg | Mime::ImageWebp
            } | Self::Association { .. }
        )
    }
    pub(super) fn links(&self) -> (Option<i64>, Option<i64>, Option<i64>, Option<i64>) {
        match self {
            Self::Association {
                from,
                to,
                position,
                relation,
            } => (
                Some(*from as i64),
                Some(*to as i64),
                Some(*position as i64),
                Some(match relation {
                    Relation::AssetForMessage => 0,
                    Relation::CitationForMessage => 1,
                    Relation::DataForMessage => 2,
                }),
            ),
            _ => (None, None, None, None),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordHeader {
    pub ordinal: u64,
    pub entry: RecordKind,
    pub bytes: u64,
    pub sha256: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_origin"
    )]
    pub origin: Option<u64>,
}
// Absence preserves the legacy envelope; an explicit null is never an origin.
fn present_origin<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> std::result::Result<Option<u64>, D::Error> {
    u64::deserialize(decoder).map(Some)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Append {
    pub record: RecordHeader,
    pub offset: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Receiving = 0,
    Verifying = 1,
    SealedStorage = 2,
    Aborted = 3,
    Expired = 4,
}
impl Phase {
    pub(super) fn from_db(v: i64) -> Result<Self, String> {
        match v {
            0 => Ok(Self::Receiving),
            1 => Ok(Self::Verifying),
            2 => Ok(Self::SealedStorage),
            3 => Ok(Self::Aborted),
            4 => Ok(Self::Expired),
            _ => Err("integrity_failed".into()),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub key: String,
    pub phase: Phase,
    pub revision: i64,
    pub received_bytes: i64,
    pub records: i64,
    pub charge_bytes: i64,
    pub mapping_sha256: Option<String>,
}
/// Storage only. This is deliberately not an F admission or provider-context type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedStorage {
    pub receipt: Receipt,
    pub manifest_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendAck {
    pub ordinal: u64,
    pub next_offset: u64,
    pub received_bytes: u64,
    pub revision: i64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub ordinal: u64,
    pub offset: u64,
}
#[derive(Debug, Clone)]
pub struct StoredFragment {
    pub record: RecordHeader,
    pub offset: u64,
    pub bytes: Vec<u8>,
    pub target_uuid: Option<String>,
}
#[derive(Debug, Clone)]
pub struct Readback {
    pub fragments: Vec<StoredFragment>,
    pub next: Option<Cursor>,
}

pub(super) fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "invalid_frame".into())
}
pub(super) fn parse<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    if bytes.len() > CONTROL_BYTES {
        return Err("resource_limit".into());
    }
    serde_json::from_slice(bytes).map_err(|_| "invalid_frame".into())
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn hash_valid(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn identity_key(identity: &Identity) -> Result<String, String> {
    Ok(digest(json(identity)?.as_bytes()))
}
fn field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}
pub struct Manifest {
    hash: Sha256,
}
impl Manifest {
    pub fn new(begin: &Begin) -> Result<Self, String> {
        let mut hash = Sha256::new();
        hash.update(b"macro-inactive-storage-manifest-v1\0");
        field(&mut hash, json(&begin.identity)?.as_bytes());
        field(&mut hash, json(&begin.bindings)?.as_bytes());
        field(&mut hash, json(&begin.profile)?.as_bytes());
        hash.update([begin.version]);
        hash.update(begin.records.to_le_bytes());
        hash.update(begin.bytes.to_le_bytes());
        Ok(Self { hash })
    }
    pub fn record(&mut self, record: &RecordHeader) -> Result<(), String> {
        field(&mut self.hash, &Sha256::digest(json(record)?.as_bytes()));
        Ok(())
    }
    pub fn finish(self) -> String {
        format!("{:x}", self.hash.finalize())
    }
}
