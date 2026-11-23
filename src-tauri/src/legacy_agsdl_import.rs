//! Read-only migration of the legacy Architect 0.3 library. Run discovery on a
//! blocking worker, while legacy writers are idle, before retiring their storage.
mod discovery;
mod journal;

use crate::architect_library::{migration, storage::Storage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(Debug, Deserialize)]
#[serde(tag = "state", content = "value", rename_all = "camelCase")]
pub enum LegacyLocalStorage {
    Snapshot(BTreeMap<String, String>),
    Unavailable(String),
    #[serde(skip_deserializing)]
    NotApplicable,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProject {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyConversationLink {
    pub plan_id: String,
    pub target_branch: String,
    pub conversation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProfile {
    /// Configured metadata workspace first, then any active/fallback workspace.
    pub workspace_paths: Vec<PathBuf>,
    /// Supplemental registry entries if the caller already has a profile snapshot.
    #[serde(default)]
    pub projects: Vec<LegacyProject>,
    pub local_storage: LegacyLocalStorage,
    /// Optional rows from the existing Architect conversation sync table.
    #[serde(default)]
    pub conversation_links: Vec<LegacyConversationLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyOrigin {
    pub scope: &'static str,
    pub location: String,
    pub project_ids: Vec<String>,
    pub revision: Option<u64>,
    pub updated_at: Option<String>,
    pub conversation_ids: BTreeSet<String>,
    pub transcript: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyBlueprint {
    pub import_key: String,
    pub branch: String,
    pub plan_id: String,
    pub source_project_id: String,
    pub project_name: String,
    pub name: String,
    /// The original editor envelope, including the exact source and annex strings.
    pub document: Value,
    pub metadata: BTreeMap<String, Value>,
    pub origins: BTreeSet<LegacyOrigin>,
}

impl LegacyBlueprint {
    /// Prefer the plan's own link; otherwise use an unambiguous fallback.
    pub fn conversation_id(&self) -> Option<&str> {
        if let Some(id) = self.metadata.get("conversationId").and_then(Value::as_str) {
            return Some(id);
        }
        let mut ids = self
            .origins
            .iter()
            .flat_map(|origin| &origin.conversation_ids);
        let first = ids.next()?;
        ids.all(|id| id == first).then_some(first)
    }

    /// Wire input for Architect's library import. Its new draft and v1 have
    /// their own revision; the legacy editor revision belongs in history.
    pub fn destination_input(&self) -> Value {
        let mut document = self.document.clone();
        document
            .as_object_mut()
            .expect("editor envelope")
            .remove("revision");
        serde_json::json!({
            "sourceProjectId": self.source_project_id,
            "sourceId": self.import_key,
            "projectName": self.project_name,
            "name": self.name,
            "document": document,
            "conversationId": self.conversation_id(),
            "history": self.history(),
        })
    }

    /// Opaque migration history for the destination. The blueprint's current
    /// editor document is stored separately so editing it cannot erase history.
    pub fn history(&self) -> Value {
        let mut history = serde_json::Map::from_iter(self.metadata.clone());
        history.insert("legacyBranch".into(), Value::from(self.branch.clone()));
        history.insert("legacyPlanId".into(), Value::from(self.plan_id.clone()));
        history.insert(
            "origins".into(),
            serde_json::to_value(&self.origins).expect("JSON origins"),
        );
        history.insert(
            "legacyDocumentRevision".into(),
            self.document["revision"].clone(),
        );
        Value::Object(history)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportIssue {
    pub location: String,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct LegacyDiscovery {
    pub blueprints: Vec<LegacyBlueprint>,
    pub issues: Vec<LegacyImportIssue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyImportStatus {
    Complete,
    DiscoveryIncomplete,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportReport {
    pub status: LegacyImportStatus,
    pub discovered: usize,
    pub inserted: usize,
    pub already_imported: usize,
    pub divergent_plans: usize,
    pub issues: Vec<LegacyImportIssue>,
}

pub fn discover_legacy_agsdl(profile: &LegacyProfile) -> LegacyDiscovery {
    discovery::discover(profile, journal::Journal::default())
}

/// Include the approved runtime configuration even when startup selected a
/// different active workspace. An invalid configuration can hide the old root.
pub(crate) async fn configured_roots(
    manager: &crate::config::ConfigManager,
    mut roots: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, LegacyImportIssue> {
    use crate::config::ConfigDocumentKind;
    use crate::core::config::{apply_runtime_workspace, AppConfig};
    let issue = |message: String| LegacyImportIssue {
        location: "runtime.json".into(),
        message,
    };
    let snapshot = manager
        .get_loaded_snapshot(&[])
        .await
        .map_err(|error| issue(error.message))?;
    let runtime = snapshot
        .documents
        .iter()
        .find(|doc| doc.kind == ConfigDocumentKind::Runtime)
        .ok_or_else(|| issue("Missing profile runtime configuration".into()))?;
    if runtime.invalid || runtime.read_only {
        return Err(issue(
            "Cannot determine the legacy workspace from the profile configuration".into(),
        ));
    }
    let value = snapshot
        .effective
        .get("runtime")
        .ok_or_else(|| issue("Missing effective runtime configuration".into()))?;
    let mut config = AppConfig::default();
    apply_runtime_workspace(&mut config, value).map_err(|error| issue(error.to_string()))?;
    if !config.workspace_path_source.is_default() {
        roots.push(config.workspace_path);
    }
    Ok(roots)
}

async fn record_legacy_chat_claims(db: &mut sqlx::SqliteConnection) -> crate::db::DbResult<()> {
    // Only the complete profile scan can establish a sole historical claimant.
    // A standalone import can be followed by another replica citing the same chat.
    sqlx::query(
        "INSERT OR IGNORE INTO app_settings(key,value_json,updated_at)
         SELECT 'architect:legacy-chat-claim:' || conversation_id,json_quote(id),CURRENT_TIMESTAMP
         FROM architect_blueprints AS b
         WHERE conversation_id=json_extract(history,'$.legacyConversationId')
           AND NOT EXISTS (SELECT 1 FROM architect_blueprints AS other WHERE other.id<>b.id
             AND (other.conversation_id=b.conversation_id
                  OR json_extract(other.history,'$.legacyConversationId')=b.conversation_id))",
    )
    .execute(&mut *db)
    .await?;
    sqlx::query("INSERT OR REPLACE INTO app_settings(key,value_json,updated_at) VALUES('architect:legacy-chat-claims-complete','true',CURRENT_TIMESTAMP)")
        .execute(db).await?;
    Ok(())
}

pub(crate) async fn bootstrap_profile(
    pool: &sqlx::SqlitePool,
    storage: &Storage,
    workspace_paths: Result<Vec<PathBuf>, LegacyImportIssue>,
    fallback_workspace: Option<PathBuf>,
    local_storage: LegacyLocalStorage,
    progress: impl Fn(Option<migration::Progress>) + Send + Sync,
) -> crate::db::DbResult<LegacyImportReport> {
    // SQLite already owns these rows. Their cutover can finish even if a
    // separate historical source cannot be read on this launch.
    let cutover =
        migration::migrate_with_progress(pool, storage, |update| progress(Some(update))).await;
    progress(None);
    cutover?;
    import_profile(
        pool,
        Some(storage),
        workspace_paths,
        fallback_workspace,
        local_storage,
    )
    .await
}

/// Read the native profile and publish its entire legacy library once. The write
/// lock also serializes a second bootstrap and the conversation-link snapshot.
#[cfg(test)]
pub(crate) async fn migrate_profile(
    pool: &sqlx::SqlitePool,
    workspace_paths: Result<Vec<PathBuf>, LegacyImportIssue>,
    fallback_workspace: Option<PathBuf>,
    local_storage: LegacyLocalStorage,
) -> crate::db::DbResult<LegacyImportReport> {
    import_profile(
        pool,
        None,
        workspace_paths,
        fallback_workspace,
        local_storage,
    )
    .await
}

/// Publish a complete scan into the profile, including after the index cutover.
pub(crate) async fn import_profile(
    pool: &sqlx::SqlitePool,
    storage: Option<&Storage>,
    workspace_paths: Result<Vec<PathBuf>, LegacyImportIssue>,
    fallback_workspace: Option<PathBuf>,
    local_storage: LegacyLocalStorage,
) -> crate::db::DbResult<LegacyImportReport> {
    use crate::db::{architect_library, DbError};
    use sqlx::Connection;
    let _lease = match storage {
        Some(storage) => Some(storage.lease(true).await?),
        None => None,
    };
    let mut writer = architect_library::storage_index::durable_writer(pool).await?;
    let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
    let finished: Option<(u32, u32)> = sqlx::query_as(
        "SELECT discovered,divergent_plans FROM architect_legacy_import WHERE singleton=1",
    )
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((discovered, divergent_plans)) = finished {
        // Older completed batches predate conversation attribution. Their rows
        // are sufficient for the backfill even when the original files are gone.
        let claims_recorded: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key='architect:legacy-chat-claims-complete')",
        ).fetch_one(&mut *tx).await?;
        if !claims_recorded {
            record_legacy_chat_claims(&mut tx).await?;
        }
        tx.commit().await?;
        return Ok(LegacyImportReport {
            status: LegacyImportStatus::Complete,
            discovered: discovered as usize,
            already_imported: discovered as usize,
            inserted: 0,
            divergent_plans: divergent_plans as usize,
            issues: Vec::new(),
        });
    }
    let workspace_paths = match workspace_paths {
        Ok(paths) => paths,
        Err(issue) => {
            return Ok(LegacyImportReport {
                status: LegacyImportStatus::DiscoveryIncomplete,
                discovered: 0,
                inserted: 0,
                already_imported: 0,
                divergent_plans: 0,
                issues: vec![issue],
            })
        }
    };
    let links: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT plan_id,target_branch,conversation_id FROM architect_plan_conversation_sync",
    )
    .fetch_all(&mut *tx)
    .await?;
    let conversation_links = links
        .into_iter()
        .map(
            |(plan_id, target_branch, conversation_id)| LegacyConversationLink {
                plan_id,
                target_branch,
                conversation_id,
            },
        )
        .collect();
    let pending: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key=?")
            .bind(journal::KEY)
            .fetch_optional(&mut *tx)
            .await?;
    let discovery = tokio::task::spawn_blocking(move || {
        let mut paths = workspace_paths;
        if let Some(fallback) = fallback_workspace {
            // An unused default directory may be absent. A broken symlink or
            // permission error must still reach discovery and block completion.
            let metadata = std::fs::symlink_metadata(&fallback);
            if !matches!(metadata, Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
                paths.push(fallback);
            }
        }
        let journal = match journal::Journal::parse(pending.as_deref()) {
            Ok(journal) => journal,
            Err(message) => {
                return LegacyDiscovery {
                    blueprints: Vec::new(),
                    issues: vec![LegacyImportIssue {
                        location: journal::KEY.into(),
                        message,
                    }],
                }
            }
        };
        discovery::discover(
            &LegacyProfile {
                workspace_paths: paths,
                projects: Vec::new(),
                local_storage,
                conversation_links,
            },
            journal,
        )
    })
    .await
    .map_err(|error| DbError::Migration(error.to_string()))?;
    let mut counts = BTreeMap::new();
    for item in &discovery.blueprints {
        *counts.entry((&item.branch, &item.plan_id)).or_insert(0) += 1;
    }
    let mut report = LegacyImportReport {
        status: LegacyImportStatus::DiscoveryIncomplete,
        discovered: discovery.blueprints.len(),
        inserted: 0,
        already_imported: 0,
        divergent_plans: counts.values().filter(|&&count| count > 1).count(),
        issues: discovery.issues,
    };
    if !report.issues.is_empty() {
        tx.rollback().await?;
        return Ok(report);
    }
    let mut inserted = 0;
    for blueprint in discovery.blueprints {
        let result = async {
            let input = serde_json::from_value(blueprint.destination_input())
                .map_err(|error| DbError::Validation(error.to_string()))?;
            architect_library::import_in(&mut tx, input, storage).await
        }
        .await;
        match result {
            Ok(result) => inserted += usize::from(result.imported),
            Err(DbError::Validation(message)) => {
                report.issues.push(LegacyImportIssue {
                    location: blueprint
                        .origins
                        .first()
                        .map(|origin| origin.location.clone())
                        .unwrap_or(blueprint.import_key),
                    message,
                });
                tx.rollback().await?;
                return Ok(report);
            }
            Err(error) => return Err(error),
        }
    }
    record_legacy_chat_claims(&mut tx).await?;
    sqlx::query(
        "INSERT INTO architect_legacy_import(singleton,discovered,divergent_plans) VALUES(1,?,?)",
    )
    .bind(report.discovered as i64)
    .bind(report.divergent_plans as i64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    report.status = LegacyImportStatus::Complete;
    report.inserted = inserted;
    report.already_imported = report.discovered - inserted;
    Ok(report)
}

fn import_key(
    branch: &str,
    id: &str,
    document: &Value,
    metadata: &BTreeMap<String, Value>,
    source_project_id: &str,
) -> String {
    // Sort nested object keys even when serde_json's preserve_order feature is enabled.
    let mut document = document.clone();
    document.sort_all_objects();
    let mut metadata = serde_json::to_value(metadata).expect("JSON metadata");
    metadata.sort_all_objects();
    let canonical = serde_json::to_vec(&(branch, id, source_project_id, document, metadata))
        .expect("JSON blueprint");
    format!("legacy-agsdl-030:v1:{:x}", Sha256::digest(canonical))
}

#[cfg(test)]
mod tests;
