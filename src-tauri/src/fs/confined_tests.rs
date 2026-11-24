//! Generic file commands stay inside their root and away from private profile
//! data even through hard links, links followed by `..`, and entries replaced
//! between the check and the use.
use super::confined::hooks::{self, Point};
use super::dto::WorkspaceFileSearchRootDto;
use super::operations::*;
use super::private_profile;
use crate::core::error::BackendError;
use std::fs;
use std::path::{Path, PathBuf};

const CREDENTIALS: &str = "provider-secrets.json";
const DATABASE: &str = "macro.db";

/// A private profile next to (not inside) a project workspace.
struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    workspace: PathBuf,
    data: PathBuf,
    config: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let data = root.join("profile/data");
        let config = root.join("profile/config");
        let workspace = root.join("project");
        for path in [&data, &config, &workspace] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(data.join(CREDENTIALS), "credential store").unwrap();
        fs::write(data.join(DATABASE), "database pages").unwrap();
        fs::write(config.join("providers.json"), "private config").unwrap();
        private_profile::install(&data, &[&config]).unwrap();
        Self {
            _dir: dir,
            root,
            workspace,
            data,
            config,
        }
    }

    fn assert_private_untouched(&self) {
        assert_eq!(
            fs::read_to_string(self.data.join(CREDENTIALS)).unwrap(),
            "credential store"
        );
        assert_eq!(
            fs::read_to_string(self.data.join(DATABASE)).unwrap(),
            "database pages"
        );
        assert_eq!(
            fs::read_to_string(self.config.join("providers.json")).unwrap(),
            "private config"
        );
    }
}

fn refused<T: std::fmt::Debug>(result: Result<T, BackendError>) {
    assert!(
        matches!(result, Err(BackendError::FilesystemPermissionDenied { .. })),
        "expected a private-profile refusal, got {result:?}"
    );
}

fn search_root(workspace: &Path) -> WorkspaceFileSearchRootDto {
    WorkspaceFileSearchRootDto {
        workspace_path: workspace.to_string_lossy().into_owned(),
        project_id: None,
        project_name: None,
        mount_name: None,
        is_focused: false,
    }
}

#[tokio::test]
async fn hard_links_to_the_credential_store_and_database_are_refused() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    for private in [CREDENTIALS, DATABASE] {
        let link = format!("linked-{private}");
        fs::hard_link(fixture.data.join(private), workspace.join(&link)).unwrap();

        // Read, and therefore copy from the link.
        refused(read_file_internal(workspace, link.clone(), None).await);
        refused(
            read_file_internal(
                workspace,
                workspace.join(&link).to_string_lossy().into(),
                Some(true),
            )
            .await,
        );
        refused(file_content_revision_internal(workspace, link.clone()).await);
        refused(stat_internal(workspace, link.clone()).await);
        refused(exists_internal(workspace, link.clone()).await);

        // Overwrite, with and without a revision guard, and copy into the link.
        refused(
            write_file_internal(workspace, link.clone(), "overwritten".into(), None, None).await,
        );
        refused(
            write_file_internal_with_revision(
                workspace,
                link.clone(),
                "overwritten".into(),
                None,
                None,
                Some(&content_revision(b"credential store")),
            )
            .await,
        );
        refused(delete_path_internal_with_revision(workspace, link.clone(), None, None).await);

        // Transactional mutations used by the assistant tools.
        let target = open_workspace_capability_target_internal(workspace, link.clone())
            .await
            .unwrap();
        refused(read_file_bytes_with_mode_from_capability_target(&target).await);
        refused(
            write_file_bytes_with_capability_target_unlocked(
                &target,
                &link,
                b"overwritten".to_vec(),
                false,
                None,
                None,
            )
            .await,
        );
        refused(delete_file_with_capability_target_unlocked(&target, &link, None).await);

        // Listings and searches do not reveal the link.
        let listed = list_dir_internal(workspace, ".".into(), Some(true), Some(true), None, None)
            .await
            .unwrap();
        assert!(listed.iter().all(|entry| entry.name != link));
        let found = search_files(
            vec![search_root(workspace)],
            "linked".into(),
            None,
            Some(true),
            None,
        )
        .await
        .unwrap();
        assert!(found.is_empty(), "{found:?}");

        assert!(workspace.join(&link).exists(), "refusals must not unlink");
        fixture.assert_private_untouched();
    }
}

#[tokio::test]
async fn copying_between_the_workspace_and_a_private_hard_link_is_refused() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    fs::hard_link(fixture.data.join(DATABASE), workspace.join("db-link")).unwrap();
    fs::write(workspace.join("notes.txt"), "public notes").unwrap();

    // Copy from the private link to a public destination: the source read fails.
    refused(read_file_internal(workspace, "db-link".into(), None).await);
    assert!(!workspace.join("copy.txt").exists());

    // Copy a public file onto the private link: the destination write fails.
    let source = read_file_internal(workspace, "notes.txt".into(), None)
        .await
        .unwrap();
    refused(write_file_internal(workspace, "db-link".into(), source.content, None, None).await);
    fixture.assert_private_untouched();
}

#[tokio::test]
async fn hard_links_between_workspace_files_keep_working() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    fs::write(workspace.join("original.txt"), "shared").unwrap();
    fs::hard_link(workspace.join("original.txt"), workspace.join("alias.txt")).unwrap();

    let read = read_file_internal(workspace, "alias.txt".into(), None)
        .await
        .unwrap();
    assert_eq!(read.content, "shared");
    write_file_internal_with_revision(
        workspace,
        "alias.txt".into(),
        "replaced".into(),
        None,
        None,
        Some(&read.revision),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(workspace.join("alias.txt")).unwrap(),
        "replaced"
    );
    assert!(stat_internal(workspace, "original.txt".into())
        .await
        .is_ok());
    assert!(exists_internal(workspace, "alias.txt".into())
        .await
        .unwrap());
    delete_path_internal_with_revision(workspace, "alias.txt".into(), None, None)
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(workspace.join("original.txt")).unwrap(),
        "shared"
    );
    fixture.assert_private_untouched();
}

#[cfg(unix)]
#[tokio::test]
async fn a_link_before_dot_dot_resolves_physically_for_check_and_use() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    for path in ["secret", "other/nested"] {
        fs::create_dir_all(workspace.join(path)).unwrap();
    }
    symlink("secret", workspace.join("alias")).unwrap();
    symlink("../other/nested", workspace.join("secret/link")).unwrap();
    fs::write(workspace.join("secret/file.txt"), "lexical").unwrap();
    fs::write(workspace.join("other/file.txt"), "physical").unwrap();
    let raw = "alias/link/../file.txt";

    // The validator, the read, and the write all name the physical target.
    let validated = crate::fs::validate_path_for_write(Path::new(raw), workspace).unwrap();
    assert_eq!(validated, workspace.join("other/file.txt"));
    let read = read_file_internal(workspace, raw.into(), None)
        .await
        .unwrap();
    assert_eq!(read.content, "physical");
    write_file_internal_with_revision(
        workspace,
        raw.into(),
        "updated".into(),
        None,
        None,
        Some(&read.revision),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(workspace.join("other/file.txt")).unwrap(),
        "updated"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("secret/file.txt")).unwrap(),
        "lexical"
    );

    // Inside a root that contains the profile, the same shape reaching private
    // data is refused even though its lexical spelling names a public decoy.
    let root = &fixture.root;
    fs::create_dir_all(root.join("public")).unwrap();
    fs::create_dir_all(fixture.config.join("nested")).unwrap();
    fs::write(root.join("public/providers.json"), "decoy").unwrap();
    symlink("../profile/config/nested", root.join("public/link")).unwrap();
    let raw = "public/link/../providers.json";
    refused(read_file_internal(root, raw.into(), None).await);
    refused(write_file_internal(root, raw.into(), "stolen".into(), None, None).await);
    refused(stat_internal(root, raw.into()).await);
    assert_eq!(
        fs::read_to_string(root.join("public/providers.json")).unwrap(),
        "decoy"
    );
    fixture.assert_private_untouched();
}

#[cfg(unix)]
#[tokio::test]
async fn absolute_links_resolve_inside_the_root_and_never_outside() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    fs::write(workspace.join("target.txt"), "inside").unwrap();
    symlink(workspace.join("target.txt"), workspace.join("inside-link")).unwrap();
    symlink(
        fixture.data.join(CREDENTIALS),
        workspace.join("private-link"),
    )
    .unwrap();
    fs::write(fixture.root.join("outside.txt"), "outside").unwrap();
    symlink(
        fixture.root.join("outside.txt"),
        workspace.join("outside-link"),
    )
    .unwrap();

    let read = read_file_internal(workspace, "inside-link".into(), None)
        .await
        .unwrap();
    assert_eq!(read.content, "inside");
    assert!(read_file_internal(workspace, "private-link".into(), None)
        .await
        .is_err());
    assert!(matches!(
        read_file_internal(workspace, "outside-link".into(), None).await,
        Err(BackendError::FilesystemPathOutsideWorkspace { .. })
    ));
    fixture.assert_private_untouched();
}

#[tokio::test]
async fn an_entry_replaced_by_a_private_hard_link_before_the_read_is_refused() {
    let fixture = Fixture::new();
    let workspace = fixture.workspace.clone();
    fs::write(workspace.join("doc.txt"), "public").unwrap();
    let credentials = fixture.data.join(CREDENTIALS);
    let swapped = workspace.join("doc.txt");
    hooks::install(Point::BeforeOpen, &workspace.join("doc.txt"), move || {
        fs::remove_file(&swapped).unwrap();
        fs::hard_link(&credentials, &swapped).unwrap();
    });

    // The path check passed for the public file; the handle that is read is
    // the replacement, and its identity is refused.
    refused(read_file_internal(&workspace, "doc.txt".into(), None).await);
    fixture.assert_private_untouched();
}

#[cfg(unix)]
#[tokio::test]
async fn a_parent_replaced_after_its_check_is_still_the_one_written() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let workspace = fixture.workspace.clone();
    fs::create_dir(workspace.join("dir")).unwrap();
    let parent = workspace.join("dir");
    let moved = workspace.join("dir-moved");
    let config = fixture.config.clone();
    hooks::install(
        Point::AfterParent,
        &workspace.join("dir/file.txt"),
        move || {
            fs::rename(&parent, &moved).unwrap();
            symlink(&config, &parent).unwrap();
        },
    );

    write_file_internal(
        &workspace,
        "dir/file.txt".into(),
        "checked parent".into(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(workspace.join("dir-moved/file.txt")).unwrap(),
        "checked parent"
    );
    assert!(!fixture.config.join("file.txt").exists());
    fixture.assert_private_untouched();
}

#[tokio::test]
async fn a_directory_replaced_before_recursive_removal_is_kept() {
    let fixture = Fixture::new();
    let workspace = fixture.workspace.clone();
    fs::create_dir_all(workspace.join("tree")).unwrap();
    fs::write(workspace.join("tree/old.txt"), "checked").unwrap();
    let tree = workspace.join("tree");
    let previous = workspace.join("tree-previous");
    hooks::install(Point::BeforeRemove, &workspace.join("tree"), move || {
        fs::rename(&tree, &previous).unwrap();
        fs::create_dir(&tree).unwrap();
        fs::write(tree.join("new.txt"), "replacement").unwrap();
    });

    let error = delete_path_internal_with_revision(&workspace, "tree".into(), Some(true), None)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("changed before deletion"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("tree/new.txt")).unwrap(),
        "replacement"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("tree-previous/old.txt")).unwrap(),
        "checked"
    );
}

#[tokio::test]
async fn legitimate_workspace_operations_keep_working() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    let written = write_file_internal(
        workspace,
        "src/new/file.rs".into(),
        "fn main() {}".into(),
        Some(true),
        None,
    )
    .await
    .unwrap();
    assert!(written.created);
    let read = read_file_internal(workspace, "src/new/file.rs".into(), None)
        .await
        .unwrap();
    assert_eq!(read.content, "fn main() {}");
    assert_eq!(read.language, "Rust");
    let stat = stat_internal(workspace, "src/new".into()).await.unwrap();
    assert_eq!(stat.kind, "directory");
    let listed = list_dir_internal(workspace, "src".into(), Some(true), None, None, None)
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
    let found = search_files(
        vec![search_root(workspace)],
        "file".into(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(found.len(), 1);
    delete_path_internal_with_revision(workspace, "src".into(), Some(true), None)
        .await
        .unwrap();
    assert!(!exists_internal(workspace, "src".into()).await.unwrap());

    // The default workspace below the data root stays usable.
    let default_workspace = fixture.data.join("workspace");
    fs::create_dir_all(&default_workspace).unwrap();
    write_file_internal(
        &default_workspace,
        "notes.md".into(),
        "# notes".into(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        read_file_internal(&default_workspace, "notes.md".into(), None)
            .await
            .unwrap()
            .content,
        "# notes"
    );
    fixture.assert_private_untouched();
}
