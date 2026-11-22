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
    sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('old-conversation','old chat','Architect','now','now')")
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
    sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('recovered','chat','Architect','now','now'),('competing','chat','Architect','now','now')")
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
    sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('chat','chat','Architect','now','now')").execute(&pool).await.unwrap();
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
    let first = first.unwrap().summary.conversation_id.unwrap();
    assert_eq!(
        concurrent.unwrap().summary.conversation_id.as_deref(),
        Some(first.as_str())
    );
    assert_ne!(
        ensure_conversation(&pool, b)
            .await
            .unwrap()
            .summary
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
        .summary
        .conversation_id
        .unwrap();
    pool.close().await;
    let reopened = create_pool(&path).await.unwrap();
    assert_eq!(
        ensure_conversation(&reopened, a)
            .await
            .unwrap()
            .summary
            .conversation_id,
        Some(first)
    );
    assert_eq!(
        ensure_conversation(&reopened, archived)
            .await
            .unwrap()
            .summary
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

#[tokio::test]
async fn replicas_restore_independently_even_after_a_shared_legacy_binding() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("macro.db");
    let pool = create_pool(&path).await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO conversations(id,title,scope_mode,created_at,updated_at)
         VALUES('old-conversation','Design','Architect','2026-01-01','2026-01-01');
         INSERT INTO messages(id,conversation_id,role,content,created_at)
         VALUES('same-user-id','old-conversation','user','Local draft','2026-01-01');",
    )
    .execute(&pool)
    .await
    .unwrap();

    let mut ids = Vec::new();
    for content in ["Replica A", "Replica B"] {
        let mut input = legacy();
        input.source_id = content.into();
        let history = input.history.as_mut().unwrap();
        let messages = [
            json!({"id":"same-user-id","role":"user","content":content,"createdAt":"2026-01-01"}),
            json!({"id":"same-answer-id","role":"assistant","content":"Review","createdAt":"2026-01-01"}),
        ];
        history.insert(
            "origins".into(),
            json!([{
                "location": content,
                "transcript": messages.map(|message| message.to_string()).join("\n"),
            }]),
        );
        ids.push(import_blueprint(&pool, input).await.unwrap().blueprint_id);
    }
    assert_eq!(
        get_draft(&pool, ids[0].clone())
            .await
            .unwrap()
            .summary
            .conversation_id
            .as_deref(),
        Some("old-conversation")
    );
    assert_eq!(
        get_draft(&pool, ids[1].clone())
            .await
            .unwrap()
            .summary
            .conversation_id,
        None
    );

    // Older imports could share the legacy ID and falsely mark a divergent chat restored.
    sqlx::query("UPDATE architect_blueprints SET conversation_id='old-conversation' WHERE id=?")
        .bind(&ids[1])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,'true','now')")
        .bind(format!(
            "architect:restored-transcript:{}:old-conversation",
            ids[0]
        ))
        .execute(&pool)
        .await
        .unwrap();

    // Open the unmarked replica first so the previously marked row then has
    // exclusive ownership of the incompatible legacy conversation.
    let b = ensure_conversation(&pool, ids[1].clone())
        .await
        .unwrap()
        .summary
        .conversation_id
        .unwrap();
    let (a, a_again) = tokio::join!(
        ensure_conversation(&pool, ids[0].clone()),
        ensure_conversation(&pool, ids[0].clone()),
    );
    let a = a.unwrap().summary.conversation_id.unwrap();
    assert_eq!(a_again.unwrap().summary.conversation_id.as_ref(), Some(&a));
    assert_ne!(a, b);
    assert_ne!(a, "old-conversation");
    assert_ne!(b, "old-conversation");
    pool.close().await;

    let pool = create_pool(&path).await.unwrap();
    for ((blueprint, chat), content) in ids.into_iter().zip([a, b]).zip(["Replica A", "Replica B"])
    {
        let draft = get_draft(&pool, blueprint.clone()).await.unwrap();
        let history = draft.history.unwrap();
        assert_eq!(history["legacyConversationId"], "old-conversation");
        assert_eq!(history["origins"][0]["location"], content);
        assert_eq!(
            ensure_conversation(&pool, blueprint)
                .await
                .unwrap()
                .summary
                .conversation_id
                .as_ref(),
            Some(&chat)
        );
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT content,created_at FROM messages WHERE conversation_id=? ORDER BY created_at,id",
        ).bind(&chat).fetch_all(&pool).await.unwrap();
        assert_eq!(
            rows,
            [
                (content.into(), "2026-01-01".into()),
                ("Review".into(), "2026-01-01".into())
            ]
        );
    }
    let rows: Vec<String> =
        sqlx::query_scalar("SELECT content FROM messages WHERE conversation_id='old-conversation'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows, ["Local draft"]);
}

#[tokio::test]
async fn a_transcriptless_replica_never_claims_another_replicas_history() {
    for (first_import, first_open, staggered) in [
        (0, 0, false),
        (0, 1, false),
        (1, 0, false),
        (1, 1, false),
        (0, 0, true),
        (1, 1, true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("macro.db");
        let pool = create_pool(&path).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO conversations(id,title,scope_mode,created_at,updated_at)
             VALUES('old-conversation','Historical','Architect','2026-01-01','2026-01-01');
             INSERT INTO messages(id,conversation_id,role,content,created_at)
             VALUES('historical-message','old-conversation','user','Replica B','2026-01-01');",
        )
        .execute(&pool)
        .await
        .unwrap();
        let input = |index: usize| {
            let mut input = legacy();
            input.source_id = format!("replica-{index}");
            if index == 1 {
                input.history.as_mut().unwrap().insert(
                    "origins".into(),
                    json!([{"transcript": r#"{"role":"user","content":"Replica B","createdAt":"2026-01-01"}"#}]),
                );
            }
            input
        };
        let mut ids = [String::new(), String::new()];
        let mut chats = [String::new(), String::new()];
        for index in [first_import, 1 - first_import] {
            ids[index] = import_blueprint(&pool, input(index))
                .await
                .unwrap()
                .blueprint_id;
            if staggered && index == first_open {
                chats[index] = ensure_conversation(&pool, ids[index].clone())
                    .await
                    .unwrap()
                    .summary
                    .conversation_id
                    .unwrap();
            }
        }
        if !staggered {
            // Old databases could store both bindings and even a transcript marker.
            sqlx::query("UPDATE architect_blueprints SET conversation_id='old-conversation'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,'true','now')",
            )
            .bind(format!(
                "architect:verified-transcript:{}:old-conversation",
                ids[1]
            ))
            .execute(&pool)
            .await
            .unwrap();
        }
        for index in [first_open, 1 - first_open] {
            let (first, concurrent) = tokio::join!(
                ensure_conversation(&pool, ids[index].clone()),
                ensure_conversation(&pool, ids[index].clone()),
            );
            let first = first.unwrap();
            let chat = first.summary.conversation_id.unwrap();
            assert_eq!(
                concurrent.unwrap().summary.conversation_id.as_ref(),
                Some(&chat)
            );
            let recovery = first.draft_recovery.unwrap();
            assert_eq!(recovery.from_conversation_id, "old-conversation");
            assert_eq!(recovery.to_conversation_id, chat);
            assert!(!recovery.owned);
            if !chats[index].is_empty() {
                assert_eq!(chats[index], chat);
            }
            chats[index] = chat;
        }
        assert_ne!(chats[0], chats[1]);
        pool.close().await;
        let pool = create_pool(&path).await.unwrap();
        for index in 0..2 {
            let chat = &chats[index];
            assert_ne!(chat, "old-conversation");
            let resolution = ensure_conversation(&pool, ids[index].clone())
                .await
                .unwrap();
            assert_eq!(resolution.summary.conversation_id.as_ref(), Some(chat));
            let contents: Vec<String> =
                sqlx::query_scalar("SELECT content FROM messages WHERE conversation_id=?")
                    .bind(chat)
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                contents,
                if index == 0 {
                    vec![]
                } else {
                    vec!["Replica B"]
                }
            );
        }
        let original: String = sqlx::query_scalar(
            "SELECT content FROM messages WHERE id='historical-message' AND conversation_id='old-conversation'",
        )
        .fetch_one(&pool).await.unwrap();
        assert_eq!(original, "Replica B");
    }
}

#[tokio::test]
async fn existing_private_restore_marker_preserves_subsequent_edits() {
    let dir = tempfile::tempdir().unwrap();
    let pool = create_pool(&dir.path().join("macro.db")).await.unwrap();
    let mut input = legacy();
    input.history.as_mut().unwrap().insert(
        "origins".into(),
        json!([{"transcript": r#"{"role":"user","content":"Original message"}"#}]),
    );
    let blueprint = import_blueprint(&pool, input).await.unwrap().blueprint_id;
    sqlx::raw_sql(
        "INSERT INTO conversations(id,title,scope_mode,created_at,updated_at)
         VALUES('private','Design','Architect','now','now');
         INSERT INTO messages(id,conversation_id,role,content,created_at)
         VALUES('edited','private','user','Updated text','now');",
    )
    .execute(&pool)
    .await
    .unwrap();
    attach_conversation(&pool, blueprint.clone(), "private".into())
        .await
        .unwrap();
    sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,'true','now')")
        .bind(format!("architect:restored-transcript:{blueprint}:private"))
        .execute(&pool)
        .await
        .unwrap();
    let resolution = ensure_conversation(&pool, blueprint).await.unwrap();
    assert_eq!(
        resolution.summary.conversation_id.as_deref(),
        Some("private")
    );
    assert!(resolution.draft_recovery.is_none());
    let messages: Vec<String> =
        sqlx::query_scalar("SELECT content FROM messages WHERE conversation_id='private'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(messages, ["Updated text"]);
}

#[tokio::test]
async fn repair_of_an_exclusive_nonhistorical_binding_records_draft_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let pool = create_pool(&dir.path().join("macro.db")).await.unwrap();
    let mut input = legacy();
    input.history.as_mut().unwrap().insert(
        "origins".into(),
        json!([{"transcript": r#"{"role":"user","content":"Archived"}"#}]),
    );
    sqlx::raw_sql(
        "INSERT INTO conversations(id,title,scope_mode,created_at,updated_at)
         VALUES('private','Design','Architect','now','now');
         INSERT INTO messages(id,conversation_id,role,content,created_at)
         VALUES('private-message','private','user','Different','now');",
    )
    .execute(&pool)
    .await
    .unwrap();
    let blueprint = import_blueprint(&pool, input).await.unwrap().blueprint_id;
    attach_conversation(&pool, blueprint.clone(), "private".into())
        .await
        .unwrap();
    let resolution = ensure_conversation(&pool, blueprint.clone()).await.unwrap();
    let chat = resolution.summary.conversation_id.unwrap();
    assert_ne!(chat, "private");
    assert!(resolution.draft_recovery.unwrap().owned);
    let resumed = ensure_conversation(&pool, blueprint).await.unwrap();
    let recovery = resumed.draft_recovery.unwrap();
    assert!(recovery.owned);
    assert_eq!(recovery.from_conversation_id, "private");
    assert_eq!(recovery.to_conversation_id, chat);
    let original: String =
        sqlx::query_scalar("SELECT content FROM messages WHERE id='private-message'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(original, "Different");
}

#[tokio::test]
async fn a_chat_can_only_be_attached_to_one_blueprint() {
    let dir = tempfile::tempdir().unwrap();
    let pool = create_pool(&dir.path().join("macro.db")).await.unwrap();
    let project = create_project(&pool, "Library".into()).await.unwrap();
    let a = create_blueprint(&pool, project.id.clone(), "A".into(), document())
        .await
        .unwrap()
        .summary
        .id;
    let b = create_blueprint(&pool, project.id, "B".into(), document())
        .await
        .unwrap()
        .summary
        .id;
    sqlx::raw_sql(
        "INSERT INTO conversations(id,title,scope_mode,created_at,updated_at)
        VALUES('design','Design','Architect','now','now'),('chat','Chat','Chat','now','now')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (first, second) = tokio::join!(
        attach_conversation(&pool, a.clone(), "design".into()),
        attach_conversation(&pool, b.clone(), "design".into()),
    );
    assert_ne!(first.is_ok(), second.is_ok());
    let (winner, loser) = if first.is_ok() { (a, b) } else { (b, a) };
    attach_conversation(&pool, winner, "design".into())
        .await
        .unwrap();
    assert!(attach_conversation(&pool, loser.clone(), "chat".into())
        .await
        .is_err());
    let chat = ensure_conversation(&pool, loser)
        .await
        .unwrap()
        .summary
        .conversation_id
        .unwrap();
    assert_ne!(chat, "design");
    assert_ne!(chat, "chat");
}
