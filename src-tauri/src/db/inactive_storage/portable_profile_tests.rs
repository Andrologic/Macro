use super::*;

fn portable_records() -> Vec<(RecordKind, Vec<u8>)> {
    vec![
        (
            RecordKind::HistoricalText {
                purpose: TextPurpose::PortableMetadata,
            },
            br#"{"classification":"retained_original","source":{"row":1,"family":1,"tag":4}}"#
                .to_vec(),
        ),
        (
            RecordKind::Message { role: Role::User },
            b"recoverable history".to_vec(),
        ),
        (
            RecordKind::HistoricalText {
                purpose: TextPurpose::OriginalText,
            },
            b"original history".to_vec(),
        ),
        (
            RecordKind::Association {
                from: 1,
                to: 2,
                position: 0,
                relation: Relation::DataForMessage,
            },
            vec![],
        ),
    ]
}
fn portable_intent(records: &[(RecordKind, Vec<u8>)]) -> (Begin, Vec<RecordHeader>) {
    let (mut begin, mut headers) = intent(records);
    begin.profile = Profile::PortableChatHistoryV1;
    for header in &mut headers {
        if !matches!(
            header.entry,
            RecordKind::Association { .. }
                | RecordKind::HistoricalText {
                    purpose: TextPurpose::PortableMetadata
                }
        ) {
            header.origin = Some(0);
        }
    }
    rehash(&mut begin, &headers);
    (begin, headers)
}
fn rehash(begin: &mut Begin, headers: &[RecordHeader]) {
    let mut manifest = Manifest::new(begin).unwrap();
    for header in headers {
        manifest.record(header).unwrap();
    }
    begin.manifest_sha256 = manifest.finish();
}

#[test]
fn legacy_headers_remain_byte_identical_and_new_profile_is_explicit() {
    let (_, headers) = intent(&[(RecordKind::Message { role: Role::User }, b"legacy".to_vec())]);
    let expected = format!(
        r#"{{"ordinal":0,"entry":{{"kind":"message","role":"user"}},"bytes":6,"sha256":"{}"}}"#,
        digest(b"legacy")
    );
    assert_eq!(json(&headers[0]).unwrap(), expected);
    assert_eq!(
        parse::<RecordHeader>(expected.as_bytes()).unwrap(),
        headers[0]
    );
    let mut modified = headers[0].clone();
    modified.origin = Some(1);
    let (begin, _) = intent(&[(RecordKind::Message { role: Role::User }, b"legacy".to_vec())]);
    assert_eq!(
        validate_profile_record(&begin, &modified).unwrap_err(),
        "invalid_profile"
    );
    for purpose in [
        TextPurpose::PortableMetadata,
        TextPurpose::OriginalText,
        TextPurpose::HistoricalData,
    ] {
        modified.origin = None;
        modified.entry = RecordKind::HistoricalText { purpose };
        assert_eq!(
            validate_profile_record(&begin, &modified).unwrap_err(),
            "invalid_profile"
        );
    }
}

#[tokio::test]
async fn portable_profile_seals_replays_and_reopens_with_same_mapping() {
    let (dir, store, clock) = fixture().await;
    let records = portable_records();
    let (begin, headers) = portable_intent(&records);
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    for (header, (_, bytes)) in headers.iter().zip(&records) {
        append_record(&store, &receipt.key, header, bytes).await;
    }
    let sealed = store.seal_storage(&receipt.key).await.unwrap();
    let before = store.readback(&receipt.key, None, 32).await.unwrap();
    assert_eq!(before.fragments.len(), 4);
    assert_eq!(before.fragments[1].record.origin, Some(0));
    assert!(before
        .fragments
        .iter()
        .take(3)
        .all(|f| f.target_uuid.is_some()));
    let identities: Vec<_> = before
        .fragments
        .iter()
        .map(|f| f.target_uuid.clone())
        .collect();
    let old = store.pool.clone();
    drop(store);
    old.close().await;
    let pool = create_pool(&dir.path().join("target.db")).await.unwrap();
    let reopened = active(pool, clock);
    assert_eq!(
        reopened
            .begin(json(&begin).unwrap().as_bytes())
            .await
            .unwrap(),
        sealed.receipt
    );
    let after = reopened.readback(&receipt.key, None, 32).await.unwrap();
    assert_eq!(
        after
            .fragments
            .iter()
            .map(|f| f.target_uuid.clone())
            .collect::<Vec<_>>(),
        identities
    );
    assert_eq!(reopened.seal_storage(&receipt.key).await.unwrap(), sealed);
}

#[tokio::test]
async fn portable_missing_origin_refuses_before_record_admission_and_wrong_kind_refuses_seal() {
    for origin in [None, Some(1), Some(4)] {
        let (_dir, store, _clock) = fixture().await;
        let records = portable_records();
        let (begin, mut headers) = portable_intent(&records);
        let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
        append_record(&store, &receipt.key, &headers[0], &records[0].1).await;
        let before = store.status(&receipt.key).await.unwrap();
        headers[1].origin = origin;
        let error = store
            .append(
                &receipt.key,
                json(&Append {
                    record: headers[1].clone(),
                    offset: 0,
                    sha256: digest(&records[1].1),
                })
                .unwrap()
                .as_bytes(),
                &records[1].1,
            )
            .await
            .unwrap_err();
        assert_eq!(error, "invalid_origin");
        assert_eq!(store.status(&receipt.key).await.unwrap(), before);
    }
    let (_dir, store, _clock) = fixture().await;
    let records = portable_records();
    let (mut begin, mut headers) = portable_intent(&records);
    headers[1].origin = Some(2);
    rehash(&mut begin, &headers);
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    for (header, (_, bytes)) in headers.iter().zip(&records) {
        append_record(&store, &receipt.key, header, bytes).await;
    }
    assert_eq!(
        store.seal_storage(&receipt.key).await.unwrap_err(),
        "invalid_origin"
    );
    assert_eq!(
        store.status(&receipt.key).await.unwrap().phase,
        Phase::Verifying
    );
}

#[tokio::test]
async fn explicit_null_origin_refuses_before_admission_and_replay_for_both_profiles() {
    for portable in [false, true] {
        let (_dir, store, _clock) = fixture().await;
        let records = if portable {
            portable_records()
        } else {
            vec![(RecordKind::Message { role: Role::User }, b"legacy".to_vec())]
        };
        let (begin, headers) = if portable {
            portable_intent(&records)
        } else {
            intent(&records)
        };
        let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
        let mut control = serde_json::to_value(Append {
            record: headers[0].clone(),
            offset: 0,
            sha256: digest(&records[0].1),
        })
        .unwrap();
        control["record"]["origin"] = serde_json::Value::Null;
        let invalid = serde_json::to_vec(&control).unwrap();
        for replay in [false, true] {
            if replay {
                append_record(&store, &receipt.key, &headers[0], &records[0].1).await;
            }
            let before = store.status(&receipt.key).await.unwrap();
            assert!(store
                .append(&receipt.key, &invalid, &records[0].1)
                .await
                .is_err());
            assert_eq!(store.status(&receipt.key).await.unwrap(), before);
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM e_inactive_records")
                .fetch_one(&store.pool)
                .await
                .unwrap();
            assert_eq!(count, if replay { 1 } else { 0 });
        }
    }
}
