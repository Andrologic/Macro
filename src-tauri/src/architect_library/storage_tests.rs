use super::{
    archive::VERSION_FILENAME,
    migration,
    storage::{Failure, Storage, ORIGINAL, PROJECT},
};
use crate::db::{
    architect_library::{
        self as db,
        storage_index::{self as index, Artifact, StorageState},
        Document, VersionKey,
    },
    create_pool,
};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::{collections::BTreeMap, fs};

const NUMBER: &str = "987654321098765432101234567890123456789";
const BLUEPRINT: &str = "legacy-blueprint";

fn editor(title: &str) -> Document {
    let source = r#"{
        "contract":"agsdl-0.3.0","id":"reviews","title":"TITLE",
        "agents":{"reviewer":{"harness":"codex","permissions":"read-only","instructions":[{"uri":"./notes/étude.md?x=1#title"}],
            "harnessSettings":{}}},
        "content":{"data":{"value":{"number":987654321098765432101234567890123456789,"uri":"no-file"}}},
        "skills":{"analysis":{"uri":"agents/SKILL.md"}},
        "mcpServers":{"local":{"command":["external-program","tools/example.sh"]}},
        "flow":{"entry":"review","steps":{"review":{"type":"agent","agent":"reviewer"}}}
    }"#.replace("TITLE", title);
    Document {
        source,
        annexes: BTreeMap::from([
            ("notes/étude.md".into(), "# Étude\r\n".into()),
            (
                "agents/SKILL.md".into(),
                "---\r\nname: analysis\r\ndescription: Review\r\n---\r\n".into(),
            ),
            (
                "agents/assets/résumé.md".into(),
                "Dans le sous-dossier\r\n".into(),
            ),
            ("tools/example.sh".into(), "authored bytes\n".into()),
            ("unreferenced.md".into(), "saved locally".into()),
            ("../outside".into(), "opaque key".into()),
            ("Notes/other.md".into(), "colliding directory".into()),
        ]),
        metadata: BTreeMap::from([
            ("design".into(), json!({"purpose":"Étudier"})),
            ("display".into(), json!({"title":"Affichage"})),
            (
                "unknownEditorMetadata".into(),
                json!({"object":[true,null]}),
            ),
            ("hiddenAgentIds".into(), json!(["reviewer"])),
            ("entryMessageHint".into(), json!("Décrire l'étude")),
        ]),
    }
}

fn envelope(document: &Document) -> String {
    format!(
        " \r\n {} \r\n ",
        serde_json::to_string_pretty(document).unwrap()
    )
}

async fn seed(pool: &SqlitePool, draft: &str) {
    sqlx::query("INSERT INTO architect_projects(id,name,source_project_id) VALUES ('project','Project','old-project')")
        .execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO architect_blueprints
            (id,project_id,name,revision,last_number,document,source_id,history,conversation_id)
            VALUES (?,'project','Reviews',5,7,?,'source',?,'legacy-conversation')",
    )
    .bind(BLUEPRINT)
    .bind(draft)
    .bind(
        json!({
            "legacyConversationId":"legacy-conversation",
            "origins":[{"transcript":"{\"role\":\"user\",\"content\":\"Étude conservée\"}\r\n"}],
        })
        .to_string(),
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO architect_legacy_import VALUES (1,1,0)")
        .execute(pool)
        .await
        .unwrap();
}

async fn historical(pool: &SqlitePool, number: i64, revision: i64, document: &str) {
    sqlx::query("INSERT INTO architect_versions(blueprint_id,number,revision,note,document) VALUES (?,?,?,'historical note',?)")
        .bind(BLUEPRINT).bind(number).bind(revision).bind(document).execute(pool).await.unwrap();
}

fn key(number: i64) -> VersionKey {
    VersionKey {
        blueprint_id: BLUEPRINT.into(),
        number,
    }
}

async fn draft_artifact(pool: &SqlitePool) -> Artifact {
    let row = index::draft_row(pool, BLUEPRINT).await.unwrap();
    Artifact::from_row(&row, "id").unwrap()
}

async fn version_artifact(pool: &SqlitePool, number: i64) -> Artifact {
    let row = index::version_row(pool, &key(number)).await.unwrap();
    Artifact::from_row(&row, "blueprint_id").unwrap()
}

#[tokio::test]
async fn migrates_each_revision_with_lossless_originals_and_preserves_library_identity() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path();
    let pool = create_pool(&data.join("macro.db")).await.unwrap();
    let draft = envelope(&editor("Draft"));
    let v1 = envelope(&editor("First revision"));
    let mut missing = editor("Missing resource");
    missing.annexes.remove("notes/étude.md");
    let v2 = envelope(&missing);
    let mut invalid = editor("Bad source");
    invalid.source = "{ incomplete".into();
    let v3 = envelope(&invalid);
    seed(&pool, &draft).await;
    historical(&pool, 1, 1, &v1).await;
    historical(&pool, 2, 3, &v2).await;
    historical(&pool, 3, 4, &v3).await;
    for (kind, number) in [("execution", 1), ("schedule", 2)] {
        sqlx::query("INSERT INTO architect_version_uses VALUES (?,'pin',?,?)")
            .bind(kind)
            .bind(BLUEPRINT)
            .bind(number)
            .execute(&pool)
            .await
            .unwrap();
    }
    // The SQL-only opening leaves the old documents and native disk untouched.
    assert!(!data.join(super::storage::ROOT).exists());
    let storage = Storage::new(data);
    assert!(migration::migrate(&pool, &storage).await.unwrap());
    assert!(sqlx::query("SELECT document FROM architect_blueprints")
        .execute(&pool)
        .await
        .is_err());
    assert!(sqlx::query("SELECT document FROM architect_versions")
        .execute(&pool)
        .await
        .is_err());
    assert!(sqlx::query("UPDATE architect_versions SET note='changed'")
        .execute(&pool)
        .await
        .is_err());

    let artifact = draft_artifact(&pool).await;
    assert_eq!(artifact.state, StorageState::Draft);
    let root = storage.artifact_path(&artifact).join(PROJECT);
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.join("agsdl.json")).unwrap()).unwrap();
    assert!(manifest["agents"]["reviewer"]["file"].is_string());
    assert!(manifest["settingsFiles"]["reviewer"].is_string());
    assert_eq!(manifest["projectFormat"], "agsdl-project-1");
    assert_eq!(
        fs::read(root.join("notes/étude.md")).unwrap(),
        b"# \xc3\x89tude\r\n"
    );
    assert!(root.join("unreferenced.md").is_file());
    assert!(!root.join("Notes/other.md").exists());
    let view =
        serde_json::to_value(storage.get_draft(&pool, BLUEPRINT.into()).await.unwrap()).unwrap();
    let source = view["document"]["source"].as_str().unwrap();
    assert!(source.contains(NUMBER));
    assert!(source.contains("notes/%C3%A9tude.md?x=1#title"), "{view}");
    assert!(source.contains("Draft"));
    assert_eq!(
        view["document"]["unknownEditorMetadata"],
        json!({"object":[true,null]})
    );
    assert_eq!(view["document"]["hiddenAgentIds"], json!(["reviewer"]));
    assert_eq!(view["document"]["annexes"]["../outside"], "opaque key");

    let valid = version_artifact(&pool, 1).await;
    let historical_view =
        serde_json::to_value(storage.get_version(&pool, key(1)).await.unwrap()).unwrap();
    assert!(historical_view.get("createdAt").is_none());
    assert_eq!(valid.state, StorageState::Archive);
    let archive = storage.open_archive(&valid).unwrap();
    assert!(archive.source().authored_json().contains("First revision"));
    let files: BTreeMap<_, _> = archive.members().map(|file| (file.path, file)).collect();
    assert!(files.contains_key("agents/assets/résumé.md"));
    assert!(!files.contains_key("tools/example.sh"));
    assert!(!files.contains_key("unreferenced.md"));
    assert!(files.values().all(|file| !file.executable));
    for (number, revision, raw) in [(0, 5, &draft), (1, 1, &v1), (2, 3, &v2), (3, 4, &v3)] {
        let original = index::original(&pool, BLUEPRINT, revision, number)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(storage.artifact_path(&original).join(ORIGINAL)).unwrap(),
            raw.as_bytes()
        );
    }
    for number in [2, 3] {
        assert!(storage
            .open_archive(&version_artifact(&pool, number).await)
            .is_err());
        let view =
            serde_json::to_value(storage.get_version(&pool, key(number)).await.unwrap()).unwrap();
        assert_eq!(view["note"], "historical note");
        assert!(view["diagnostics"]
            .as_array()
            .is_some_and(|list| !list.is_empty()));
    }
    let download = data.join("original.json");
    storage
        .export_original(&pool, BLUEPRINT.into(), 4, Some(3), &download)
        .await
        .unwrap();
    assert_eq!(fs::read(download).unwrap(), v3.as_bytes());
    let repair = serde_json::to_value(
        storage
            .adapt_version(&pool, key(2), "project".into(), "Repair".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(repair["storageState"], "draft");
    assert_eq!(repair["origin"]["number"], 2);
    let adapted = serde_json::to_value(
        storage
            .adapt_version(&pool, key(1), "project".into(), "Adapted".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        adapted["document"]["annexes"]["unreferenced.md"],
        "saved locally"
    );
    assert!(storage.delete_version(&pool, key(1)).await.is_err());
    assert!(storage.delete_version(&pool, key(2)).await.is_err());

    let binding = serde_json::to_value(
        db::ensure_conversation(&pool, BLUEPRINT.into())
            .await
            .unwrap(),
    )
    .unwrap();
    let transcript: String =
        sqlx::query_scalar("SELECT content FROM messages WHERE conversation_id=?")
            .bind(binding["conversationId"].as_str().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(transcript, "Étude conservée");
    let saved = serde_json::to_value(
        storage
            .freeze(&pool, BLUEPRINT.into(), 5, None, None)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["number"], 8);
    assert!(saved["createdAt"].is_string());
    pool.close().await;
    let reopened = create_pool(&data.join("macro.db")).await.unwrap();
    assert!(migration::migrate(&reopened, &storage).await.unwrap());
    assert_eq!(draft_artifact(&reopened).await.id, artifact.id);
}

#[tokio::test]
async fn native_publication_recovers_failures_and_serializes_save_freeze_and_delete() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path();
    let pool = create_pool(&data.join("macro.db")).await.unwrap();
    let original = envelope(&editor("Draft"));
    seed(&pool, &original).await;

    for failure in [
        Failure::BeforePublish,
        Failure::AfterPublish,
        Failure::BeforeCommit,
    ] {
        let failing = Storage::new(data).with_failure(failure);
        assert!(migration::migrate(&pool, &failing).await.is_err());
        let retained: String = sqlx::query_scalar("SELECT document FROM architect_blueprints")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(retained, original);
    }
    let storage = Storage::new(data);
    assert!(migration::migrate(&pool, &storage).await.unwrap());
    let initial = draft_artifact(&pool).await;
    for failure in [
        Failure::BeforePublish,
        Failure::AfterPublish,
        Failure::BeforeCommit,
    ] {
        let failing = Storage::new(data).with_failure(failure);
        assert!(failing
            .save_draft(&pool, BLUEPRINT.into(), 5, editor("Failed"))
            .await
            .is_err());
        assert_eq!(draft_artifact(&pool).await.id, initial.id);
        assert!(failing
            .freeze(&pool, BLUEPRINT.into(), 5, None, None)
            .await
            .is_err());
        let last_number: i64 =
            sqlx::query_scalar("SELECT last_number FROM architect_blueprints WHERE id=?")
                .bind(BLUEPRINT)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(last_number, 7);
    }
    storage
        .freeze(&pool, BLUEPRINT.into(), 5, None, None)
        .await
        .unwrap();
    let old_version = version_artifact(&pool, 8).await;
    let (save, freeze, delete) = tokio::join!(
        storage.save_draft(&pool, BLUEPRINT.into(), 5, editor("Next")),
        storage.freeze(&pool, BLUEPRINT.into(), 5, None, None),
        storage.delete_version(&pool, key(8)),
    );
    save.unwrap();
    delete.unwrap();
    assert!(!storage.artifact_path(&initial).exists());
    assert!(!storage.artifact_path(&old_version).exists());
    if let Err(error) = freeze {
        assert!(error.to_string().contains("stale_revision"), "{error}");
    }
    let saved = serde_json::to_value(
        storage
            .freeze(&pool, BLUEPRINT.into(), 6, None, None)
            .await
            .unwrap(),
    )
    .unwrap();
    let number = saved["number"].as_i64().unwrap();
    let persisted = version_artifact(&pool, number).await;
    let path = storage.artifact_path(&persisted);
    assert!(path.join(VERSION_FILENAME).is_file());
    let failing = Storage::new(data).with_failure(Failure::Reclaim);
    failing.delete_version(&pool, key(number)).await.unwrap();
    assert!(path.is_dir());
    assert!(index::version_row(&pool, &key(number)).await.is_err());
    let abandoned = data
        .join(super::storage::ROOT)
        .join("staging")
        .join(".draft-abandoned");
    fs::create_dir_all(&abandoned).unwrap();
    migration::migrate(&pool, &storage).await.unwrap();
    assert!(!path.exists());
    assert!(!abandoned.exists());
}

#[tokio::test]
async fn current_ui_can_repair_an_incomplete_draft_after_cutover() {
    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    let mut missing = editor("Needs annex");
    missing.annexes.remove("notes/étude.md");
    seed(&pool, &envelope(&missing)).await;
    let storage = Storage::new(temp.path());
    migration::migrate(&pool, &storage).await.unwrap();
    let draft =
        serde_json::to_value(storage.get_draft(&pool, BLUEPRINT.into()).await.unwrap()).unwrap();
    assert_eq!(draft["storageState"], "draft");
    assert!(draft["diagnostics"]
        .to_string()
        .contains("Missing declared resource"));
    assert!(storage
        .freeze(&pool, BLUEPRINT.into(), 5, None, None)
        .await
        .is_err());
    let mut collision = editor("Annex collides with generated manifest");
    collision.source = collision
        .source
        .replace("./notes/étude.md?x=1#title", "agsdl.json");
    collision
        .annexes
        .insert("agsdl.json".into(), "original authored resource".into());
    let collided = storage
        .save_draft(&pool, BLUEPRINT.into(), 5, collision)
        .await
        .unwrap();
    assert!(serde_json::to_value(collided).unwrap()["diagnostics"]
        .to_string()
        .contains("Missing declared resource agsdl.json"));
    assert!(storage
        .freeze(&pool, BLUEPRINT.into(), 6, None, None)
        .await
        .is_err());
    storage
        .save_draft(&pool, BLUEPRINT.into(), 6, editor("Repaired"))
        .await
        .unwrap();
    storage
        .freeze(&pool, BLUEPRINT.into(), 7, None, None)
        .await
        .unwrap();
}

#[tokio::test]
async fn executable_archive_members_survive_adaptation_and_freeze_without_unix_modes() {
    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    seed(&pool, &envelope(&editor("Executable"))).await;
    let storage = Storage::new(temp.path());
    migration::migrate(&pool, &storage).await.unwrap();

    let member = "agents/assets/résumé.md";
    let original_artifact = storage.artifact_path(&draft_artifact(&pool).await);
    let sidecar = original_artifact.join(super::storage::AUTHORING);
    let mut authoring: Value = serde_json::from_slice(&fs::read(&sidecar).unwrap()).unwrap();
    authoring["executablePaths"] = json!([member]);
    fs::write(&sidecar, serde_json::to_vec(&authoring).unwrap()).unwrap();
    storage
        .freeze(&pool, BLUEPRINT.into(), 5, None, None)
        .await
        .unwrap();
    let original = storage
        .open_archive(&version_artifact(&pool, 8).await)
        .unwrap();
    assert!(
        original
            .members()
            .find(|file| file.path == member)
            .unwrap()
            .executable
    );
    drop(original);

    let draft = storage
        .adapt_version(&pool, key(8), "project".into(), "Adapted".into())
        .await
        .unwrap();
    let view = serde_json::to_value(draft).unwrap();
    let adapted = view["id"].as_str().unwrap();
    let row = index::draft_row(&pool, adapted).await.unwrap();
    let artifact = Artifact::from_row(&row, "id").unwrap();
    let path = storage.artifact_path(&artifact);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path.join(PROJECT).join(member),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let opened = argentic_runtime::source::OpenedSource::open_path(&path.join(PROJECT)).unwrap();
    assert!(
        !opened
            .selected_files()
            .unwrap()
            .find(|file| file.path == member)
            .unwrap()
            .executable
    );
    drop(opened);

    storage
        .freeze(&pool, adapted.into(), 1, None, None)
        .await
        .unwrap();
    storage
        .save_draft(&pool, adapted.into(), 1, editor("Edited"))
        .await
        .unwrap();
    storage
        .freeze(
            &pool,
            adapted.into(),
            2,
            None,
            Some(editor("Edited at freeze")),
        )
        .await
        .unwrap();
    for number in [1, 2] {
        let version = VersionKey {
            blueprint_id: adapted.into(),
            number,
        };
        let row = index::version_row(&pool, &version).await.unwrap();
        let artifact = Artifact::from_row(&row, "blueprint_id").unwrap();
        let archive = storage.open_archive(&artifact).unwrap();
        assert!(
            archive
                .members()
                .find(|file| file.path == member)
                .unwrap()
                .executable
        );
    }
}
