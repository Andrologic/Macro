use super::*;
use sqlx::sqlite::SqliteRow;

const NAME: &str = "049_architect_library_artifacts";
const MIGRATION: &str = include_str!("../migrations/049_architect_library_artifacts.sql");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StorageState {
    Draft,
    Archive,
    Recovery,
}

impl StorageState {
    pub(crate) fn parse(value: &str) -> DbResult<Self> {
        match value {
            "draft" => Ok(Self::Draft),
            "archive" => Ok(Self::Archive),
            "recovery" => Ok(Self::Recovery),
            _ => Err(invalid("invalid_architect_storage_state")),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Archive => "archive",
            Self::Recovery => "recovery",
        }
    }
}

#[derive(Debug)]
pub(crate) struct Artifact {
    pub blueprint_id: String,
    pub id: Uuid,
    pub state: StorageState,
    pub sha256: Option<String>,
}

impl Artifact {
    pub(crate) fn from_row(row: &SqliteRow, blueprint_column: &str) -> DbResult<Self> {
        let id: &str = row.try_get("artifact_id")?;
        let parsed = Uuid::parse_str(id).map_err(|_| invalid("invalid_architect_artifact_id"))?;
        if parsed.to_string() != id {
            return Err(invalid("invalid_architect_artifact_id"));
        }
        Ok(Self {
            blueprint_id: row.try_get(blueprint_column)?,
            id: parsed,
            state: StorageState::parse(row.try_get("storage_state")?)?,
            sha256: row.try_get("archive_sha256")?,
        })
    }
}

pub(crate) async fn durable_writer(
    pool: &SqlitePool,
) -> DbResult<sqlx::pool::PoolConnection<sqlx::Sqlite>> {
    let mut connection = pool.acquire().await?;
    // A committed pointer must survive power loss before the previous
    // artifact can be reclaimed. The ordinary pool defaults to WAL/NORMAL.
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *connection)
        .await?;
    Ok(connection)
}

pub(crate) async fn is_current(db: &mut SqliteConnection) -> DbResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=49 AND name=?)",
    )
    .bind(NAME)
    .fetch_one(db)
    .await?)
}

pub(crate) async fn artifact_references(db: &mut SqliteConnection) -> DbResult<Vec<Artifact>> {
    if !is_current(db).await? {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT id AS blueprint_id, artifact_id, storage_state, NULL AS archive_sha256 FROM architect_blueprints
         UNION
         SELECT blueprint_id, artifact_id, storage_state, archive_sha256 FROM architect_versions
         UNION
         SELECT blueprint_id, artifact_id, 'recovery', NULL FROM architect_library_originals",
    )
    .fetch_all(db)
    .await?;
    rows.iter()
        .map(|row| Artifact::from_row(row, "blueprint_id"))
        .collect()
}

pub(crate) async fn begin_cutover(db: &mut SqliteConnection) -> DbResult<()> {
    sqlx::query(
        "CREATE TEMP TABLE architect_artifact_plan (
            blueprint_id TEXT NOT NULL, number INTEGER NOT NULL, revision INTEGER NOT NULL,
            artifact_id TEXT NOT NULL, storage_state TEXT NOT NULL, archive_sha256 TEXT,
            original_id TEXT NOT NULL, PRIMARY KEY (blueprint_id,number)
        )",
    )
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn plan(
    db: &mut SqliteConnection,
    number: i64,
    revision: i64,
    artifact: &Artifact,
    original: &Artifact,
) -> DbResult<()> {
    sqlx::query("INSERT INTO temp.architect_artifact_plan VALUES (?,?,?,?,?,?,?)")
        .bind(&artifact.blueprint_id)
        .bind(number)
        .bind(revision)
        .bind(artifact.id.to_string())
        .bind(artifact.state.as_str())
        .bind(&artifact.sha256)
        .bind(original.id.to_string())
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn finish_cutover(db: &mut SqliteConnection) -> DbResult<()> {
    super::super::apply_migration(db, 49, NAME.into(), MIGRATION.into()).await
}

pub(crate) async fn draft_row(pool: &SqlitePool, id: &str) -> DbResult<SqliteRow> {
    Ok(
        sqlx::query("SELECT *,NULL AS archive_sha256 FROM architect_blueprints WHERE id=?")
            .bind(id)
            .fetch_one(pool)
            .await?,
    )
}

pub(crate) async fn version_row(pool: &SqlitePool, key: &VersionKey) -> DbResult<SqliteRow> {
    Ok(
        sqlx::query("SELECT * FROM architect_versions WHERE blueprint_id=? AND number=?")
            .bind(&key.blueprint_id)
            .bind(key.number)
            .fetch_one(pool)
            .await?,
    )
}

pub(crate) fn draft_view(
    row: &SqliteRow,
    document: Document,
    diagnostics: Vec<String>,
) -> DbResult<Draft> {
    Ok(Draft {
        summary: summary(row)?,
        history: history(row)?,
        document,
        storage_state: Some(row.try_get("storage_state")?),
        diagnostics,
    })
}

pub(crate) fn version_view(
    row: &SqliteRow,
    document: Document,
    diagnostics: Vec<String>,
) -> DbResult<Version> {
    Ok(Version {
        summary: version_summary(row)?,
        document,
        diagnostics,
    })
}

pub(crate) async fn insert_draft(
    db: &mut SqliteConnection,
    project: &str,
    name: &str,
    artifact: &Artifact,
    origin: Option<&VersionKey>,
) -> DbResult<SqliteRow> {
    Ok(sqlx::query(
        "INSERT INTO architect_blueprints
         (id,project_id,name,artifact_id,storage_state,origin_blueprint_id,origin_number)
         VALUES (?,?,?,?,?,?,?) RETURNING *",
    )
    .bind(&artifact.blueprint_id)
    .bind(project)
    .bind(name)
    .bind(artifact.id.to_string())
    .bind(artifact.state.as_str())
    .bind(origin.map(|key| &key.blueprint_id))
    .bind(origin.map(|key| key.number))
    .fetch_one(db)
    .await?)
}

pub(crate) async fn update_draft(
    db: &mut SqliteConnection,
    expected: i64,
    artifact: &Artifact,
) -> DbResult<SqliteRow> {
    sqlx::query(
        "UPDATE architect_blueprints SET artifact_id=?,storage_state=?,revision=revision+1
         WHERE id=? AND revision=? AND NOT archived RETURNING *",
    )
    .bind(artifact.id.to_string())
    .bind(artifact.state.as_str())
    .bind(&artifact.blueprint_id)
    .bind(expected)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| invalid("stale_revision"))
}

pub(crate) async fn freeze(
    db: &mut SqliteConnection,
    revision: i64,
    note: Option<String>,
    artifact: &Artifact,
    converted_draft: Option<Document>,
) -> DbResult<SavedVersion> {
    let number: i64 = sqlx::query_scalar(
        "UPDATE architect_blueprints SET last_number=last_number+1
         WHERE id=? AND revision=? AND NOT archived RETURNING last_number",
    )
    .bind(&artifact.blueprint_id)
    .bind(revision)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(|| invalid("stale_revision"))?;
    let row = sqlx::query(
        "INSERT INTO architect_versions
         (blueprint_id,number,revision,note,artifact_id,storage_state,archive_sha256,created_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *",
    )
    .bind(&artifact.blueprint_id)
    .bind(number)
    .bind(revision)
    .bind(note)
    .bind(artifact.id.to_string())
    .bind(artifact.state.as_str())
    .bind(&artifact.sha256)
    .bind(chrono::Utc::now().to_rfc3339())
    .fetch_one(db)
    .await?;
    Ok(SavedVersion {
        summary: version_summary(&row)?,
        converted_draft,
    })
}

pub(crate) async fn retain_draft_original(
    db: &mut SqliteConnection,
    revision: i64,
    artifact: &Artifact,
) -> DbResult<()> {
    sqlx::query("INSERT INTO architect_library_originals VALUES (?,0,?,?)")
        .bind(&artifact.blueprint_id)
        .bind(revision)
        .bind(artifact.id.to_string())
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn original(
    pool: &SqlitePool,
    blueprint_id: &str,
    revision: i64,
    number: i64,
) -> DbResult<Option<Artifact>> {
    let row = sqlx::query(
        "SELECT blueprint_id,artifact_id,'recovery' AS storage_state,NULL AS archive_sha256
         FROM architect_library_originals WHERE blueprint_id=? AND version_number=? AND revision=?",
    )
    .bind(blueprint_id)
    .bind(number)
    .bind(revision)
    .fetch_optional(pool)
    .await?;
    row.map(|row| Artifact::from_row(&row, "blueprint_id"))
        .transpose()
}
