//! The caller retains Macro's repository lock throughout this transaction.
use super::core::{fresh, CaptureResult, PilotCaptureRequest};
use git2::Repository;
use serde::Deserialize;
use sqlx::SqlitePool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerdictCommit {
    pub snapshot_id: String,
    pub request: PilotCaptureRequest,
    pub key: String,
    pub expected_value_json: Option<String>,
    pub value_json: String,
    pub execute_before: String,
    pub branches: Option<Branches>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Branches {
    pub base: String,
    pub head: String,
}
fn check_branches(repo: &Repository, input: &VerdictCommit) -> CaptureResult<()> {
    if let super::core::PilotCaptureSource::Commits { base_sha, head_sha } = &input.request.source {
        let branches = input.branches.as_ref().ok_or("stale_revision")?;
        for (name, expected) in [(&branches.base, base_sha), (&branches.head, head_sha)] {
            let actual = repo
                .find_branch(name, git2::BranchType::Local)
                .map_err(|_| "stale_revision")?
                .get()
                .target()
                .ok_or("stale_revision")?;
            if actual.to_string() != *expected {
                return Err("stale_revision".into());
            }
        }
    } else if input.branches.is_some() {
        return Err("validation_failed".into());
    }
    Ok(())
}
fn unavailable<T>(_: T) -> String {
    "unavailable".into()
}
pub async fn commit(
    pool: &SqlitePool,
    repo: &Repository,
    input: VerdictCommit,
    policy_guard: impl Fn() -> CaptureResult<()>,
) -> CaptureResult<bool> {
    if !input.key.starts_with("macroPilot:content-host:v2:")
        || input.key.len() > 1024
        || input.value_json.len() > 4 * 1024 * 1024
    {
        return Err("validation_failed".into());
    }
    let deadline =
        chrono::DateTime::parse_from_rfc3339(&input.execute_before).map_err(unavailable)?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    // Acquire SQLite's write lock before the final native observation. The
    // provisional decision is invisible until commit and rolls back on any error.
    let applied = sqlx::query(
        "INSERT INTO app_settings (key,value_json,updated_at) SELECT ?,?,? \
         WHERE (? IS NULL AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key=?)) \
         OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM app_settings WHERE key=? AND value_json=?)) \
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at"
    ).bind(&input.key).bind(&input.value_json).bind(chrono::Utc::now().to_rfc3339())
        .bind(&input.expected_value_json).bind(&input.key).bind(&input.expected_value_json).bind(&input.key).bind(&input.expected_value_json)
        .execute(&mut *tx).await.map_err(unavailable)?.rows_affected() == 1;
    if !applied {
        tx.rollback().await.map_err(unavailable)?;
        return Ok(false);
    }
    policy_guard()?;
    check_branches(repo, &input)?;
    if chrono::Utc::now() >= deadline || !fresh(repo, &input.snapshot_id, &input.request)? {
        return Err("stale_revision".into());
    }
    policy_guard()?;
    check_branches(repo, &input)?;
    if chrono::Utc::now() >= deadline {
        return Err("unavailable".into());
    }
    tx.commit().await.map_err(unavailable)?;
    Ok(true)
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::core::{create, PilotCaptureSource};
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn sqlite_wait_precedes_final_freshness_and_rolls_back_a_changed_source() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        std::fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        let request = PilotCaptureRequest {
            source: PilotCaptureSource::Unstaged,
            secret_values: vec![],
            policy_revision: "visible-1".into(),
        };
        let info = create(&repo, dir.path().to_path_buf(), request.clone()).unwrap();
        let repo = Arc::new(Mutex::new(repo));
        let runtime = Arc::new(tokio::runtime::Runtime::new().unwrap());
        let pool = runtime.block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(2)
                .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("metadata.sqlite")).create_if_missing(true)).await.unwrap();
            sqlx::query("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL)").execute(&pool).await.unwrap();
            pool
        });
        // Ignore the test metadata DB in Git, as Macro's actual metadata lives elsewhere.
        std::fs::write(dir.path().join(".git/info/exclude"), "metadata.sqlite*\n").unwrap();
        let info = create(
            &repo.lock().unwrap(),
            dir.path().to_path_buf(),
            request.clone(),
        )
        .unwrap_or(info);
        let mut blocker = runtime.block_on(pool.begin()).unwrap();
        runtime
            .block_on(
                sqlx::query("INSERT INTO app_settings VALUES('blocker','held','now')")
                    .execute(&mut *blocker),
            )
            .unwrap();
        let input = VerdictCommit {
            snapshot_id: info.snapshot_id.clone(),
            request: request.clone(),
            key: "macroPilot:content-host:v2:test".into(),
            expected_value_json: None,
            value_json: "approved".into(),
            branches: None,
            execute_before: (chrono::Utc::now() + chrono::Duration::seconds(8)).to_rfc3339(),
        };
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let worker_repo = repo.clone();
        let worker_pool = pool.clone();
        let worker_runtime = runtime.clone();
        let worker = std::thread::spawn(move || {
            let repo = worker_repo.lock().unwrap();
            locked_tx.send(()).unwrap();
            worker_runtime.block_on(commit(&worker_pool, &repo, input, || Ok(())))
        });
        locked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            repo.try_lock().is_err(),
            "Macro Git operations remain fenced while SQLite is busy"
        );
        // An external editor need not take Macro's lock. This edit happens while
        // SQLite is busy and must be caught by the final observation after the wait.
        std::fs::write(dir.path().join("file.txt"), "changed\n").unwrap();
        runtime.block_on(blocker.rollback()).unwrap();
        assert_eq!(worker.join().unwrap(), Err("stale_revision".into()));
        let value: Option<String> = runtime.block_on(sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key='macroPilot:content-host:v2:test'").fetch_optional(&pool)).unwrap();
        assert_eq!(value, None);
        let info = create(
            &repo.lock().unwrap(),
            dir.path().to_path_buf(),
            request.clone(),
        )
        .unwrap();
        let input = VerdictCommit {
            snapshot_id: info.snapshot_id,
            request,
            key: "macroPilot:content-host:v2:test".into(),
            expected_value_json: None,
            value_json: "approved".into(),
            branches: None,
            execute_before: (chrono::Utc::now() + chrono::Duration::seconds(8)).to_rfc3339(),
        };
        assert!(runtime
            .block_on(commit(&pool, &repo.lock().unwrap(), input, || Ok(())))
            .unwrap());
        let value: String = runtime.block_on(sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key='macroPilot:content-host:v2:test'").fetch_one(&pool)).unwrap();
        assert_eq!(value, "approved");
    }
    #[test]
    fn moved_tracked_branch_is_rejected_even_when_fixed_commit_objects_are_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
        let commit_file = |text: &str, parents: &[&git2::Commit<'_>]| {
            std::fs::write(dir.path().join("file.txt"), text).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("file.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(
                Some("HEAD"),
                &signature,
                &signature,
                "fixture",
                &tree,
                parents,
            )
            .unwrap()
        };
        let base = commit_file("before", &[]);
        let head = commit_file("after", &[&repo.find_commit(base).unwrap()]);
        repo.branch("target", &repo.find_commit(base).unwrap(), false)
            .unwrap();
        repo.branch("feature", &repo.find_commit(head).unwrap(), false)
            .unwrap();
        let request = PilotCaptureRequest {
            source: PilotCaptureSource::Commits {
                base_sha: base.to_string(),
                head_sha: head.to_string(),
            },
            secret_values: vec![],
            policy_revision: "visible-1".into(),
        };
        let info = create(&repo, dir.path().to_path_buf(), request.clone()).unwrap();
        // The immutable commit diff is unchanged, but the selected target moved.
        repo.find_reference("refs/heads/target")
            .unwrap()
            .set_target(head, "moved")
            .unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let pool = runtime.block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
            sqlx::query("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL)").execute(&pool).await.unwrap(); pool
        });
        let input = VerdictCommit {
            snapshot_id: info.snapshot_id,
            request,
            key: "macroPilot:content-host:v2:branches".into(),
            expected_value_json: None,
            value_json: "approved".into(),
            branches: Some(Branches {
                base: "target".into(),
                head: "feature".into(),
            }),
            execute_before: (chrono::Utc::now() + chrono::Duration::seconds(8)).to_rfc3339(),
        };
        assert_eq!(
            runtime.block_on(commit(&pool, &repo, input, || Ok(()))),
            Err("stale_revision".into())
        );
        let count: i64 = runtime
            .block_on(sqlx::query_scalar("SELECT count(*) FROM app_settings").fetch_one(&pool))
            .unwrap();
        assert_eq!(count, 0);
    }
}
