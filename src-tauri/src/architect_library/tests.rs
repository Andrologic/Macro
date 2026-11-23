use super::{
    archive::open_version,
    project::{export_project, materialize, stage_starter, ImportCandidate, MANIFEST},
    CallTarget, Error, McpTransport, ReferenceKind, Usage,
};
use argentic_runtime::source::OpenedSource;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Write};
use std::path::Path;
use std::process::{Command, Output};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const SCRIPT: &str = "mcp/run.sh";
const SKILL_DATA: &str = "skills/review/nested/data.bin";

fn write(root: &Path, path: &str, bytes: &[u8]) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn write_json(root: &Path, path: &str, value: Value) {
    write(root, path, &serde_json::to_vec_pretty(&value).unwrap());
}

fn fixture(root: &Path) {
    write_json(
        root,
        MANIFEST,
        json!({
            "projectFormat": "agsdl-project-1",
            "contract": "agsdl-0.4.0",
            "id": "release-test",
            "title": "Vérifier la livraison",
            "agents": {
                "lead": {"file":"agents/lead.json"},
                "reviewer": {"harness":"codex","permissions":"read-only","skills":["local-review","remote-review"]},
                "spare": {"harness":"codex","permissions":"read-only"}
            },
            "skills": {
                "local-review":{"uri":"skills/review/SKILL.md"},
                "remote-review":{"uri":"https://example.invalid/skill/SKILL.md"}
            },
            "content": {
                "brief":{"uri":"https://example.invalid/brief"},
                "notes":{"uri":"notes.md"},
                "literal":{"value":{"uri":"https://example.invalid/literal"}}
            },
            "mcpServers": {
                "local":{"file":"mcp/local.json"},
                "remote":{"url":"http://127.0.0.1:1/mcp"},
                "spare":{"command":["program-that-does-not-exist"]}
            },
            "mcpFiles":{"local":[SCRIPT]},
            "secrets":{"file":"secrets.json"},
            "compositions":{"review":{"file":"flows/review.json"}},
            "flow":{"file":"flows/main.json"}
        }),
    );
    write_json(
        root,
        "agents/lead.json",
        json!({
            "harness":"codex",
            "harnessVersion":">=0.167.0",
            "model":{"name":"example/large","effort":"medium"},
            "instructions":[{"ref":"brief"}],
            "resources":{"notes":{"ref":"notes"}},
            "mcpServers":["remote"],
            "permissions":{
                "preset":"workspace",
                "directories":{"../docs":"read","../output":"write"},
                "outside":"deny",
                "reviewer":"person",
                "rules":[{"action":"mcp","match":"remote","effect":"ask"}]
            }
        }),
    );
    write_json(
        root,
        "flows/main.json",
        json!({
            "entry":"lead",
            "steps":{
                "lead":{"type":"agent","agent":"lead","next":"review"},
                "review":{"type":"compose","composition":"review","agents":{"peer":"reviewer"},"next":{"done":"local"}},
                "local":{"type":"call","mcp":{"server":"local","tool":"inspect"},"next":{"passed":"shell","failed":[]}},
                "shell":{"type":"call","command":"echo inspected"}
            }
        }),
    );
    write_json(
        root,
        "flows/review.json",
        json!({
            "parameters":["peer"],
            "entry":"review",
            "steps":{"review":{"type":"agent","agent":{"parameter":"peer"},"next":{"output":"done"}}},
            "outputs":["done"]
        }),
    );
    write_json(root, "mcp/local.json", json!({"command":["sh", SCRIPT]}));
    write_json(
        root,
        "secrets.json",
        json!({"local":["LOCAL_TOKEN"],"remote":["REMOTE_TOKEN"]}),
    );
    write(root, "notes.md", b"Notes.\r\n");
    write(
        root,
        "skills/review/SKILL.md",
        b"---\nname: review\ndescription: Review a document.\n---\n",
    );
    write(root, SKILL_DATA, b"\0\xff\n");
    write(root, SCRIPT, b"#!/bin/sh\nexit 0\n");
    write(root, "unused.txt", b"outside the selection");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(SCRIPT), fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn member_snapshot(source: &OpenedSource) -> Vec<(String, Vec<u8>, bool)> {
    source
        .selected_files()
        .unwrap()
        .map(|file| (file.path.to_owned(), file.bytes.to_vec(), file.executable))
        .collect()
}

#[test]
fn round_trip_uses_opened_bytes_and_publishes_without_replacing() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("input");
    fixture(&input);
    let folder = ImportCandidate::open(&input).unwrap();
    let manifest = ImportCandidate::open(&input.join(MANIFEST)).unwrap();
    assert_eq!(
        folder.preview().unwrap().staged_sha256,
        manifest.preview().unwrap().staged_sha256
    );
    let original = member_snapshot(folder.source());
    let authored = folder.source().authored_json().to_owned();
    fs::remove_dir_all(&input).unwrap();

    let staged = folder.stage_version(temp.path()).unwrap();
    let second = manifest.stage_version(temp.path()).unwrap();
    let first_bytes = fs::read(staged.directory().join("version.agsdl")).unwrap();
    assert_eq!(
        first_bytes,
        fs::read(second.directory().join("version.agsdl")).unwrap()
    );
    let published = staged.publish(temp.path()).unwrap();
    assert_eq!(
        published
            .archive_path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap(),
        published.artifact_id.to_string()
    );
    assert!(matches!(
        open_version(&published.archive_path, "bad"),
        Err(Error::DigestMismatch)
    ));
    let version = open_version(&published.archive_path, &published.sha256).unwrap();
    assert_eq!(member_snapshot(version.source()), original);
    assert_eq!(version.source().authored_json(), authored);

    let export = temp.path().join("copy.agsdl");
    version.export_archive(&export).unwrap();
    assert_eq!(fs::read(&export).unwrap(), first_bytes);
    assert!(matches!(
        version.export_archive(&export),
        Err(Error::DestinationExists)
    ));

    let dest = temp.path().join("export");
    fs::create_dir(&dest).unwrap();
    assert!(matches!(
        export_project(version.source(), &dest),
        Err(Error::DestinationExists)
    ));
    fs::remove_dir(&dest).unwrap();
    assert_eq!(
        export_project(version.source(), &dest).unwrap(),
        original.len()
    );
    let reopened = OpenedSource::open_path(&dest).unwrap();
    assert_eq!(member_snapshot(&reopened), original);
    assert_eq!(fs::read(dest.join(SKILL_DATA)).unwrap(), b"\0\xff\n");
    assert!(!dest.join("unused.txt").exists());
    assert_eq!(
        original
            .iter()
            .find(|(path, _, _)| path == SCRIPT)
            .unwrap()
            .2,
        cfg!(unix)
    );

    let adaptation = materialize(version.source(), temp.path()).unwrap();
    fs::write(adaptation.path().join("notes.md"), b"Adapted").unwrap();
    assert_eq!(
        version
            .members()
            .find(|file| file.path == "notes.md")
            .unwrap()
            .bytes,
        b"Notes.\r\n"
    );
}

#[test]
fn exports_report_the_published_destination_when_sync_fails() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("source");
    fixture(&project);
    let candidate = ImportCandidate::open(&project).unwrap();
    let artifact = candidate
        .stage_version(temp.path())
        .unwrap()
        .publish(temp.path())
        .unwrap();
    let version = open_version(&artifact.archive_path, &artifact.sha256).unwrap();

    let project_destination = temp.path().join("export");
    super::FAIL_PUBLICATION_SYNC.set(true);
    assert!(matches!(
        export_project(version.source(), &project_destination),
        Err(Error::PublishedNotSynced { destination, .. }) if destination == project_destination
    ));
    assert!(project_destination.join(MANIFEST).is_file());
    assert!(matches!(
        export_project(version.source(), &project_destination),
        Err(Error::DestinationExists)
    ));

    let archive_destination = temp.path().join("export.agsdl");
    super::FAIL_PUBLICATION_SYNC.set(true);
    assert!(matches!(
        version.export_archive(&archive_destination),
        Err(Error::PublishedNotSynced { destination, .. }) if destination == archive_destination
    ));
    assert_eq!(
        fs::read(&archive_destination).unwrap(),
        fs::read(&artifact.archive_path).unwrap()
    );
    assert!(matches!(
        version.export_archive(&archive_destination),
        Err(Error::DestinationExists)
    ));
}

#[test]
fn stored_archive_can_export_from_its_private_snapshot_after_original_disappears() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    fixture(&root);
    let artifact = ImportCandidate::open(&root)
        .unwrap()
        .stage_version(temp.path())
        .unwrap()
        .publish(temp.path())
        .unwrap();
    let original = fs::read(&artifact.archive_path).unwrap();
    let version = open_version(&artifact.archive_path, &artifact.sha256).unwrap();
    let candidate = ImportCandidate::open(&artifact.archive_path).unwrap();
    fs::remove_file(&artifact.archive_path).unwrap();
    let export = temp.path().join("export.agsdl");
    version.export_archive(&export).unwrap();
    let staged = candidate.stage_version(temp.path()).unwrap();
    assert_eq!(fs::read(export).unwrap(), original);
    assert_eq!(
        fs::read(staged.directory().join("version.agsdl")).unwrap(),
        original
    );

    let oversized = temp.path().join("too-large.agsdl");
    fs::File::create_new(&oversized)
        .unwrap()
        .set_len(512 * 1024 * 1024 + 1)
        .unwrap();
    assert!(matches!(
        ImportCandidate::open(&oversized),
        Err(Error::ArchiveLimit)
    ));
}

#[test]
fn preview_reports_reachability_permissions_calls_and_external_references() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let input = ImportCandidate::open(temp.path()).unwrap();
    let preview = input.preview().unwrap();
    assert_eq!(preview.title.as_deref(), Some("Vérifier la livraison"));
    assert_eq!(preview.authored_id, "release-test");
    assert_eq!(preview.contract, "agsdl-0.4.0");
    assert_eq!(preview.package_format, "agsdl-project-1");
    assert_eq!(preview.entry_point.as_deref(), Some("lead"));
    assert_eq!(preview.agents["lead"].usage, Usage::Reachable);
    assert_eq!(preview.agents["lead"].harness, "codex");
    assert_eq!(
        preview.agents["lead"].harness_version.as_deref(),
        Some(">=0.167.0")
    );
    assert_eq!(
        preview.agents["lead"]
            .model
            .as_ref()
            .unwrap()
            .name
            .as_deref(),
        Some("example/large")
    );
    assert_eq!(
        preview.agents["lead"].permissions.directories["../output"],
        "write"
    );
    assert_eq!(
        preview.agents["lead"].permissions.reviewer.as_deref(),
        Some("person")
    );
    assert_eq!(preview.agents["reviewer"].usage, Usage::Reachable);
    assert_eq!(preview.agents["spare"].usage, Usage::DeclaredOnly);
    assert!(preview.direct_calls.iter().any(
        |call| matches!(&call.target, CallTarget::Shell { command } if command == "echo inspected")
    ));
    assert!(preview.direct_calls.iter().any(|call| matches!(&call.target, CallTarget::Mcp { server, tool } if server == "local" && tool == "inspect")));
    assert!(preview
        .direct_calls
        .iter()
        .all(|call| call.usage == Usage::Reachable && call.location.file == "flows/main.json"));
    assert!(
        matches!(&preview.mcp_servers["local"].transport, McpTransport::Local { command } if command == &["sh", SCRIPT])
    );
    assert_eq!(preview.mcp_servers["local"].packaged_files, [SCRIPT]);
    assert_eq!(
        preview.mcp_servers["local"].required_secrets,
        ["LOCAL_TOKEN"]
    );
    assert_eq!(
        preview.mcp_servers["remote"].required_secrets,
        ["REMOTE_TOKEN"]
    );
    assert_eq!(preview.mcp_servers["local"].usage, Usage::Reachable);
    assert_eq!(preview.mcp_servers["remote"].usage, Usage::Unknown);
    assert_eq!(preview.mcp_servers["spare"].usage, Usage::DeclaredOnly);
    assert_eq!(preview.external_references.len(), 3);
    assert!(preview
        .external_references
        .iter()
        .any(|entry| entry.kind == ReferenceKind::Content
            && entry.uri == "https://example.invalid/brief"
            && entry.usage == Usage::Reachable));
    assert!(preview.warnings.iter().any(|warning| warning.launch_blocker
        && warning.location.file == MANIFEST
        && warning.location.pointer == "/skills/remote-review/uri"));
    assert!(preview.files.iter().any(|file| file.path == SKILL_DATA));
    assert!(!format!("{preview:?}").contains("example.invalid/literal"));
}

#[test]
fn starter_matches_the_empty_blueprint_and_rejects_plain_legacy_json() {
    let temp = tempfile::tempdir().unwrap();
    let starter = stage_starter(temp.path(), "Nouveau").unwrap();
    let opened = ImportCandidate::open(starter.path()).unwrap();
    let preview = opened.preview().unwrap();
    assert_eq!(preview.title.as_deref(), Some("Nouveau"));
    assert!(preview.authored_id.starts_with("system-"));
    assert_eq!(preview.contract, "agsdl-0.4.0");
    assert!(preview.entry_point.is_none());
    assert!(preview.agents.is_empty());
    assert_eq!(preview.files.len(), 1);
    write_json(
        temp.path(),
        MANIFEST,
        json!({"contract":"agsdl-0.3.0","id":"legacy","agents":{}}),
    );
    assert!(matches!(
        ImportCandidate::open(&temp.path().join(MANIFEST)),
        Err(Error::UnsupportedSource)
    ));
}

#[test]
fn rejects_bad_archive_inventory_and_limits() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("input");
    fixture(&input);
    let source = ImportCandidate::open(&input).unwrap();
    let mut bytes = Vec::new();
    source.source().write_archive(&mut bytes).unwrap();
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut corrupted = ZipWriter::new(Cursor::new(Vec::new()));
    for i in 0..archive.len() {
        let mut item = archive.by_index(i).unwrap();
        corrupted
            .start_file(item.name(), SimpleFileOptions::default())
            .unwrap();
        if item.name() == "project/notes.md" {
            corrupted.write_all(b"notes.\r\n").unwrap();
        } else {
            std::io::copy(&mut item, &mut corrupted).unwrap();
        }
    }
    let corrupted = corrupted.finish().unwrap().into_inner();
    let path = temp.path().join("invalid.agsdl");
    fs::write(&path, corrupted).unwrap();
    assert!(matches!(
        ImportCandidate::open(&path),
        Err(Error::Agsdl { .. })
    ));
    fs::write(&path, b"PK malformed").unwrap();
    assert!(matches!(
        ImportCandidate::open(&path),
        Err(Error::Agsdl { .. })
    ));
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(512 * 1024 * 1024 + 1)
        .unwrap();
    assert!(matches!(
        ImportCandidate::open(&path),
        Err(Error::ArchiveLimit)
    ));

    write(&input, "agents/lead.json", &vec![b' '; 1024 * 1024 + 1]);
    assert!(matches!(
        ImportCandidate::open(&input),
        Err(Error::Agsdl { .. })
    ));
}

#[test]
fn rejects_env_and_case_collisions_in_selected_paths() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    write(temp.path(), "skills/review/.env.local", b"placeholder");
    assert!(
        matches!(ImportCandidate::open(temp.path()), Err(Error::Agsdl { message, .. }) if message.contains(".env.local"))
    );
    fs::remove_file(temp.path().join("skills/review/.env.local")).unwrap();

    // Two spellings in the manifest work even on a case-insensitive filesystem.
    let mut doc: Value =
        serde_json::from_slice(&fs::read(temp.path().join(MANIFEST)).unwrap()).unwrap();
    doc["content"]["collision"] = json!({"uri":"Notes.md"});
    write(temp.path(), "Notes.md", b"uppercase");
    write_json(temp.path(), MANIFEST, doc);
    assert!(
        matches!(ImportCandidate::open(temp.path()), Err(Error::Agsdl { message, .. }) if message.to_lowercase().contains("collision"))
    );
}

#[cfg(unix)]
#[test]
fn refuses_to_read_selected_symlinks_and_absolute_file_uris() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("input");
    fixture(&root);
    let external = temp.path().join("external.txt");
    fs::write(&external, "outside").unwrap();
    let link = root.join("skills/review/link");
    std::os::unix::fs::symlink(&external, &link).unwrap();
    assert!(
        matches!(ImportCandidate::open(&root), Err(Error::Agsdl { message, .. }) if message.contains("link"))
    );
    fs::remove_file(link).unwrap();
    let project_link = temp.path().join("linked-project");
    std::os::unix::fs::symlink(&root, &project_link).unwrap();
    assert!(matches!(
        ImportCandidate::open(&project_link),
        Err(Error::SymbolicLink(_))
    ));

    assert!(matches!(
        ImportCandidate::open(&project_link.join(MANIFEST)),
        Err(Error::SymbolicLink(_))
    ));

    let mut doc: Value = serde_json::from_slice(&fs::read(root.join(MANIFEST)).unwrap()).unwrap();
    doc["content"]["brief"]["uri"] =
        json!(url::Url::from_file_path(&external).unwrap().to_string());
    write_json(&root, MANIFEST, doc);
    assert!(
        matches!(ImportCandidate::open(&root), Err(Error::Agsdl { message, .. }) if message.contains("Absolute file URI"))
    );
}

fn run_reference(checkout: &Path, cwd: &Path, action: &str, paths: &[&Path]) -> Output {
    let output = Command::new("python3")
        .args(["-m", "agsdl.archive", action])
        .args(paths)
        .current_dir(cwd)
        .env("PYTHONPATH", checkout.join("tooling"))
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .expect("run AgSDL v0.5.0 reference tool with python3");
    assert!(
        output.status.success(),
        "reference {action}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[test]
fn archive_interoperates_with_agsdl_v050_reference_tool() {
    let Some(checkout) = std::env::var_os("AGSDL_REFERENCE_CHECKOUT") else {
        eprintln!("Skipping AgSDL reference interoperability: AGSDL_REFERENCE_CHECKOUT is unset");
        return;
    };
    let checkout = fs::canonicalize(checkout).expect("AGSDL_REFERENCE_CHECKOUT must exist");
    assert!(
        checkout.join("tooling/agsdl/archive.py").is_file(),
        "AGSDL_REFERENCE_CHECKOUT must point to the v0.5.0 tool"
    );
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    fixture(&root);
    let input = ImportCandidate::open(&root).unwrap();
    let original = member_snapshot(input.source());
    let published = input
        .stage_version(temp.path())
        .unwrap()
        .publish(temp.path())
        .unwrap();
    let inspect = run_reference(
        &checkout,
        temp.path(),
        "inspect",
        &[&published.archive_path],
    );
    let report: Value = serde_json::from_slice(&inspect.stdout).unwrap();
    assert_eq!(report["project"], "release-test");
    assert_eq!(
        report["inventory"]["files"][SCRIPT]["executable"],
        cfg!(unix)
    );
    let unpacked = temp.path().join("unpacked");
    run_reference(
        &checkout,
        temp.path(),
        "unpack",
        &[&published.archive_path, &unpacked],
    );
    assert_eq!(fs::read(unpacked.join(SKILL_DATA)).unwrap(), b"\0\xff\n");

    let from_reference = temp.path().join("reference.agsdl");
    run_reference(
        &checkout,
        temp.path(),
        "pack",
        &[&unpacked, &from_reference],
    );
    let packed = ImportCandidate::open(&from_reference).unwrap();
    assert_eq!(member_snapshot(packed.source()), original);
    let stored = packed
        .stage_version(temp.path())
        .unwrap()
        .publish(temp.path())
        .unwrap();
    assert_eq!(
        fs::read(stored.archive_path).unwrap(),
        fs::read(&from_reference).unwrap()
    );
}

#[test]
fn history_import_verifies_the_bundle_and_rewrites_the_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    fixture(&root);
    let input = ImportCandidate::open(&root).unwrap();
    let published = input
        .stage_version(temp.path())
        .unwrap()
        .publish(temp.path())
        .unwrap();
    let snapshot_bytes = fs::read(&published.archive_path).unwrap();
    let mut original = ZipArchive::new(Cursor::new(&snapshot_bytes)).unwrap();
    let history = b"opaque history from another host";
    let metadata = json!({
        "size": history.len(),
        "sha256": format!("{:x}", Sha256::digest(history)),
        "commit": "0123456789abcdef0123456789abcdef01234567"
    });
    let with_history = temp.path().join("history.agsdl");
    for (bundle, valid) in [
        (b"bad bundle".as_slice(), false),
        (history.as_slice(), true),
    ] {
        let mut output = ZipWriter::new(fs::File::create(&with_history).unwrap());
        for i in 0..original.len() {
            let mut item = original.by_index(i).unwrap();
            output
                .start_file(item.name(), SimpleFileOptions::default())
                .unwrap();
            if item.name() == "archive.json" {
                let mut manifest: Value = serde_json::from_reader(&mut item).unwrap();
                manifest["history"] = metadata.clone();
                serde_json::to_writer(&mut output, &manifest).unwrap();
            } else {
                std::io::copy(&mut item, &mut output).unwrap();
            }
        }
        output
            .start_file("history.bundle", SimpleFileOptions::default())
            .unwrap();
        output.write_all(bundle).unwrap();
        output.finish().unwrap();
        if !valid {
            assert!(matches!(
                ImportCandidate::open(&with_history),
                Err(Error::Agsdl { .. })
            ));
        }
    }
    let raw_digest = format!("{:x}", Sha256::digest(fs::read(&with_history).unwrap()));
    assert!(matches!(
        open_version(&with_history, &raw_digest),
        Err(Error::UnexpectedHistory)
    ));
    let imported = ImportCandidate::open(&with_history).unwrap();
    let preview = imported.preview().unwrap();
    assert!(preview.history_will_be_removed);
    assert_eq!(preview.staged_sha256, raw_digest);
    let rewritten = imported
        .stage_version(temp.path())
        .unwrap()
        .publish(temp.path())
        .unwrap();
    assert_eq!(rewritten.sha256, published.sha256);
    assert_eq!(fs::read(rewritten.archive_path).unwrap(), snapshot_bytes);
}
