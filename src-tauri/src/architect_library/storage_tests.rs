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
    // BeforeCommit retained a whole plan. A retry can finish even if every
    // attempted artifact publication would fail.
    let no_publication = Storage::new(data).with_failure(Failure::BeforePublish);
    assert!(migration::migrate(&pool, &no_publication).await.unwrap());
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
    let mut malformed = editor("Malformed intermediate source");
    malformed.source = "{malformed".into();
    storage
        .save_draft(&pool, adapted.into(), 1, malformed)
        .await
        .unwrap();
    let recovery = index::draft_row(&pool, adapted).await.unwrap();
    let recovery = Artifact::from_row(&recovery, "id").unwrap();
    assert_eq!(recovery.state, StorageState::Recovery);
    storage.validate_artifact(&recovery, None).unwrap();

    storage
        .save_draft(&pool, adapted.into(), 2, editor("Repaired"))
        .await
        .unwrap();
    storage
        .freeze(
            &pool,
            adapted.into(),
            3,
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

fn batch(value: serde_json::Value) -> crate::architect_library::project_editor::EditBatch {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn file_batches_edit_migrated_projects_and_hold_versions_read_only() {
    use crate::architect_library::project_editor::{ProjectFile, ProjectTarget, TEXT_LIMIT};

    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    seed(&pool, &envelope(&editor("Reviews"))).await;
    let storage = Storage::new(temp.path());
    migration::migrate(&pool, &storage).await.unwrap();
    let original = storage.open_draft_project(&pool, BLUEPRINT).await.unwrap();
    let graph = original.project.projection.unwrap();
    let agent = &graph.origins["/agents/reviewer"];
    let agent_path = agent.file.clone();
    assert_eq!(agent.pointer, "");
    assert_ne!(agent_path, super::project::MANIFEST);
    let previous_agent = storage
        .read_project_file(
            &pool,
            ProjectTarget::Draft {
                blueprint_id: BLUEPRINT.into(),
                revision: 5,
            },
            &agent_path,
        )
        .await
        .unwrap();
    let ProjectFile::Text { text, .. } = previous_agent.content else {
        panic!("agent is text")
    };

    let invalid = json!({ "files": [
        { "kind": "write", "path": agent_path, "text": "{bad" },
        { "kind": "write", "path": "new.txt", "text": "Bonjour" },
    ] });
    let preview = storage
        .edit_project(&pool, BLUEPRINT, 5, batch(invalid.clone()), false)
        .await
        .unwrap();
    assert_eq!(preview.revision, 5);
    assert!(preview.projection.is_none());
    assert_eq!(
        preview.diagnostics[0].file.as_deref(),
        Some(agent_path.as_str())
    );
    assert_eq!(preview.diagnostics[0].code, "PROJECT");
    let persisted = storage.open_draft_project(&pool, BLUEPRINT).await.unwrap();
    assert!(persisted.project.projection.is_some());
    assert!(!persisted
        .project
        .files
        .iter()
        .any(|file| file.path == "new.txt"));

    let saved = storage
        .edit_project(&pool, BLUEPRINT, 5, batch(invalid), true)
        .await
        .unwrap();
    assert_eq!(saved.revision, 6);
    assert!(saved.projection.is_none());
    assert!(storage
        .freeze(&pool, BLUEPRINT.into(), 6, None, None)
        .await
        .is_err());
    assert!(storage
        .read_project_file(
            &pool,
            ProjectTarget::Draft {
                blueprint_id: BLUEPRINT.into(),
                revision: 5,
            },
            &agent_path
        )
        .await
        .is_err());

    let fixed = json!({ "files": [
        { "kind": "write", "path": agent_path, "text": text },
        { "kind": "remove", "path": "new.txt" },
    ], "settings": { "hiddenAgentIds": ["reviewer"], "entryMessageHint": "Review the code" } });
    let saved = storage
        .edit_project(&pool, BLUEPRINT, 6, batch(fixed), true)
        .await
        .unwrap();
    assert_eq!(saved.revision, 7);
    assert_eq!(saved.projection.unwrap().source, graph.source);
    assert!(!saved.files.iter().any(|file| file.path == "new.txt"));

    let over = json!({ "files": [{ "kind": "write", "path": "oversized.txt", "text": "x".repeat(TEXT_LIMIT + 1) }] });
    for save in [false, true] {
        let error = storage
            .edit_project(&pool, BLUEPRINT, 7, batch(over.clone()), save)
            .await
            .unwrap_err();
        let crate::db::DbError::Architect(error) = error else {
            panic!("{error:?}")
        };
        assert_eq!(error.diagnostic().code, "EDITOR_LIMIT");
    }

    let frozen = storage
        .freeze(&pool, BLUEPRINT.into(), 7, None, None)
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(frozen).unwrap()["number"], 8);
    let version = storage.open_version_project(&pool, &key(8)).await.unwrap();
    assert_eq!(
        version.project.settings.entry_message_hint.as_deref(),
        Some("Review the code")
    );
    let read = storage
        .read_project_file(&pool, ProjectTarget::Version { key: key(8) }, &agent_path)
        .await
        .unwrap();
    assert_eq!(read.revision, 7);
    assert!(matches!(read.content, ProjectFile::Text { text: frozen, .. } if frozen == text));
    let copy = storage
        .adapt_version(&pool, key(8), "project".into(), "Adapted".into())
        .await
        .unwrap();
    storage
        .edit_project(
            &pool,
            &copy.summary.id,
            1,
            batch(json!({
                "files": [], "settings": { "hiddenAgentIds": [], "entryMessageHint": null }
            })),
            true,
        )
        .await
        .unwrap();
    let origin = storage.open_version_project(&pool, &key(8)).await.unwrap();
    assert_eq!(origin.project.settings.hidden_agent_ids, ["reviewer"]);
    assert_eq!(
        origin.project.settings.entry_message_hint.as_deref(),
        Some("Review the code")
    );
}

#[tokio::test]
async fn import_and_exports_share_staged_bytes_and_keep_opaque_files_native() {
    use crate::architect_library::{
        imports,
        project_editor::{ProjectFile, ProjectTarget, TEXT_LIMIT},
    };

    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    fs::create_dir(&data).unwrap();
    let pool = create_pool(&data.join("macro.db")).await.unwrap();
    seed(&pool, &envelope(&editor("Reviews"))).await;
    let storage = Storage::new(&data);
    migration::migrate(&pool, &storage).await.unwrap();

    let folder = temp.path().join("import-project");
    fs::create_dir_all(folder.join("skill")).unwrap();
    let manifest = folder.join("agsdl.json");
    fs::write(&manifest, r#"{"projectFormat":"agsdl-project-1","contract":"agsdl-0.4.0","id":"example","title":"Staged","agents":{},"skills":{"review":{"uri":"skill/SKILL.md"}}}"#).unwrap();
    fs::write(
        folder.join("skill/SKILL.md"),
        b"---\nname: review\ndescription: Review.\n---\n",
    )
    .unwrap();
    fs::write(folder.join("skill/binary"), [0xff, 0x00]).unwrap();
    fs::write(folder.join("skill/oversized"), vec![b'x'; TEXT_LIMIT + 1]).unwrap();
    fs::write(folder.join("skill/boundary"), vec![b'x'; TEXT_LIMIT]).unwrap();

    let preview = imports::inspect(data.clone(), &manifest).unwrap();
    assert_eq!(preview.preview.title.as_deref(), Some("Staged"));
    fs::write(&manifest, b"unrelated new bytes").unwrap();
    let claim = imports::take(&data, preview.handle).unwrap();
    assert!(imports::take(&data, preview.handle).is_err());
    assert!(storage
        .import_project(&pool, "project", &"x".repeat(1025), claim.candidate())
        .await
        .is_err());
    drop(claim);
    let claim = imports::take(&data, preview.handle).unwrap();
    let imported = storage
        .import_project(&pool, "project", "Imported folder", claim.candidate())
        .await
        .unwrap();
    claim.commit();
    assert!(imports::take(&data, preview.handle).is_err());
    let id = imported.draft.summary.id;
    assert!(imported.version.is_none());
    let revision = imported.draft.project.revision;
    let projection = imported.draft.project.projection.unwrap();
    assert!(projection.source.contains("Staged"));
    let error = storage
        .edit_project(
            &pool,
            &id,
            revision,
            batch(json!({"files": [{"kind": "remove", "path": "skill/boundary"}]})),
            true,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("EDITOR_LIMIT"));

    for path in ["skill/binary", "skill/oversized"] {
        let target = ProjectTarget::Draft {
            blueprint_id: id.clone(),
            revision,
        };
        let file = storage
            .read_project_file(&pool, target, path)
            .await
            .unwrap()
            .content;
        match path {
            "skill/binary" => assert!(matches!(file, ProjectFile::Binary { .. })),
            _ => assert!(matches!(file, ProjectFile::Oversized { .. })),
        }
        assert!(storage
            .edit_project(
                &pool,
                &id,
                revision,
                batch(json!({
                    "files": [{ "kind": "write", "path": path, "text": "replace" }]
                })),
                true
            )
            .await
            .is_err());
    }

    let exported = temp.path().join("exported-project");
    let revision = storage
        .edit_project(
            &pool,
            &id,
            revision,
            batch(json!({"files": [{"kind": "write", "path": "unreferenced.md", "text": "Draft-only notes"}]})),
            true,
        )
        .await
        .unwrap()
        .revision;
    assert_eq!(
        storage
            .export_project(
                &pool,
                ProjectTarget::Draft {
                    blueprint_id: id.clone(),
                    revision
                },
                &exported
            )
            .await
            .unwrap(),
        6
    );
    assert_eq!(
        fs::read_to_string(exported.join("unreferenced.md")).unwrap(),
        "Draft-only notes"
    );
    let exported_preview = imports::inspect(data.clone(), &exported).unwrap();
    assert_eq!(
        exported_preview.preview.staged_sha256,
        preview.preview.staged_sha256
    );
    imports::discard(&data, exported_preview.handle);

    storage
        .freeze(&pool, id.clone(), revision, None, None)
        .await
        .unwrap();
    let key = VersionKey {
        blueprint_id: id,
        number: 1,
    };
    let exported_version = temp.path().join("exported-version");
    assert_eq!(
        storage
            .export_project(
                &pool,
                ProjectTarget::Version { key: key.clone() },
                &exported_version
            )
            .await
            .unwrap(),
        5
    );
    assert!(!exported_version.join("unreferenced.md").exists());
    let archive = temp.path().join("first.agsdl");
    storage
        .export_version_archive(&pool, &key, &archive)
        .await
        .unwrap();
    let bytes = fs::read(&archive).unwrap();
    let staged = imports::inspect(data.clone(), &archive).unwrap();
    fs::remove_file(&archive).unwrap();
    let claim = imports::take(&data, staged.handle).unwrap();
    let imported = storage
        .import_project(&pool, "project", "Imported archive", claim.candidate())
        .await
        .unwrap();
    claim.commit();
    assert!(imported.version.is_some());
    assert_eq!(imported.draft.project.settings, Default::default());
    let key = VersionKey {
        blueprint_id: imported.draft.summary.id,
        number: 1,
    };
    let copy = temp.path().join("copy.agsdl");
    storage
        .export_version_archive(&pool, &key, &copy)
        .await
        .unwrap();
    assert_eq!(fs::read(copy).unwrap(), bytes);
    let read = storage
        .read_project_file(&pool, ProjectTarget::Version { key }, "skill/binary")
        .await
        .unwrap();
    assert!(matches!(read.content, ProjectFile::Binary { .. }));
}

#[tokio::test]
async fn startup_enables_project_opening_for_a_profile_created_by_step_one_writers() {
    use crate::legacy_agsdl_import::{migrate_profile, LegacyImportStatus, LegacyLocalStorage};
    let app_data = tempfile::tempdir().unwrap();
    let path = app_data.path().join("macro.db");
    let pool = create_pool(&path).await.unwrap();
    migration::startup(&pool, app_data.path()).await.unwrap();
    assert!(!index::is_current(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap());

    let project = db::create_project(&pool, "Step One".into()).await.unwrap();
    let project_id = serde_json::to_value(project).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let source = r#"{"contract":"agsdl-0.4.0","id":"first-system","title":"Step One","agents":{"reviewer":{"harness":"codex","permissions":"read-only","instructions":"Review the changes."}}}"#;
    let draft = db::create_blueprint(
        &pool,
        project_id,
        "Blueprint".into(),
        Document {
            source: source.into(),
            annexes: Default::default(),
            metadata: Default::default(),
        },
    )
    .await
    .unwrap();
    let id = draft.summary.id;
    db::save_version(&pool, id.clone(), 1, Some("Step one version".into()), None)
        .await
        .unwrap();
    let import = migrate_profile(
        &pool,
        Ok(Vec::new()),
        None,
        LegacyLocalStorage::NotApplicable,
    )
    .await
    .unwrap();
    assert_eq!(import.status, LegacyImportStatus::Complete);
    pool.close().await;

    let pool = create_pool(&path).await.unwrap();
    migration::startup(&pool, app_data.path()).await.unwrap();
    let storage = Storage::new(app_data.path());
    let draft = storage.open_draft_project(&pool, &id).await.unwrap();
    let draft_project = draft.project.projection.unwrap();
    assert_eq!(draft.project.revision, 1);
    assert_eq!(draft_project.origins["/agents/reviewer"].pointer, "");
    assert!(draft_project.source.contains("Review the changes."));
    let version = storage
        .open_version_project(
            &pool,
            &VersionKey {
                blueprint_id: id,
                number: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        version.project.projection.unwrap().source,
        draft_project.source
    );
    assert_eq!(
        serde_json::to_value(version.summary).unwrap()["note"],
        "Step one version"
    );
}

#[tokio::test]
async fn schema_hint_survives_migration_without_blocking_archive_or_freeze() {
    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    let mut document = editor("Schema hint");
    let legacy_schema =
        "https://raw.githubusercontent.com/Andrologic/AgSDL/v0.3.0/schema/agsdl.schema.json";
    document.source =
        document
            .source
            .replacen('{', &format!(r#"{{"$schema":"{legacy_schema}","#), 1);
    let raw = envelope(&document);
    seed(&pool, &raw).await;
    historical(&pool, 1, 3, &raw).await;
    let storage = Storage::new(temp.path());
    migration::migrate(&pool, &storage).await.unwrap();

    let draft = storage.open_draft_project(&pool, BLUEPRINT).await.unwrap();
    assert!(draft.project.projection.is_some());
    let archive = storage
        .open_archive(&version_artifact(&pool, 1).await)
        .unwrap();
    let manifest = archive
        .members()
        .find(|file| file.path == "agsdl.json")
        .unwrap();
    let value: Value = serde_json::from_slice(manifest.bytes).unwrap();
    assert_eq!(value["$schema"], legacy_schema.replace("v0.3.0", "v0.4.0"));
    storage
        .freeze(&pool, BLUEPRINT.into(), 5, None, None)
        .await
        .unwrap();

    let retained = temp.path().join("original.json");
    storage
        .export_original(&pool, BLUEPRINT.into(), 3, Some(1), &retained)
        .await
        .unwrap();
    assert_eq!(fs::read(retained).unwrap(), raw.as_bytes());
}

#[tokio::test]
async fn migration_normalizes_interior_uri_separators_but_refuses_rooted_paths() {
    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    let mut document = editor("Relative URI");
    document.source = document.source.replace(
        "./notes/étude.md?x=1#title",
        "notes//%C3%A9tude.md?x=1#title",
    );
    let raw = envelope(&document);
    seed(&pool, &raw).await;
    historical(&pool, 1, 2, &raw).await;
    document.source = document.source.replace("notes//", "%2Fnotes//");
    historical(&pool, 2, 3, &envelope(&document)).await;
    let storage = Storage::new(temp.path());
    migration::migrate(&pool, &storage).await.unwrap();

    let version = storage
        .open_archive(&version_artifact(&pool, 1).await)
        .unwrap();
    assert!(version
        .source()
        .authored_json()
        .contains("notes/%C3%A9tude.md?x=1#title"));
    assert!(version
        .members()
        .any(|file| file.path == "notes/étude.md" && file.bytes == "# Étude\r\n".as_bytes()));
    assert_eq!(
        version_artifact(&pool, 2).await.state,
        StorageState::Recovery
    );
}

#[tokio::test]
async fn editor_inventory_limit_routes_migrated_draft_to_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    let mut document = editor("Large step-one draft");
    for index in 0..8192 {
        document
            .annexes
            .insert(format!("extras/{index}.txt"), "x".into());
    }
    let raw = envelope(&document);
    seed(&pool, &raw).await;
    let storage = Storage::new(temp.path());
    migration::migrate(&pool, &storage).await.unwrap();
    let draft = storage.open_draft_project(&pool, BLUEPRINT).await.unwrap();
    assert_eq!(draft.storage_state, "recovery");
    assert!(draft
        .project
        .diagnostics
        .iter()
        .any(|issue| issue.message.contains("editor inventory limit")));
    let retained = temp.path().join("large-original.json");
    storage
        .export_original(
            &pool,
            BLUEPRINT.into(),
            draft.project.revision,
            None,
            &retained,
        )
        .await
        .unwrap();
    assert_eq!(fs::read(retained).unwrap(), raw.as_bytes());
    let repair = storage
        .adapt_recovery_draft(
            &pool,
            BLUEPRINT,
            draft.project.revision,
            "project",
            "Repair",
        )
        .await
        .unwrap();
    assert_eq!(repair.storage_state, "draft");
    assert!(repair.project.projection.is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn startup_recovers_overlong_legacy_paths_and_migrates_other_rows() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("macro.db");
    let pool = create_pool(&path).await.unwrap();
    let valid = editor("Valid historical version");
    let mut overlong = valid.clone();
    let annex = format!(
        "{}/{}.md",
        vec!["a".repeat(250); 16].join("/"),
        "b".repeat(60)
    );
    assert_eq!(annex.len(), 4079);
    assert!(super::editor_document::portable_path(&annex));
    overlong
        .annexes
        .insert(annex.clone(), "original bytes".into());
    let raw = envelope(&overlong);
    seed(&pool, &raw).await;
    historical(&pool, 1, 3, &raw).await;
    historical(&pool, 2, 4, &envelope(&valid)).await;
    pool.close().await;

    let pool = create_pool(&path).await.unwrap();
    migration::startup(&pool, temp.path()).await.unwrap();
    let storage = Storage::new(temp.path());
    for recovery in [
        draft_artifact(&pool).await,
        version_artifact(&pool, 1).await,
    ] {
        assert_eq!(recovery.state, StorageState::Recovery);
        let root = storage.artifact_path(&recovery);
        assert_eq!(fs::read_to_string(root.join(ORIGINAL)).unwrap(), raw);
        let diagnostics: Vec<String> =
            serde_json::from_slice(&fs::read(root.join("diagnostics.json")).unwrap()).unwrap();
        assert!(diagnostics
            .iter()
            .any(|issue| issue.contains(&annex) && issue.contains("filesystem path limit")));
    }
    assert_eq!(
        version_artifact(&pool, 2).await.state,
        StorageState::Archive
    );
    migration::startup(&pool, temp.path()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn architect_cutover_releases_the_writer_during_publication() {
    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    seed(&pool, &envelope(&editor("Draft"))).await;
    let runtime = tokio::runtime::Handle::current();
    let storage = Storage::new(temp.path());
    assert!(
        migration::migrate_with_progress(&pool, &storage, |progress| {
            if progress.completed == 0 {
                return;
            }
            tokio::task::block_in_place(|| {
                runtime.block_on(async {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        sqlx::query(
                            "INSERT INTO app_settings (key,value_json,updated_at)
                         VALUES ('parallel-chat-write','true','2026-01-01')",
                        )
                        .execute(&pool),
                    )
                    .await
                    .expect("cutover blocked a concurrent SQLite writer")
                    .unwrap();
                });
            });
        })
        .await
        .unwrap()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn migration_checks_the_longer_published_draft_path_before_cutover() {
    use std::os::unix::ffi::OsStrExt;

    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    let storage = Storage::new(temp.path());
    let base = storage
        .artifact_path(&Artifact {
            blueprint_id: BLUEPRINT.into(),
            id: uuid::Uuid::nil(),
            state: StorageState::Draft,
            sha256: None,
        })
        .join(PROJECT);
    let length = libc::PATH_MAX as usize - base.as_os_str().as_bytes().len() - 1;
    let annex: String = (1..=length)
        .map(|index| {
            if (index % 128 == 0 && index < length - 2) || index == length - 1 {
                '/'
            } else {
                'a'
            }
        })
        .collect();
    let mut document = editor("Fits staging only");
    document.annexes.insert(annex.clone(), "preserve".into());
    let staged = storage
        .stage_split(
            super::editor_document::split(document.clone()).unwrap(),
            None,
        )
        .unwrap();
    assert!(staged.root().join(&annex).is_file());
    drop(staged);
    seed(&pool, &envelope(&document)).await;

    migration::startup(&pool, temp.path()).await.unwrap();
    let draft = storage.open_draft_project(&pool, BLUEPRINT).await.unwrap();
    assert_eq!(draft.storage_state, "recovery");
    assert!(draft
        .project
        .diagnostics
        .iter()
        .any(|issue| issue.message.contains(&annex)));
}

#[tokio::test]
async fn migration_keeps_a_skill_with_rejected_members_out_of_frozen_archives() {
    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    let mut document = editor("Colliding skill assets");
    document
        .annexes
        .insert("agents/assets/Guide.txt".into(), "First".into());
    document
        .annexes
        .insert("agents/assets/guide.txt".into(), "Second".into());
    document
        .annexes
        .insert("agents/assets/Readme.txt".into(), "Included".into());
    document
        .annexes
        .insert("agents/assets/readme.txt".into(), "Discarded".into());
    let raw = envelope(&document);
    seed(&pool, &raw).await;
    historical(&pool, 1, 3, &raw).await;
    let storage = Storage::new(temp.path());
    migration::migrate(&pool, &storage).await.unwrap();

    assert_eq!(draft_artifact(&pool).await.state, StorageState::Draft);
    let draft = storage.open_draft_project(&pool, BLUEPRINT).await.unwrap();
    assert!(draft.project.diagnostics.iter().any(|issue| issue
        .message
        .contains("Missing declared skill resource agents/assets/guide.txt")));
    assert!(storage
        .freeze(&pool, BLUEPRINT.into(), 5, None, None)
        .await
        .is_err());
    let root = storage
        .artifact_path(&draft_artifact(&pool).await)
        .join("project");
    let manifest = fs::read_to_string(root.join("agsdl.json")).unwrap();
    let edited = storage.edit_project(&pool, BLUEPRINT, 5, batch(json!({
        "files": [{"kind": "write", "path": "agsdl.json", "text": manifest.replace("Colliding skill assets", "New title")}]
    })), true).await.unwrap();
    assert_eq!(
        edited
            .diagnostics
            .iter()
            .filter(|issue| issue.code == "MIGRATION_RESOURCE")
            .count(),
        2
    );
    assert!(storage
        .freeze(&pool, BLUEPRINT.into(), edited.revision, None, None)
        .await
        .is_err());
    let original_draft = temp.path().join("original-draft.json");
    storage
        .export_original(
            &pool,
            BLUEPRINT.into(),
            edited.revision,
            None,
            &original_draft,
        )
        .await
        .unwrap();
    assert_eq!(fs::read(original_draft).unwrap(), raw.as_bytes());
    let edited = storage.edit_project(&pool, BLUEPRINT, edited.revision, batch(json!({
        "files": [{"kind": "write", "path": "agents/assets/guide-restored.txt", "text": "Second"}]
    })), true).await.unwrap();
    assert_eq!(
        edited
            .diagnostics
            .iter()
            .filter(|issue| issue.code == "MIGRATION_RESOURCE")
            .count(),
        1
    );
    assert!(storage
        .freeze(&pool, BLUEPRINT.into(), edited.revision, None, None)
        .await
        .is_err());
    let edited = storage
        .edit_project(
            &pool,
            BLUEPRINT,
            edited.revision,
            batch(json!({
                "files": [], "discardMigrationFiles": ["agents/assets/readme.txt"]
            })),
            true,
        )
        .await
        .unwrap();
    assert!(!edited
        .diagnostics
        .iter()
        .any(|issue| issue.code == "MIGRATION_RESOURCE"));
    storage
        .freeze(&pool, BLUEPRINT.into(), edited.revision, None, None)
        .await
        .unwrap();
    let frozen = storage
        .open_archive(&version_artifact(&pool, 8).await)
        .unwrap();
    assert!(frozen.members().any(
        |member| member.path == "agents/assets/guide-restored.txt" && member.bytes == b"Second"
    ));
    assert_eq!(
        version_artifact(&pool, 1).await.state,
        StorageState::Recovery
    );
    let retained = temp.path().join("skill-original.json");
    storage
        .export_original(&pool, BLUEPRINT.into(), 3, Some(1), &retained)
        .await
        .unwrap();
    assert_eq!(fs::read(retained).unwrap(), raw.as_bytes());
}

#[cfg(unix)]
#[tokio::test]
async fn managed_reads_and_publication_refuse_existing_buckets_below_symlinked_ancestors() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
    seed(&pool, &envelope(&editor("Linked buckets"))).await;
    let storage = Storage::new(temp.path());
    migration::migrate(&pool, &storage).await.unwrap();
    storage
        .freeze(&pool, BLUEPRINT.into(), 5, None, None)
        .await
        .unwrap();

    let version = version_artifact(&pool, 8).await;
    let blueprints = temp.path().join("architect-library/blueprints");
    let outside = temp.path().join("other-tree");
    fs::rename(&blueprints, &outside).unwrap();
    symlink(&outside, &blueprints).unwrap();
    assert!(storage
        .artifact_path(&version)
        .join(VERSION_FILENAME)
        .is_file());

    assert!(storage.open_archive(&version).is_err());
    assert!(storage.open_draft_project(&pool, BLUEPRINT).await.is_err());
    assert!(storage
        .freeze(&pool, BLUEPRINT.into(), 5, None, None)
        .await
        .is_err());
    assert!(storage
        .create_project_draft(&pool, "project", "Other")
        .await
        .is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    assert_eq!(
        db::list_versions(&pool, BLUEPRINT.into())
            .await
            .unwrap()
            .len(),
        1
    );

    fs::remove_file(blueprints).unwrap();
    fs::rename(outside, temp.path().join("architect-library/blueprints")).unwrap();
    assert!(storage.open_archive(&version).is_ok());
}
