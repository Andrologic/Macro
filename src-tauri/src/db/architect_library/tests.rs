use super::*;
use crate::db::create_pool;
use serde_json::json;

fn document() -> Document {
    serde_json::from_value(json!({
        "source": " { \"contract\" : \"agsdl-0.3.0\", \"opaque\": 98765432109876543210123456789 }\n",
        "annexes": { "guide.md": "# Étude\r\n" },
        "design": { "purpose": "Review", "futureField": [false, null] },
        "display": { "title": "Draft" },
        "migration": { "original": "evidence" }
    })).unwrap()
}

fn legacy() -> Import {
    Import {
        source_project_id: "repo-id".into(),
        source_id: "branch/plan-id".into(),
        project_name: "Project".into(),
        name: "Blueprint".into(),
        history: Some(
            serde_json::from_value(
                json!({"status": "archived", "transcript": ["original message"]}),
            )
            .unwrap(),
        ),
        conversation_id: Some("old-conversation".into()),
        document: document(),
    }
}

#[tokio::test]
async fn atomic_import_recovers_after_failed_freeze_and_concurrent_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("macro.db");
    let pool = create_pool(&path).await.unwrap();
    sqlx::raw_sql("CREATE TRIGGER inject_failure BEFORE INSERT ON architect_versions BEGIN SELECT RAISE(ABORT,'injected'); END;").execute(&pool).await.unwrap();
    assert!(import_blueprint(&pool, legacy()).await.is_err());
    assert!(list_projects(&pool).await.unwrap().is_empty());
    sqlx::query("DROP TRIGGER inject_failure")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let pool = create_pool(&path).await.unwrap();
    sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('old-conversation','old chat','now','now')")
        .execute(&pool).await.unwrap();
    let (a, b) = tokio::join!(
        import_blueprint(&pool, legacy()),
        import_blueprint(&pool, legacy())
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.blueprint_id, b.blueprint_id);
    assert_ne!(a.imported, b.imported);
    assert_eq!(a.project_id, b.project_id);
    let id = a.blueprint_id;
    assert_eq!(list_versions(&pool, id.clone()).await.unwrap().len(), 1);
    let before = get_draft(&pool, id.clone()).await.unwrap();
    assert!(before.summary.archived);
    assert_eq!(
        before.summary.conversation_id.as_deref(),
        Some("old-conversation")
    );
    sqlx::query("DELETE FROM conversations WHERE id='old-conversation'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('recovered','chat','now','now'),('competing','chat','now','now')")
        .execute(&pool).await.unwrap();
    assert!(
        attach_conversation(&pool, id.clone(), "still-missing".into())
            .await
            .is_err()
    );
    let (first, second) = tokio::join!(
        attach_conversation(&pool, id.clone(), "recovered".into()),
        attach_conversation(&pool, id.clone(), "competing".into()),
    );
    assert_ne!(first.is_ok(), second.is_ok());
    assert_eq!(
        before.history.as_ref().unwrap()["legacyConversationId"],
        "old-conversation"
    );
    let mut edited = document();
    edited.source = "incomplete edit".into();
    save_draft(&pool, id.clone(), 1, edited).await.unwrap();
    pool.close().await;
    let pool = create_pool(&path).await.unwrap();
    let again = import_blueprint(&pool, legacy()).await.unwrap();
    assert!(!again.imported);
    let draft = get_draft(&pool, id.clone()).await.unwrap();
    assert_eq!(draft.document.source, "incomplete edit");
    assert_eq!(draft.history, before.history);
    let original = get_version(
        &pool,
        VersionKey {
            blueprint_id: id,
            number: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        encode(&original.document).unwrap(),
        encode(&document()).unwrap()
    );
}

#[tokio::test]
async fn conflicting_edits_versions_and_pinned_uses() {
    let dir = tempfile::tempdir().unwrap();
    let pool = create_pool(&dir.path().join("macro.db")).await.unwrap();
    let project = create_project(&pool, "Project".into()).await.unwrap();
    let draft = create_blueprint(&pool, project.id.clone(), "Blueprint".into(), document())
        .await
        .unwrap();
    let id = draft.summary.id;
    sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('chat','chat','now','now')").execute(&pool).await.unwrap();
    attach_conversation(&pool, id.clone(), "chat".into())
        .await
        .unwrap();
    assert!(attach_conversation(&pool, id.clone(), "other".into())
        .await
        .is_err());
    let mut changed = document();
    changed.source.push('\n');
    let (a, b) = tokio::join!(
        save_draft(&pool, id.clone(), 1, changed),
        save_draft(&pool, id.clone(), 1, document())
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert!(save_version(&pool, id.clone(), 1, None).await.is_err());
    let (a, b) = tokio::join!(
        save_version(&pool, id.clone(), 2, Some("first caller".into())),
        save_version(&pool, id.clone(), 2, None)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a.key.number, b.key.number);
    let keys = list_versions(&pool, id.clone()).await.unwrap();
    assert_eq!(
        keys.iter().map(|v| v.key.number).collect::<Vec<_>>(),
        vec![2, 1]
    );
    assert_eq!(
        get_version(&pool, a.key.clone())
            .await
            .unwrap()
            .summary
            .note,
        a.note
    );
    assert!(sqlx::query("UPDATE architect_versions SET note=NULL")
        .execute(&pool)
        .await
        .is_err());
    let key = keys[0].key.clone();
    let copy = adapt_version(&pool, key.clone(), project.id, "Adapted".into())
        .await
        .unwrap();
    assert_eq!(copy.summary.origin.unwrap().number, key.number);
    assert_eq!(
        encode(&copy.document).unwrap(),
        encode(&get_version(&pool, key.clone()).await.unwrap().document).unwrap()
    );
    assert_eq!(copy.summary.conversation_id, None);
    for kind in ["execution", "schedule"] {
        let usage = || Usage {
            kind: kind.into(),
            owner_id: "owner".into(),
        };
        record_use(&pool, key.clone(), usage()).await.unwrap();
        record_use(&pool, key.clone(), usage()).await.unwrap();
        assert!(record_use(&pool, keys[1].key.clone(), usage())
            .await
            .is_err());
        assert!(delete_version(&pool, key.clone()).await.is_err());
        release_use(&pool, keys[1].key.clone(), usage())
            .await
            .unwrap();
        assert_eq!(list_uses(&pool, key.clone()).await.unwrap().len(), 1);
        release_use(&pool, key.clone(), usage()).await.unwrap();
    }
    delete_version(&pool, key).await.unwrap();
    assert_eq!(
        save_version(&pool, id, 2, None).await.unwrap().key.number,
        3
    );
    assert_eq!(
        get_draft(&pool, copy.summary.id)
            .await
            .unwrap()
            .summary
            .origin
            .unwrap()
            .number,
        2
    );
}

#[tokio::test]
async fn blueprint_chats_restore_once_without_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("macro.db");
    let pool = create_pool(&path).await.unwrap();
    let project = create_project(&pool, "Library".into()).await.unwrap();
    let a = create_blueprint(&pool, project.id.clone(), "Same".into(), document())
        .await
        .unwrap()
        .summary
        .id;
    let b = create_blueprint(&pool, project.id, "Same".into(), document())
        .await
        .unwrap()
        .summary
        .id;
    let (first, concurrent) = tokio::join!(
        ensure_conversation(&pool, a.clone()),
        ensure_conversation(&pool, a.clone())
    );
    let first = first.unwrap().conversation_id.unwrap();
    assert_eq!(
        concurrent.unwrap().conversation_id.as_deref(),
        Some(first.as_str())
    );
    assert_ne!(
        ensure_conversation(&pool, b)
            .await
            .unwrap()
            .conversation_id
            .unwrap(),
        first
    );
    let mut archived = legacy();
    archived.history.as_mut().unwrap().insert("origins".into(), json!([{"transcript":"{\"role\":\"user\",\"content\":\"Initial design\"}\n{\"role\":\"assistant\",\"content\":\"Review\"}"}]));
    let archived = import_blueprint(&pool, archived)
        .await
        .unwrap()
        .blueprint_id;
    assert!(require_editable(&pool, &archived).await.is_err());
    let archive_chat = ensure_conversation(&pool, archived.clone())
        .await
        .unwrap()
        .conversation_id
        .unwrap();
    pool.close().await;
    let reopened = create_pool(&path).await.unwrap();
    assert_eq!(
        ensure_conversation(&reopened, a)
            .await
            .unwrap()
            .conversation_id,
        Some(first)
    );
    assert_eq!(
        ensure_conversation(&reopened, archived)
            .await
            .unwrap()
            .conversation_id
            .as_ref(),
        Some(&archive_chat)
    );
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM messages WHERE conversation_id=? ORDER BY created_at,id",
    )
    .bind(archive_chat)
    .fetch_all(&reopened)
    .await
    .unwrap();
    assert_eq!(rows, ["Initial design", "Review"]);
}
