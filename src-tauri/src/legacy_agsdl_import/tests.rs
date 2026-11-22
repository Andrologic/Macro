use super::*;
use serde_json::json;
use std::{fs, path::Path};

const EXACT_SOURCE: &str = "{\r\n  \"contract\": \"agsdl-0.3.0\", \"opaque\":900719925474099312345, \"number\":1e999\r\n}\n";

fn put(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value.to_string()).unwrap();
}

fn blueprint(id: &str) -> Value {
    json!({
        "id": id, "title": "Contrôle qualité", "status": "draft",
        "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
        "agsdl": {
            "revision": 3, "source": EXACT_SOURCE,
            "annexes": {"checks/règles.json": "{ \"rule\": 9007199254740993 }\r\n"},
            "design": {
                "kind": "blueprint", "purpose": "Vérifier", "context": "Une édition",
                "origin": {"planId": "earlier-system", "name": "Brouillon", "revision": 2}
            },
            "display": {"title": "Contrôle qualité", "cards": {"root": {"title": "Révision"}}}
        }
    })
}

fn store(root: &Path, branch: &str, record: &Value) -> PathBuf {
    let path = root
        .join("branches")
        .join(branch)
        .join("plans")
        .join(record["id"].as_str().unwrap())
        .join("plan.json");
    put(&path, record);
    path
}

fn commit(repo: &git2::Repository, reference: &str, paths: &[&str]) -> git2::Oid {
    let mut index = repo.index().unwrap();
    for path in paths {
        index.add_path(Path::new(path)).unwrap();
    }
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let signature = git2::Signature::now("Fixture", "fixture@example.invalid").unwrap();
    repo.commit(
        Some(reference),
        &signature,
        &signature,
        "Metadata",
        &tree,
        &[],
    )
    .unwrap()
}

fn metadata_checkout(repo: &git2::Repository) -> PathBuf {
    let oid = commit(repo, "HEAD", &[]);
    let reference = repo
        .reference("refs/heads/@macro", oid, false, "Fixture")
        .unwrap();
    let path = repo.path().join(crate::git::MACRO_WORKTREE_DIR_NAME);
    repo.worktree(
        crate::git::MACRO_WORKTREE_NAME,
        &path,
        Some(git2::WorktreeAddOptions::new().reference(Some(&reference))),
    )
    .unwrap();
    path
}

fn profile(workspace: &Path) -> LegacyProfile {
    LegacyProfile {
        workspace_paths: vec![workspace.to_path_buf()],
        projects: Vec::new(),
        local_storage: LegacyLocalStorage::NotApplicable,
        conversation_links: Vec::new(),
    }
}

struct MixedProfile {
    _dir: tempfile::TempDir,
    input: LegacyProfile,
    workspace: PathBuf,
}

fn mixed_profile() -> MixedProfile {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace").join(".macro");
    let project = dir.path().join("direct");
    let git_project = dir.path().join("git-project");
    let repo = git2::Repository::init(&git_project).unwrap();
    let worktree = metadata_checkout(&repo);
    put(
        &workspace.join("workspace.json"),
        &json!({
            "standaloneProjects": [{"id": "direct", "path": project, "name": "Essais"}],
            "project_groups": [{"projects": [{"id": "repo", "path": git_project, "name": "Exemples"}]}]
        }),
    );
    let mut archived = blueprint("shared");
    archived["status"] = json!("archived");
    archived["archivedAt"] = json!("2026-01-02T00:00:00Z");
    archived["archivedFromStatus"] = json!("draft");
    archived["projectId"] = json!("direct");
    archived["revision"] = json!(8);
    let first = store(&workspace, "main", &archived);
    put(
        &first.with_file_name("manifest.json"),
        &json!({
            "planId": "shared", "conversation": {"conversationId": "design-conversation"}
        }),
    );
    fs::write(
        first.with_file_name("chat.jsonl"),
        "{\"role\":\"assistant\",\"content\":\"Révisé\"}\r\n",
    )
    .unwrap();
    let mut duplicate = archived.clone();
    duplicate["revision"] = json!(9);
    duplicate["updatedAt"] = json!("2026-01-02T00:00:00Z");
    store(&project.join(".macro"), "main", &duplicate);
    let mut divergent = archived;
    divergent["agsdl"]["annexes"]["checks/règles.json"] = json!("other version");
    store(&worktree.join(".macro"), "main", &divergent);
    let native = blueprint("no-index");
    store(&worktree, "feature/plans", &native);
    let mut older = blueprint("v020");
    older["agsdl"]["source"] = json!("{\"contract\":\"agsdl-0.2.0\"}");
    store(&workspace, "main", &older);
    store(&workspace, "main", &blueprint("removed"));
    store(
        &workspace,
        "main",
        &json!({"id": "software", "nodes": [{"id": "build"}]}),
    );
    store(
        &workspace,
        "main",
        &json!({"id": "hard-deleted", "nodes": []}),
    );
    fs::remove_dir_all(workspace.join("branches/main/plans/hard-deleted")).unwrap();
    put(
        &workspace.join("branches/main/plans/index.json"),
        &json!({
            "version": 2, "plans": [{"id": "shared"}, {"id": "software"}, {"id": "v020"}]
        }),
    );
    let local = BTreeMap::from([
        (
            "macro_architect_plan_index:main".into(),
            json!({
                "version": 3, "plans": [
                    {"id": "removed", "status": "deleted", "updatedAt": "2026-02-01T00:00:00Z"},
                    {"id": "homonym"}
                ]
            })
            .to_string(),
        ),
        (
            "macro_architect_plan:main:homonym".into(),
            blueprint("homonym").to_string(),
        ),
        (
            "macro_architect_plan:main:builtin-demo".into(),
            blueprint("builtin:demo").to_string(),
        ),
    ]);
    MixedProfile {
        _dir: dir,
        input: LegacyProfile {
            workspace_paths: vec![workspace.parent().unwrap().to_owned()],
            projects: Vec::new(),
            local_storage: LegacyLocalStorage::Snapshot(local),
            conversation_links: vec![LegacyConversationLink {
                plan_id: "homonym".into(),
                target_branch: "main".into(),
                conversation_id: "sqlite-conversation".into(),
            }],
        },
        workspace,
    }
}

#[test]
fn discovers_a_mixed_profile_without_rewriting_its_historical_layout() {
    let profile = mixed_profile();
    let index_path = profile.workspace.join("branches/main/plans/index.json");
    let index_before = fs::read(&index_path).unwrap();
    let discovery = discover_legacy_agsdl(&profile.input);
    assert!(discovery.issues.is_empty(), "{:?}", discovery.issues);
    assert_eq!(discovery.blueprints.len(), 4);
    let replicas: Vec<_> = discovery
        .blueprints
        .iter()
        .filter(|item| item.plan_id == "shared")
        .collect();
    assert_eq!(replicas.len(), 2);
    let identical = replicas
        .iter()
        .find(|item| item.origins.len() == 2)
        .unwrap();
    assert_eq!(identical.project_name, "Essais");
    assert_eq!(identical.document["source"], EXACT_SOURCE);
    assert_eq!(
        identical.document["annexes"]["checks/règles.json"],
        "{ \"rule\": 9007199254740993 }\r\n"
    );
    assert_eq!(
        identical.document["design"]["origin"]["planId"],
        "earlier-system"
    );
    assert_eq!(
        identical.document["display"]["cards"]["root"]["title"],
        "Révision"
    );
    assert_eq!(identical.metadata["status"], "archived");
    assert_eq!(identical.metadata["archivedAt"], "2026-01-02T00:00:00Z");
    assert_eq!(identical.metadata["archivedFromStatus"], "draft");
    assert_eq!(identical.conversation_id(), Some("design-conversation"));
    let wire = identical.destination_input();
    assert_eq!(wire["sourceId"], identical.import_key);
    assert_eq!(wire["sourceProjectId"], "legacy:project:direct");
    assert_eq!(wire["document"]["source"], EXACT_SOURCE);
    assert!(wire["document"].get("revision").is_none());
    assert_eq!(wire["history"]["legacyDocumentRevision"], 3);
    assert_eq!(wire["history"]["status"], "archived");
    assert!(identical
        .origins
        .iter()
        .any(|origin| origin.transcript.as_deref()
            == Some("{\"role\":\"assistant\",\"content\":\"Révisé\"}\r\n")));
    let local = discovery
        .blueprints
        .iter()
        .find(|item| item.plan_id == "homonym")
        .unwrap();
    assert_eq!(local.conversation_id(), Some("sqlite-conversation"));
    assert!(discovery
        .blueprints
        .iter()
        .any(|item| item.branch == "feature/plans" && item.plan_id == "no-index"));
    assert_eq!(fs::read(index_path).unwrap(), index_before);
    assert!(!profile.workspace.parent().unwrap().join(".git").exists());
    assert!(!profile
        ._dir
        .path()
        .join("git-project/.git/macro-metadata-worktree/branches/feature/plans/plans/index.json")
        .exists());
    assert!(!profile
        ._dir
        .path()
        .join("git-project/.git/macro-metadata-worktree/branches/main")
        .exists());
}

#[test]
fn reads_the_local_macro_ref_without_creating_a_checkout() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let path = ".macro/branches/release/2026/plans/committed/plan.json";
    put(&dir.path().join(path), &blueprint("committed"));
    let oid = commit(&repo, "refs/heads/@macro", &[path]);
    fs::remove_dir_all(dir.path().join(".macro")).unwrap();

    let discovery = discover_legacy_agsdl(&LegacyProfile {
        workspace_paths: vec![dir.path().to_owned()],
        projects: Vec::new(),
        local_storage: LegacyLocalStorage::NotApplicable,
        conversation_links: Vec::new(),
    });
    assert!(discovery.issues.is_empty(), "{:?}", discovery.issues);
    assert_eq!(discovery.blueprints.len(), 1);
    assert_eq!(discovery.blueprints[0].branch, "release/2026");
    assert!(!repo
        .path()
        .join(crate::git::MACRO_WORKTREE_DIR_NAME)
        .exists());
    assert!(!dir.path().join(".macro").exists());

    let empty = repo.path().join(crate::git::MACRO_WORKTREE_DIR_NAME);
    fs::create_dir(&empty).unwrap();
    let fallback = discover_legacy_agsdl(&profile(dir.path()));
    assert!(fallback.issues.is_empty(), "{:?}", fallback.issues);
    assert_eq!(fallback.blueprints[0].plan_id, "committed");
    assert_eq!(fs::read_dir(empty).unwrap().count(), 0);

    repo.reference("refs/heads/other", oid, false, "Fixture")
        .unwrap();
    repo.reference_symbolic("refs/heads/@macro", "refs/heads/other", true, "Fixture")
        .unwrap();
    let rejected = discover_legacy_agsdl(&profile(dir.path()));
    assert!(rejected.blueprints.is_empty());
    assert_eq!(rejected.issues.len(), 1);
}

#[test]
fn resolves_registry_paths_from_the_workspace_for_disk_and_git_metadata() {
    for layout in ["direct", "checkout", "commit"] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path();
        let repo = git2::Repository::init(workspace).unwrap();
        let registry = if layout == "checkout" {
            metadata_checkout(&repo).join("workspace.json")
        } else {
            workspace.join(".macro/workspace.json")
        };
        put(
            &registry,
            &json!({
                "standaloneProjects": [{"id": "app", "path": "projects/app", "name": "Application"}],
                "project_groups": [{"projects": [
                    {"id": "tools", "path": "projects\\tools", "name": "Outils"}
                ]}]
            }),
        );
        if layout == "commit" {
            commit(&repo, "refs/heads/@macro", &[".macro/workspace.json"]);
            fs::remove_dir_all(workspace.join(".macro")).unwrap();
        }
        for id in ["app", "tools", "extra"] {
            let mut plan = blueprint(id);
            plan["projectId"] = json!(id);
            store(
                &workspace.join("projects").join(id).join(".macro"),
                "main",
                &plan,
            );
        }
        let mut input = profile(workspace);
        input.projects.push(LegacyProject {
            id: "extra".into(),
            path: "projects/extra".into(),
        });
        let discovery = discover_legacy_agsdl(&input);
        assert!(
            discovery.issues.is_empty(),
            "{layout}: {:?}",
            discovery.issues
        );
        let names: BTreeMap<_, _> = discovery
            .blueprints
            .iter()
            .map(|plan| (plan.plan_id.as_str(), plan.project_name.as_str()))
            .collect();
        assert_eq!(
            names,
            BTreeMap::from([
                ("app", "Application"),
                ("extra", "extra"),
                ("tools", "Outils")
            ])
        );
    }
}

#[test]
fn reads_recoverable_registry_without_promoting_or_repairing_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".macro");
    let primary = root.join("workspace.json");
    let backup = root.join("workspace.json.bak");
    let temporary = root.join(".workspace.json.macro-tmp-complete");
    store(
        &dir.path().join("projects/app/.macro"),
        "main",
        &blueprint("backup"),
    );
    store(
        &dir.path().join("projects/tools/.macro"),
        "main",
        &blueprint("temporary"),
    );
    put(
        &backup,
        &json!({"workspaceRevision": 2, "standaloneProjects": [{"id": "app", "path": "projects/app"}]}),
    );
    let corrupt = b"{invalid";
    fs::write(&primary, corrupt).unwrap();
    let incomplete = root.join(".workspace.json.macro-tmp-incomplete");
    fs::write(&incomplete, corrupt).unwrap();
    let input = profile(dir.path());
    put(
        &incomplete,
        &json!({"workspaceRevision": 10, "plan_nodes": "invalid"}),
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(&incomplete).unwrap().permissions();
        fs::set_permissions(&incomplete, fs::Permissions::from_mode(0)).unwrap();
        if fs::read(&incomplete).is_err() {
            assert!(!discover_legacy_agsdl(&input).issues.is_empty());
        }
        fs::set_permissions(&incomplete, permissions).unwrap();
    }
    let from_backup = discover_legacy_agsdl(&input);
    assert!(from_backup.issues.is_empty(), "{:?}", from_backup.issues);
    assert_eq!(from_backup.blueprints[0].plan_id, "backup");

    put(
        &temporary,
        &json!({"workspaceRevision": 3, "standaloneProjects": [{"id": "tools", "name": "Tools", "path": "projects/tools", "status": "active",
        "created_at": "2026-01-01T00:00:00Z", "metadata": {
            "description": "", "tags": [], "team_members": [], "api_contracts": [], "dependencies": []
        }}]}),
    );
    put(
        &primary,
        &json!({"workspaceRevision": 10, "plan_nodes": "invalid"}),
    );
    let expected_files: BTreeMap<_, _> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (entry.file_name(), fs::read(entry.path()).unwrap())
        })
        .collect();
    let from_temp = discover_legacy_agsdl(&input);
    assert!(from_temp.issues.is_empty(), "{:?}", from_temp.issues);
    assert_eq!(from_temp.blueprints.len(), 1);
    assert_eq!(from_temp.blueprints[0].plan_id, "temporary");
    let files_after = fs::read_dir(&root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (entry.file_name(), fs::read(entry.path()).unwrap())
        })
        .collect();
    assert_eq!(expected_files, files_after);

    put(
        &primary,
        &json!({"workspaceRevision": 3, "standaloneProjects": [{"id": "app", "path": "projects/app", "name": "App", "status": "active", "created_at": "2026-01-01T00:00:00Z",
            "metadata": {"description": "", "tags": [], "team_members": [], "api_contracts": [], "dependencies": []}}]}),
    );
    let from_primary = discover_legacy_agsdl(&input);
    assert!(from_primary.issues.is_empty(), "{:?}", from_primary.issues);
    assert_eq!(from_primary.blueprints[0].plan_id, "backup");

    fs::write(primary, corrupt).unwrap();
    fs::remove_file(temporary).unwrap();
    fs::write(backup, corrupt).unwrap();
    let corrupt = discover_legacy_agsdl(&input);
    assert_eq!(corrupt.issues.len(), 1);
    assert!(corrupt.blueprints.is_empty());
}

#[test]
fn requires_plan_and_manifest_identity_before_using_disk_or_git_transcripts() {
    for committed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path();
        let root = workspace.join(".macro");
        let mut files = Vec::new();
        for (slot, id, branch, manifest) in [
            ("wrong-id", "wrong--id", "feature/plans", json!(null)),
            ("wrong-branch", "wrong-branch", "feature/other", json!(null)),
            (
                "wrong-manifest-branch",
                "wrong-manifest-branch",
                "feature/plans",
                json!({"planId": "wrong-manifest-branch", "targetBranch": "feature/other"}),
            ),
            (
                "wrong-manifest-id",
                "wrong-manifest-id",
                "feature/plans",
                json!({"planId": "unrelated", "targetBranch": "feature/plans"}),
            ),
            (
                "matching--id",
                "matching--id",
                "refs/heads/feature/plans",
                json!({"planId": "matching--id", "targetBranch": "feature/plans"}),
            ),
        ] {
            let stem = format!(".macro/branches/feature/plans/plans/{slot}");
            let mut plan = blueprint(id);
            plan["targetBranch"] = json!(branch);
            let plan_file = format!("{stem}/plan.json");
            put(&workspace.join(&plan_file), &plan);
            files.push(plan_file);
            if !manifest.is_null() {
                let manifest_file = format!("{stem}/manifest.json");
                put(&workspace.join(&manifest_file), &manifest);
                files.push(manifest_file);
            }
            let chat_file = format!("{stem}/chat.jsonl");
            fs::write(workspace.join(&chat_file), slot).unwrap();
            files.push(chat_file);
        }
        let index = ".macro/branches/feature/plans/plans/index.json";
        put(
            &workspace.join(index),
            &json!({
                "plans": [{"id": "matching--id", "status": "deleted", "targetBranch": "feature/other"}]
            }),
        );
        files.push(index.into());
        if committed {
            let repo = git2::Repository::init(workspace).unwrap();
            let paths = files.iter().map(String::as_str).collect::<Vec<_>>();
            commit(&repo, "refs/heads/@macro", &paths);
            fs::remove_dir_all(&root).unwrap();
        }
        let discovery = discover_legacy_agsdl(&profile(workspace));
        assert_eq!(discovery.issues.len(), 5, "{:?}", discovery.issues);
        assert_eq!(discovery.blueprints.len(), 1);
        let valid = &discovery.blueprints[0];
        assert_eq!(valid.plan_id, "matching--id");
        assert_eq!(
            valid.origins.first().unwrap().transcript.as_deref(),
            Some("matching--id")
        );
    }
}

#[test]
fn requires_local_storage_plan_identity_before_using_its_chat_key() {
    let mut local = BTreeMap::new();
    for (slot, id, branch) in [
        ("wrong-id", "wrong--id", "release/demo"),
        ("wrong-branch", "wrong-branch", "main"),
        ("matching--id", "matching--id", "refs/heads/release/demo"),
    ] {
        let mut plan = blueprint(id);
        plan["targetBranch"] = json!(branch);
        local.insert(
            format!("macro_architect_plan:release/demo:{slot}"),
            plan.to_string(),
        );
        local.insert(
            format!("macro_architect_plan_chat:release/demo:{slot}"),
            slot.into(),
        );
    }
    let discovery = discover_legacy_agsdl(&LegacyProfile {
        workspace_paths: Vec::new(),
        projects: Vec::new(),
        local_storage: LegacyLocalStorage::Snapshot(local),
        conversation_links: Vec::new(),
    });
    assert_eq!(discovery.issues.len(), 2, "{:?}", discovery.issues);
    assert_eq!(discovery.blueprints.len(), 1);
    let plan = &discovery.blueprints[0];
    assert_eq!(plan.branch, "release/demo");
    assert_eq!(plan.plan_id, "matching--id");
    assert_eq!(
        plan.origins.first().unwrap().transcript.as_deref(),
        Some("matching--id")
    );
}

#[test]
fn trusts_a_registered_macro_checkout_from_a_linked_project() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path().join("repo")).unwrap();
    let metadata = metadata_checkout(&repo);
    let linked = dir.path().join("linked");
    repo.worktree("linked", &linked, None).unwrap();
    store(&metadata, "main", &blueprint("uncommitted"));

    let discovery = discover_legacy_agsdl(&profile(&linked));
    assert!(discovery.issues.is_empty(), "{:?}", discovery.issues);
    assert_eq!(discovery.blueprints[0].plan_id, "uncommitted");
}

#[test]
fn refuses_nonempty_metadata_without_macro_registration_or_branch() {
    for case in ["folder", "other-registration", "wrong-branch"] {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let path = repo.path().join(crate::git::MACRO_WORKTREE_DIR_NAME);
        match case {
            "other-registration" => {
                commit(&repo, "HEAD", &[]);
                repo.worktree("other", &path, None).unwrap();
            }
            "wrong-branch" => {
                metadata_checkout(&repo);
                let head = repo
                    .path()
                    .join("worktrees")
                    .join(crate::git::MACRO_WORKTREE_NAME)
                    .join("HEAD");
                fs::write(head, "ref: refs/heads/some-other-branch\n").unwrap();
            }
            _ => {}
        }
        let unrelated = store(&path, "main", &blueprint("unrelated"));
        let discovery = discover_legacy_agsdl(&profile(dir.path()));
        assert!(discovery.blueprints.is_empty(), "{case}");
        assert_eq!(discovery.issues.len(), 1, "{case}: {:?}", discovery.issues);
        assert!(unrelated.is_file());
    }
}

#[test]
fn refuses_a_gitfile_which_does_not_belong_to_the_requested_checkout() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path().join("repo")).unwrap();
    let metadata = metadata_checkout(&repo);
    store(&metadata, "main", &blueprint("other-workspace"));
    let linked = dir.path().join("linked");
    repo.worktree("linked", &linked, None).unwrap();
    let unrelated = dir.path().join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    fs::copy(linked.join(".git"), unrelated.join(".git")).unwrap();

    let discovery = discover_legacy_agsdl(&profile(&unrelated));
    assert!(discovery.blueprints.is_empty());
    assert_eq!(discovery.issues.len(), 1);

    let another = git2::Repository::init(dir.path().join("another")).unwrap();
    let commondir = repo.path().join("worktrees/linked/commondir");
    fs::write(&commondir, format!("{}\n", another.path().display())).unwrap();
    let discovery = discover_legacy_agsdl(&profile(&linked));
    assert!(discovery.blueprints.is_empty());
    assert_eq!(discovery.issues.len(), 1);
}

#[cfg(unix)]
#[test]
fn refuses_a_symlinked_dot_git_or_macro_checkout() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path().join("repo")).unwrap();
    let metadata = metadata_checkout(&repo);
    store(&metadata, "main", &blueprint("other-workspace"));
    let unrelated = dir.path().join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    symlink(repo.path(), unrelated.join(".git")).unwrap();

    let discovery = discover_legacy_agsdl(&profile(&unrelated));
    assert!(discovery.blueprints.is_empty());
    assert_eq!(discovery.issues.len(), 1);

    let alternate = git2::Repository::init(dir.path().join("alternate")).unwrap();
    symlink(
        &metadata,
        alternate.path().join(crate::git::MACRO_WORKTREE_DIR_NAME),
    )
    .unwrap();
    let discovery = discover_legacy_agsdl(&profile(alternate.workdir().unwrap()));
    assert!(discovery.blueprints.is_empty());
    assert_eq!(discovery.issues.len(), 1);
}

#[tokio::test]
async fn batch_rollback_and_lost_acknowledgement_reopen_the_right_generation() {
    use crate::db::create_pool;
    let profile = mixed_profile();
    let db = profile._dir.path().join("macro.db");
    let pool = create_pool(&db).await.unwrap();
    // The active root is empty. Only the installed profile's runtime.json
    // leads to the historical registry and its projects.
    let config_root = profile._dir.path().join("config");
    put(
        &config_root.join("runtime.json"),
        &json!({"$schema":"./schemas/v1/runtime.schema.json","schemaVersion":1,
        "defaultWorkspace": profile.workspace.parent().unwrap()}),
    );
    let manager = crate::config::ConfigManager::initialize(config_root)
        .await
        .unwrap();
    let roots = configured_roots(&manager, vec![profile._dir.path().to_owned()]).await;
    assert!(roots
        .as_ref()
        .unwrap()
        .contains(profile.input.workspace_paths.first().unwrap()));
    let local = || {
        let LegacyLocalStorage::Snapshot(entries) = &profile.input.local_storage else {
            unreachable!()
        };
        LegacyLocalStorage::Snapshot(entries.clone())
    };
    sqlx::raw_sql("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('chat','Design','now','now');
        INSERT INTO architect_plan_conversation_sync(conversation_id,plan_id,target_branch,updated_at)
        VALUES('chat','homonym','main','now');
        CREATE TRIGGER fail_second BEFORE INSERT ON architect_versions
        WHEN (SELECT count(*) FROM architect_versions)=1 BEGIN SELECT RAISE(ABORT,'interrupted'); END;")
        .execute(&pool).await.unwrap();
    assert!(migrate_profile(&pool, roots.clone(), None, local())
        .await
        .is_err());
    let counts: (i64,i64,i64,i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM architect_projects),(SELECT count(*) FROM architect_blueprints),
         (SELECT count(*) FROM architect_versions),(SELECT count(*) FROM architect_legacy_import)")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (0, 0, 0, 0));
    sqlx::query("DROP TRIGGER fail_second")
        .execute(&pool)
        .await
        .unwrap();
    fs::write(
        profile
            .workspace
            .join("branches/main/plans/shared/chat.jsonl"),
        "after rollback",
    )
    .unwrap();
    let completed = migrate_profile(&pool, roots.clone(), None, local())
        .await
        .unwrap();
    assert_eq!(
        completed.status,
        LegacyImportStatus::Complete,
        "{:?}",
        completed.issues
    );
    assert_eq!(completed.inserted, 4);
    let identities: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,project_id,source_id FROM architect_blueprints ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let frozen_versions: Vec<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT blueprint_id,number,revision,document FROM architect_versions ORDER BY blueprint_id,number",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(frozen_versions.len(), 4);
    assert!(frozen_versions
        .iter()
        .all(|(_, number, revision, _)| (*number, *revision) == (1, 1)));
    let linked: (String, String) =
        sqlx::query_as("SELECT id,history FROM architect_blueprints WHERE conversation_id='chat'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(linked.1.contains("legacyConversationId"));
    let document =
        serde_json::from_value(json!({"source":"unfinished edit","annexes":{}})).unwrap();
    crate::db::architect_library::save_draft(&pool, linked.0, 1, document)
        .await
        .unwrap();
    pool.close().await;
    // Treat the committed response as lost. The old sources now disagree.
    fs::write(
        profile
            .workspace
            .join("branches/main/plans/shared/chat.jsonl"),
        "late transcript",
    )
    .unwrap();
    put(
        &profile.workspace.join("branches/main/plans/index.json"),
        &json!({"version":3,"plans":[
        {"id":"shared","status":"deleted","updatedAt":"2027-01-01T00:00:00Z"}]}),
    );
    let pool = create_pool(&db).await.unwrap();
    let repeated = migrate_profile(
        &pool,
        roots,
        None,
        LegacyLocalStorage::Unavailable("offline".into()),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            repeated.inserted,
            repeated.already_imported,
            repeated.divergent_plans
        ),
        (0, 4, 1)
    );
    let after: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,project_id,source_id FROM architect_blueprints ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(identities, after);
    let reopened_versions: Vec<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT blueprint_id,number,revision,document FROM architect_versions ORDER BY blueprint_id,number",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(reopened_versions, frozen_versions);
    let versions: Vec<String> = sqlx::query_scalar(
        "SELECT json_extract(document,'$.source') FROM architect_versions WHERE number=1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(versions, vec![EXACT_SOURCE.to_string(); 4]);
    let archived: Vec<String> =
        sqlx::query_scalar("SELECT history FROM architect_blueprints WHERE archived")
            .fetch_all(&pool)
            .await
            .unwrap();
    let dangling: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM architect_blueprints WHERE archived AND conversation_id IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(dangling, 0);
    assert_eq!(archived.len(), 2);
    assert!(archived
        .iter()
        .any(|history| history.contains("after rollback")));
    let edited: String = sqlx::query_scalar("SELECT json_extract(document,'$.source') FROM architect_blueprints WHERE conversation_id='chat'").fetch_one(&pool).await.unwrap();
    assert_eq!(edited, "unfinished edit");
}

#[tokio::test]
async fn unavailable_invalid_and_empty_sources_have_distinct_outcomes() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::create_pool(&dir.path().join("macro.db"))
        .await
        .unwrap();
    let workspace = dir.path().join("workspace");
    let roots = || Ok(vec![workspace.clone()]);
    let empty = || LegacyLocalStorage::Snapshot(BTreeMap::new());
    let offline = dir.path().join("offline");
    put(
        &workspace.join(".macro/workspace.json"),
        &json!({"standaloneProjects": [{"id":"offline","path":offline}]}),
    );
    let config_root = dir.path().join("config");
    fs::create_dir(&config_root).unwrap();
    fs::write(config_root.join("runtime.json"), "{truncated").unwrap();
    let manager = crate::config::ConfigManager::initialize(config_root)
        .await
        .unwrap();
    let invalid_config = configured_roots(&manager, vec![dir.path().to_owned()]).await;
    let retry = migrate_profile(&pool, invalid_config, None, empty())
        .await
        .unwrap();
    assert_eq!(retry.status, LegacyImportStatus::DiscoveryIncomplete);
    assert_eq!(retry.issues[0].location, "runtime.json");
    let incomplete = migrate_profile(
        &pool,
        roots(),
        None,
        LegacyLocalStorage::Unavailable("denied".into()),
    )
    .await
    .unwrap();
    assert_eq!(incomplete.status, LegacyImportStatus::DiscoveryIncomplete);
    assert_eq!(incomplete.issues.len(), 2);
    fs::create_dir(offline).unwrap();
    let mut broken = blueprint("bad");
    broken["agsdl"]["source"] = json!(r#"{"contract":"agsdl-0.3.0","id":"one","id":"two"}"#);
    let path = store(&workspace.join(".macro"), "main", &broken);
    let invalid = migrate_profile(&pool, roots(), None, empty())
        .await
        .unwrap();
    assert_eq!(invalid.status, LegacyImportStatus::DiscoveryIncomplete);
    assert!(
        invalid.issues[0].message.contains("Invalid JSON"),
        "{:?}",
        invalid.issues
    );
    assert!(invalid.issues[0].location.contains("bad"));
    fs::remove_file(path).unwrap();
    let valid = store(&workspace.join(".macro"), "main", &blueprint("recoverable"));
    let index = workspace.join(".macro/branches/main/plans/index.json");
    fs::write(&index, "broken").unwrap();
    let corrupt = migrate_profile(&pool, roots(), None, empty())
        .await
        .unwrap();
    assert_eq!(corrupt.status, LegacyImportStatus::DiscoveryIncomplete);
    assert_eq!((corrupt.discovered, corrupt.inserted), (1, 0));
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM architect_blueprints),(SELECT count(*) FROM architect_legacy_import)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (0, 0));
    assert_eq!(fs::read_to_string(&index).unwrap(), "broken");
    fs::remove_file(index).unwrap();
    fs::remove_file(valid).unwrap();
    let done = migrate_profile(&pool, roots(), None, empty())
        .await
        .unwrap();
    assert_eq!(done.status, LegacyImportStatus::Complete);
    assert_eq!(done.discovered, 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM architect_legacy_import")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}

#[test]
fn invalid_temp_does_not_hide_a_valid_backup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".macro");
    let backup = json!({"workspaceRevision": 2, "standaloneProjects": [{
        "id": "app", "path": "projects/app", "name": "App",
        "created_at": "2026-01-01T00:00:00Z", "status": "active"
    }]});
    put(&root.join("workspace.json.bak"), &backup);
    put(&root.join("workspace.json"), &backup);
    put(
        &root.join(".workspace.json.macro-tmp-higher"),
        &json!({
            "workspaceRevision": 3, "version": "invalid"
        }),
    );
    store(
        &dir.path().join("projects/app/.macro"),
        "main",
        &blueprint("recoverable"),
    );
    let discovery = discover_legacy_agsdl(&profile(dir.path()));
    assert!(discovery.issues.is_empty(), "{:?}", discovery.issues);
    assert_eq!(discovery.blueprints.len(), 1);
}

#[test]
fn reads_root_backup_when_historical_registry_is_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let metadata = metadata_checkout(&repo);
    put(
        &metadata.join("workspace.json.bak"),
        &json!({"standaloneProjects": [{
            "id": "app", "path": "projects/app", "name": "App"
        }]}),
    );
    fs::create_dir(metadata.join(".macro")).unwrap();
    fs::write(metadata.join(".macro/workspace.json"), "{invalid").unwrap();
    store(
        &dir.path().join("projects/app/.macro"),
        "main",
        &blueprint("recoverable"),
    );
    let discovery = discover_legacy_agsdl(&profile(dir.path()));
    assert!(discovery.issues.is_empty(), "{:?}", discovery.issues);
    assert_eq!(discovery.blueprints.len(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let tmp = metadata.join(".macro/.workspace.json.macro-tmp-pending");
        put(&tmp, &json!({"workspaceRevision": 9}));
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0)).unwrap();
        if fs::read(&tmp).is_err() {
            let discovery = discover_legacy_agsdl(&profile(dir.path()));
            assert!(discovery
                .issues
                .iter()
                .any(|issue| issue.location.contains("macro-tmp-pending")));
        }
    }
}

#[test]
fn preserves_historical_frontend_id_normalization() {
    // The historical JS serializer uses sanitizeId(rawId) in the key,
    // while preserving rawId in the JSON payload.
    let mut plan = blueprint("Demo--Stage");
    plan["targetBranch"] = json!("main");
    let mut input = profile(Path::new("/"));
    input.workspace_paths.clear();
    input.local_storage = LegacyLocalStorage::Snapshot(BTreeMap::from([
        (
            "macro_architect_plan:main:demo--stage".into(),
            plan.to_string(),
        ),
        (
            "macro_architect_plan_chat:main:demo--stage".into(),
            "transcript".into(),
        ),
    ]));
    let discovery = discover_legacy_agsdl(&input);
    assert!(discovery.issues.is_empty(), "{:?}", discovery.issues);
    assert_eq!(
        discovery.blueprints[0]
            .origins
            .first()
            .unwrap()
            .transcript
            .as_deref(),
        Some("transcript")
    );
}

// Captured from updateArchitectPlan after interrupting its first replica write
// in architectPlanReplicas.test.ts. Substitute only the fixture's project roots.
fn interrupted_journal(root: &Path) -> Value {
    serde_json::from_str(
        &include_str!("interrupted-update.json")
            .replace("/repos/", &format!("{}/", root.display())),
    )
    .unwrap()
}

async fn set_pending(pool: &sqlx::SqlitePool, entries: &Value) {
    sqlx::query("INSERT OR REPLACE INTO app_settings(key,value_json,updated_at) VALUES(?,?,'now')")
        .bind(journal::KEY)
        .bind(entries.to_string())
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn interrupted_replica_update_survives_import_rollback_and_ack_loss() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let db = root.join("profile.db");
    let pool = crate::db::create_pool(&db).await.unwrap();
    let entries = interrupted_journal(&root);
    let final_plan = &entries[0]["payload"]["targets"][0]["plan"];
    let mut stale = final_plan.clone();
    stale["description"] = json!("before the crash");
    stale["agsdl"]["source"] = json!(EXACT_SOURCE);
    put(
        &root.join(".macro/workspace.json"),
        &json!({"standaloneProjects":[{"id":"api","path":"api"},{"id":"web","path":"web"}]}),
    );
    let old_path = store(&root.join("api/.macro"), "develop", &stale);
    // One plan.json was already written, but both indexes and the second replica are stale.
    let repo = git2::Repository::init(root.join("web")).unwrap();
    let metadata_root = metadata_checkout(&repo);
    let initial_head = repo.refname_to_id("refs/heads/@macro").unwrap();
    store(&metadata_root, "develop", final_plan);
    set_pending(&pool, &entries).await;
    let migrate = |pool: sqlx::SqlitePool, root: PathBuf| async move {
        migrate_profile(
            &pool,
            Ok(vec![root]),
            None,
            LegacyLocalStorage::Snapshot(BTreeMap::new()),
        )
        .await
    };
    sqlx::query("CREATE TRIGGER crash BEFORE INSERT ON architect_legacy_import BEGIN SELECT RAISE(ABORT,'crash'); END")
        .execute(&pool).await.unwrap();
    assert!(migrate(pool.clone(), root.clone()).await.is_err());
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM architect_blueprints),(SELECT count(*) FROM architect_legacy_import)").fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (0, 0));
    sqlx::query("DROP TRIGGER crash")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let pool = crate::db::create_pool(&db).await.unwrap();
    let done = migrate(pool.clone(), root.clone()).await.unwrap();
    assert_eq!(done.inserted, 1, "{:?}", done.issues);
    let (document,history):(String,String)=sqlx::query_as("SELECT architect_versions.document,history FROM architect_versions JOIN architect_blueprints ON blueprint_id=architect_blueprints.id").fetch_one(&pool).await.unwrap();
    let document: Value = serde_json::from_str(&document).unwrap();
    let history: Value = serde_json::from_str(&history).unwrap();
    assert_eq!(document["source"], final_plan["agsdl"]["source"]);
    assert_eq!(document["annexes"], final_plan["agsdl"]["annexes"]);
    assert_eq!(history["description"], "after-0");
    assert_eq!(history["origins"].as_array().unwrap().len(), 2);
    assert_eq!(fs::read_to_string(old_path).unwrap(), stale.to_string());
    assert!(!root.join("api/.git").exists());
    assert_eq!(
        initial_head,
        repo.refname_to_id("refs/heads/@macro").unwrap()
    );
    assert!(!metadata_root
        .join("branches/develop/plans/index.json")
        .exists());
    assert_eq!(
        migrate(pool.clone(), root).await.unwrap().already_imported,
        1
    );
    let retained: String = sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key=?")
        .bind(journal::KEY)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(retained, entries.to_string());
}

#[tokio::test]
async fn pending_local_archive_and_remove_replace_the_stale_snapshot_only_after_validation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let pool = crate::db::create_pool(&root.join("profile.db"))
        .await
        .unwrap();
    let mut entries = interrupted_journal(&root);
    entries[0]["workspaceKey"] = json!("local:local");
    entries[0]["phase"] = json!("prepared");
    entries[0]["operation"] = json!("archive");
    let targets = entries[0]["payload"]["targets"].as_array_mut().unwrap();
    targets.truncate(1);
    let target = &mut targets[0];
    target["scope"] = json!({"scopeKey":"local","source":"local","workspacePath":null,"repoPath":null,"projectId":null});
    target["plan"]["status"] = json!("archived");
    target["plan"]["archivedAt"] = json!("2026-09-01T00:00:00Z");
    target["index"]["plans"][0]["status"] = json!("archived");
    let mut removed = entries[0].clone();
    removed["id"] = json!("remove-obsolete");
    removed["operation"] = json!("delete");
    removed["planId"] = json!("obsolete");
    removed["payload"]["targets"][0]["action"] = json!("remove");
    removed["payload"]["targets"][0]["plan"] = Value::Null;
    entries.as_array_mut().unwrap().push(removed);
    let run = || {
        migrate_profile(
            &pool,
            Ok(vec![root.clone()]),
            None,
            LegacyLocalStorage::Snapshot(BTreeMap::from([(
                "macro_architect_plan:develop:obsolete".into(),
                blueprint("obsolete").to_string(),
            )])),
        )
    };
    let mut invalid = entries.clone();
    invalid[0]["payload"]["targets"][0]["scope"] = json!({"scopeKey":"repo:/foreign","source":"project","workspacePath":"/foreign","repoPath":"/foreign"});
    invalid[0]["workspaceKey"] = json!("/foreign");
    set_pending(&pool, &invalid).await;
    let failed = run().await.unwrap();
    assert_eq!(failed.status, LegacyImportStatus::DiscoveryIncomplete);
    assert!(failed
        .issues
        .iter()
        .any(|issue| issue.location == journal::KEY));
    let marker: i64 = sqlx::query_scalar("SELECT count(*) FROM architect_legacy_import")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(marker, 0);
    // A files_applied entry with a missing plan is incomplete too.
    let mut missing = entries.clone();
    missing[0]["phase"] = json!("files_applied");
    set_pending(&pool, &missing).await;
    assert_eq!(
        run().await.unwrap().status,
        LegacyImportStatus::DiscoveryIncomplete
    );
    set_pending(&pool, &entries).await;
    let done = run().await.unwrap();
    assert_eq!(done.inserted, 1, "{:?}", done.issues);
    let history: String = sqlx::query_scalar("SELECT history FROM architect_blueprints")
        .fetch_one(&pool)
        .await
        .unwrap();
    let history: Value = serde_json::from_str(&history).unwrap();
    assert_eq!(history["status"], "archived");
    assert_eq!(history["archivedAt"], "2026-09-01T00:00:00Z");
}

#[tokio::test]
async fn artifact_journal_uses_the_old_commit_point_and_preserves_conflicts_for_retry() {
    for (phase, count) in [("applying", 1), ("committing", 0)] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let pool = crate::db::create_pool(&root.join("profile.db"))
            .await
            .unwrap();
        let dir = root.join(".macro");
        store(&dir, "main", &blueprint("audit"));
        let path = "branches/main/plans/audit/manifest.json";
        let before = json!({"planId":"audit","status":"draft"}).to_string();
        let after = json!({"planId":"audit","status":"deleted","revision":100}).to_string();
        let entries = json!([{"id":"plan:v1:main:audit:artifacts:1:test","workspaceKey":root,"planId":"audit","branchName":"main",
            "operation":"artifacts","phase":phase,"createdAt":"now","updatedAt":"now",
            "payload":{"files":[{"workspacePath":root,"workspaceScope":"direct","path":path,"before":before,"after":after}]}}]);
        set_pending(&pool, &entries).await;
        let run = || {
            migrate_profile(
                &pool,
                Ok(vec![root.clone()]),
                None,
                LegacyLocalStorage::NotApplicable,
            )
        };
        fs::write(dir.join(path), "conflicting edit").unwrap();
        let conflict = run().await.unwrap();
        assert_eq!(conflict.status, LegacyImportStatus::DiscoveryIncomplete);
        assert!(conflict
            .issues
            .iter()
            .any(|issue| issue.message.contains("Artifact recovery conflict")));
        fs::write(dir.join(path), &after).unwrap();
        let done = run().await.unwrap();
        assert_eq!(
            done.status,
            LegacyImportStatus::Complete,
            "{:?}",
            done.issues
        );
        assert_eq!(done.inserted, count);
        assert_eq!(fs::read_to_string(dir.join(path)).unwrap(), after);
    }
}
