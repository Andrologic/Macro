use super::*;
use crate::config::{ConfigChangeSource, ConfigPatchRequest, ConfigScope, JsonPatchOperation};
use serde_json::json;
use tempfile::{tempdir, TempDir};

async fn patch_skills(manager: &ConfigManager, scope: ConfigScope, path: &str, value: JsonValue) {
    let document = manager
        .get_document(ConfigDocumentKind::Skills, scope.clone())
        .await
        .expect("skills document");
    let result = manager
        .apply_patch(ConfigPatchRequest {
            kind: ConfigDocumentKind::Skills,
            scope,
            expected_etag: document.etag,
            patch: vec![JsonPatchOperation {
                op: "add".into(),
                path: path.into(),
                from: None,
                value: Some(value),
            }],
            source: ConfigChangeSource::UserInterface,
        })
        .await
        .expect("patch skills configuration");
    assert!(result.pending_change.is_none());
}

struct Fixture {
    _temp: TempDir,
    manager: ConfigManager,
    project: SkillProjectRootDto,
    workspace: SkillScriptWorkspaceDto,
    original: SkillManifestDto,
    copy: SkillManifestDto,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempdir().expect("fixture");
        let project_path = temp.path().join("project");
        let worktree = project_path.join(".macro/worktrees/task");
        for (root, marker) in [(&project_path, "original"), (&worktree, "copy")] {
            let skill = root.join(".opencode/skills/runner");
            fs::create_dir_all(&skill).unwrap();
            fs::write(
                skill.join(SKILL_FILE),
                "---\nname: runner\ndescription: Runs scripts\n---\n",
            )
            .unwrap();
            fs::create_dir(skill.join("scripts")).unwrap();
            fs::write(
                skill.join("scripts/check.sh"),
                format!("printf '{marker}\\n'\npwd -P\n"),
            )
            .unwrap();
        }
        let manager = ConfigManager::initialize(temp.path().join("config"))
            .await
            .unwrap();
        manager
            .register_project_root("p1", temp.path().join("metadata"))
            .await
            .unwrap();
        // Keep discovery independent of the machine's installed global skills.
        patch_skills(
            &manager,
            ConfigScope::User,
            "/conventionalRoots",
            json!({"agents": false, "codex": false, "opencode": false, "claude": false}),
        )
        .await;
        patch_skills(
            &manager,
            ConfigScope::Project {
                project_id: "p1".into(),
            },
            "/roots",
            json!({"opencode-skills": {
                "path": "${projectRoot}/.opencode/skills", "enabled": true, "priority": 200
            }}),
        )
        .await;
        let project = SkillProjectRootDto {
            project_id: "p1".into(),
            project_name: "Project".into(),
            path: project_path.to_string_lossy().into_owned(),
        };
        let copy_root = SkillProjectRootDto {
            path: worktree.to_string_lossy().into_owned(),
            ..project.clone()
        };
        let id = "project:p1:opencode-skills:runner";
        let original = resolve_configured_skill(&manager, id, std::slice::from_ref(&project))
            .await
            .unwrap();
        let copy = resolve_configured_skill(&manager, id, std::slice::from_ref(&copy_root))
            .await
            .unwrap();
        assert_eq!(original.id, copy.id);
        assert_ne!(original.content_hash, copy.content_hash);
        // Establish the reported collision through the production configuration resolver.
        let collision = resolve_configured_skill(&manager, id, &[project.clone(), copy_root])
            .await
            .unwrap();
        assert_eq!(collision.content_hash, copy.content_hash);
        let fixture = Self {
            _temp: temp,
            manager,
            project,
            workspace: SkillScriptWorkspaceDto {
                project_id: "p1".into(),
                path: worktree.to_string_lossy().into_owned(),
            },
            original,
            copy,
        };
        fixture.approve().await;
        fixture
    }

    async fn permission(&self, value: JsonValue) {
        patch_skills(
            &self.manager,
            ConfigScope::User,
            "/permissions",
            json!({self.original.id.clone(): value}),
        )
        .await;
    }

    fn approval(&self) -> JsonValue {
        json!({
            "enabled": true, "scriptsEnabled": true,
            "trust": {"contentHash": self.original.content_hash,
                "grantedBy": "user", "grantedAt": "2026-01-01T00:00:00Z"}
        })
    }

    async fn approve(&self) {
        self.permission(self.approval()).await;
    }

    async fn run(
        &self,
        allow: bool,
        path: Option<String>,
        root: Option<SkillScriptWorkspaceDto>,
    ) -> CommandResult<SkillScriptRunResponse> {
        // This is the implementation called by the Tauri command, including permissions.
        run_configured_skill_script(
            &self.manager,
            self.original.id.clone(),
            "scripts/check.sh".into(),
            vec![],
            Some(5_000),
            allow,
            path,
            vec![self.project.clone()],
            root,
        )
        .await
    }
}

#[tokio::test]
async fn approved_original_runs_in_worktree_despite_different_same_id_copy() {
    let f = Fixture::new().await;
    let output = f
        .run(
            true,
            Some(f.workspace.path.clone()),
            Some(f.workspace.clone()),
        )
        .await
        .expect("approved original in captured worktree");
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(
        output.stdout,
        format!(
            "original\n{}\n",
            fs::canonicalize(&f.workspace.path).unwrap().display()
        )
    );
    // The previous direct-project IPC form remains confined to its project roots.
    let output = f
        .run(true, Some(f.project.path.clone()), None)
        .await
        .unwrap();
    assert_eq!(
        output.stdout,
        format!(
            "original\n{}\n",
            fs::canonicalize(&f.project.path).unwrap().display()
        )
    );
}

#[tokio::test]
async fn configured_execution_rejects_missing_or_outside_workspace_and_keeps_temporary_mode() {
    let f = Fixture::new().await;
    let run = |path, root| f.run(true, path, Some(root));
    assert!(run(None, f.workspace.clone())
        .await
        .unwrap_err()
        .message
        .contains("no workspace path"));
    // The repository remains a discovery root but is not this call's execution root.
    assert!(run(Some(f.project.path.clone()), f.workspace.clone())
        .await
        .is_err());
    let unknown = SkillScriptWorkspaceDto {
        project_id: "removed".into(),
        ..f.workspace.clone()
    };
    assert!(run(Some(f.workspace.path.clone()), unknown)
        .await
        .unwrap_err()
        .message
        .contains("project is not available"));
    let escape = Path::new(&f.workspace.path).join("escape");
    std::os::unix::fs::symlink(&f.project.path, &escape).unwrap();
    assert!(run(
        Some(escape.to_string_lossy().into_owned()),
        f.workspace.clone()
    )
    .await
    .is_err());
    fs::remove_dir_all(&f.workspace.path).unwrap();
    assert!(run(Some(f.workspace.path.clone()), f.workspace.clone())
        .await
        .unwrap_err()
        .message
        .contains("Failed to resolve workspace path"));
    let output = f
        .run(
            false,
            Some(f.workspace.path.clone()),
            Some(f.workspace.clone()),
        )
        .await
        .unwrap();
    assert_eq!(output.exit_code, Some(0));
    let mut lines = output.stdout.lines();
    assert_eq!(lines.next(), Some("original"));
    let cwd = PathBuf::from(lines.next().unwrap());
    assert!(cwd
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("macro-skill-run-"));
    assert!(!cwd.exists(), "temporary cwd cleaned up");
}

#[tokio::test]
async fn configured_execution_preserves_hash_permissions_revocation_and_missing_source_errors() {
    let f = Fixture::new().await;
    for (field, value, message) in [
        ("enabled", json!(false), "disabled"),
        ("scriptsEnabled", json!(false), "disabled"),
        (
            "trust",
            json!({"contentHash": f.copy.content_hash, "grantedBy": "user", "grantedAt": "2026-01-01T00:00:00Z"}),
            "content changed",
        ),
        (
            "trust",
            json!({"contentHash": f.original.content_hash, "grantedBy": "agent", "grantedAt": "2026-01-01T00:00:00Z"}),
            "not been trusted",
        ),
    ] {
        let mut permission = f.approval();
        permission[field] = value;
        f.permission(permission).await;
        for allow in [true, false] {
            let error = f
                .run(
                    allow,
                    Some(f.workspace.path.clone()),
                    Some(f.workspace.clone()),
                )
                .await
                .unwrap_err();
            assert!(error.message.contains(message), "{field}: {error:?}");
        }
    }
    patch_skills(&f.manager, ConfigScope::User, "/permissions", json!({})).await;
    assert!(f
        .run(
            true,
            Some(f.workspace.path.clone()),
            Some(f.workspace.clone())
        )
        .await
        .unwrap_err()
        .message
        .contains("no local permission record"));
    f.approve().await;
    fs::remove_dir_all(Path::new(&f.original.skill_file_path).parent().unwrap()).unwrap();
    assert!(Path::new(&f.copy.skill_file_path).exists());
    assert!(f
        .run(
            true,
            Some(f.workspace.path.clone()),
            Some(f.workspace.clone())
        )
        .await
        .unwrap_err()
        .message
        .contains("Skill not found"));
}
