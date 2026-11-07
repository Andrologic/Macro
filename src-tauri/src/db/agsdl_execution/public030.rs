//! Public 0.3 human operations. Unattested records are never projected or resolved.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanScope030 {
    pub system_start_id: String,
    pub source: EngineSourceRevision,
}

/// A continuation must be bound to both the scope and a native snapshot token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanContinuation030 {
    pub scope: HumanScope030,
    pub cursor: String,
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanPage030 {
    pub scope: HumanScope030,
    pub cursor: String,
    pub total: String,
    pub requests: Vec<PublicHumanRequest030>,
    pub next_page: Option<HumanContinuation030>,
}

/// Only these explicitly public fields may be exposed after native attestation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicHumanRequest030 {
    pub id: String,
    pub revision: String,
    pub status: String,
    pub work_ids: Vec<String>,
    pub content: HumanContent030,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HumanContent030 {
    Approval {
        message: String,
        title: String,
        description: String,
        choices: Vec<String>,
    },
    Plan {
        plan: String,
    },
    Question {
        question: String,
        expected_response: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HumanAnswer030 {
    Approval {
        choice: String,
        comment: Option<String>,
    },
    Plan {
        accept: bool,
        comment: Option<String>,
    },
    Question {
        answer_json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanDecision030 {
    pub scope: HumanScope030,
    pub request_id: String,
    pub expected_revision: String,
    pub answer: HumanAnswer030,
}

fn check_scope(stored: &Stored, scope: &HumanScope030) -> Result<()> {
    require(
        stored.snapshot.system_start_id == scope.system_start_id
            && stored.snapshot.source == scope.source
            && stored.snapshot.versions.contract == "agsdl-0.3.0",
        "Human request scope or contract differs",
    )
}

fn conflict(message: &str) -> EngineFailure {
    failure("CONFLICT", "humanRequest", message)
}

fn content_valid(content: &HumanContent030, kind: &str) -> Result<()> {
    let encoded = encode(content)?;
    require(encoded.len() <= 65_536, "Public human content is too large")?;
    match content {
        HumanContent030::Approval { choices, .. } if kind == "ask" => {
            let unique: BTreeSet<_> = choices.iter().collect();
            require(
                !choices.is_empty()
                    && choices.len() <= 64
                    && unique.len() == choices.len()
                    && choices
                        .iter()
                        .all(|choice| !choice.trim().is_empty() && choice.len() <= 512),
                "Invalid public approval choices",
            )
        }
        HumanContent030::Plan { .. } if kind == "plan" => Ok(()),
        HumanContent030::Question { .. } if kind == "question" => Ok(()),
        _ => Err(failure(
            "CORRELATION",
            "content",
            "Public content kind differs",
        )),
    }
}

/// Native-only boundary. The caller must authenticate that the content and
/// choices are intended for a person; neither payload_json nor the model can
/// provide that attestation. No existing request is automatically published.
pub(crate) async fn attest_human(
    pool: &SqlitePool,
    request: &work_protocol030::HumanRequest030,
    content: &HumanContent030,
) -> Result<String> {
    content_valid(content, &request.kind)?;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let system = &request.owner.system_start_id;
    let stored = load(&mut tx, system).await?;
    owner(&stored.state, &request.owner, system)?;
    require(
        stored.snapshot.versions.contract == "agsdl-0.3.0",
        "Human request requires a 0.3 capture",
    )?;
    let row = sqlx::query("SELECT request_json,revision FROM engine_human_requests030 WHERE system_id=? AND request_id=?")
        .bind(system).bind(&request.request_id).fetch_optional(&mut *tx).await?
        .ok_or_else(|| failure("NOT_FOUND", "request", "Human request not found"))?;
    let saved: work_protocol030::HumanRequest030 = serde_json::from_str(row.get("request_json"))?;
    require(saved == *request, "Human request differs")?;
    let previous = sqlx::query("SELECT public_id,content_json FROM engine_human_public030 WHERE system_id=? AND request_id=?")
        .bind(system).bind(&request.request_id).fetch_optional(&mut *tx).await?;
    let content_json = encode(content)?;
    let id = if let Some(row) = previous {
        require(
            row.get::<&str, _>("content_json") == content_json,
            "Public attestation differs",
        )?;
        row.get("public_id")
    } else {
        require(
            row.get::<&str, _>("revision") == "0",
            "Cannot publish a resolved request",
        )?;
        require(
            matches!(stored.state.stop, EngineStopState::None),
            "Stopped system cannot publish",
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO engine_human_public030 VALUES (?,?,?,?)")
            .bind(system)
            .bind(&request.request_id)
            .bind(&id)
            .bind(content_json)
            .execute(&mut *tx)
            .await?;
        id
    };
    tx.commit().await?;
    Ok(id)
}

/// Generate native public identities for linked works before fixing the cursor.
async fn map_works(db: &mut SqliteConnection, system: &str) -> Result<()> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT DISTINCT w.activation_id FROM engine_human_works030 w JOIN engine_human_public030 p ON p.system_id=w.system_id AND p.request_id=w.request_id LEFT JOIN engine_human_public_works030 m ON m.system_id=w.system_id AND m.activation_id=w.activation_id WHERE w.system_id=? AND m.activation_id IS NULL")
        .bind(system).fetch_all(&mut *db).await?;
    for id in ids {
        sqlx::query("INSERT INTO engine_human_public_works030 VALUES (?,?,?)")
            .bind(system)
            .bind(id)
            .bind(uuid::Uuid::new_v4().to_string())
            .execute(&mut *db)
            .await?;
    }
    Ok(())
}

/// Pages are coherent while the native projection cursor is unchanged.
pub(crate) async fn human_page(
    pool: &SqlitePool,
    scope: HumanScope030,
    continuation: Option<HumanContinuation030>,
) -> Result<HumanPage030> {
    const PAGE: i64 = 64;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, &scope.system_start_id).await?;
    check_scope(&stored, &scope)?;
    map_works(&mut tx, &scope.system_start_id).await?;
    let cursor: Option<String> =
        sqlx::query_scalar("SELECT cursor FROM engine_human_projection030 WHERE system_id=?")
            .bind(&scope.system_start_id)
            .fetch_optional(&mut *tx)
            .await?;
    let cursor = cursor.unwrap_or_default();
    let offset = if let Some(page) = continuation {
        if page.scope != scope
            || page.cursor != cursor
            || page.offset == 0
            || page.offset % PAGE as u32 != 0
        {
            return Err(conflict(
                "Human projection changed or continuation is invalid",
            ));
        }
        page.offset
    } else {
        0
    };
    let total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_human_public030 WHERE system_id=?")
            .bind(&scope.system_start_id)
            .fetch_one(&mut *tx)
            .await?;
    let rows = sqlx::query("SELECT p.request_id,p.public_id,p.content_json,r.revision,s.request_id IS NOT NULL AS submitted FROM engine_human_public030 p JOIN engine_human_requests030 r ON r.system_id=p.system_id AND r.request_id=p.request_id LEFT JOIN engine_human_submissions030 s ON s.system_id=p.system_id AND s.request_id=p.request_id WHERE p.system_id=? ORDER BY p.public_id LIMIT ? OFFSET ?")
        .bind(&scope.system_start_id).bind(PAGE + 1).bind(i64::from(offset)).fetch_all(&mut *tx).await?;
    if offset > 0 && rows.is_empty() {
        return Err(conflict("Human continuation is beyond the projection"));
    }
    let has_more = rows.len() > PAGE as usize;
    let mut requests = Vec::new();
    for row in rows.into_iter().take(PAGE as usize) {
        let internal: String = row.get("request_id");
        let work_ids: Vec<String> = sqlx::query_scalar("SELECT m.public_id FROM engine_human_works030 w JOIN engine_human_public_works030 m ON m.system_id=w.system_id AND m.activation_id=w.activation_id WHERE w.system_id=? AND w.request_id=? ORDER BY m.public_id")
            .bind(&scope.system_start_id).bind(internal).fetch_all(&mut *tx).await?;
        let resolved = row.get::<&str, _>("revision") == "1";
        let submitted = row.get::<i64, _>("submitted") != 0;
        requests.push(PublicHumanRequest030 {
            id: row.get("public_id"),
            revision: (u8::from(resolved) + u8::from(submitted)).to_string(),
            status: if resolved {
                "resolved"
            } else if submitted {
                "submitted"
            } else {
                "open"
            }
            .into(),
            work_ids,
            content: serde_json::from_str(row.get("content_json"))?,
        });
    }
    let next_page = if has_more {
        Some(HumanContinuation030 {
            scope: scope.clone(),
            cursor: cursor.clone(),
            offset: offset
                .checked_add(PAGE as u32)
                .ok_or_else(|| conflict("Human page offset overflow"))?,
        })
    } else {
        None
    };
    tx.commit().await?;
    Ok(HumanPage030 {
        scope,
        cursor,
        total: total.to_string(),
        requests,
        next_page,
    })
}

fn validate_answer(content: &HumanContent030, answer: &HumanAnswer030) -> Result<()> {
    let valid = match (content, answer) {
        (
            HumanContent030::Approval { choices, .. },
            HumanAnswer030::Approval { choice, comment },
        ) => choices.contains(choice) && comment.as_ref().is_none_or(|c| c.len() <= 16_384),
        (HumanContent030::Plan { .. }, HumanAnswer030::Plan { comment, .. }) => {
            comment.as_ref().is_none_or(|c| c.len() <= 16_384)
        }
        // No attested structured response schema is persisted yet.
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(failure(
            "INPUT_CONSTRAINT",
            "answer",
            "Answer does not match the attested request",
        ))
    }
}

/// Atomically reserve one answer. This is not a resolution: only the trusted
/// native clock/controller can decide expiration and commit the actual answer.
pub(crate) async fn decide_human(pool: &SqlitePool, decision: HumanDecision030) -> Result<()> {
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, &decision.scope.system_start_id).await?;
    check_scope(&stored, &decision.scope)?;
    let row = sqlx::query("SELECT p.request_id,p.content_json,r.request_json,r.revision,s.request_id IS NOT NULL AS submitted FROM engine_human_public030 p JOIN engine_human_requests030 r ON r.system_id=p.system_id AND r.request_id=p.request_id LEFT JOIN engine_human_submissions030 s ON s.system_id=p.system_id AND s.request_id=p.request_id WHERE p.system_id=? AND p.public_id=?")
        .bind(&decision.scope.system_start_id).bind(&decision.request_id).fetch_optional(&mut *tx).await?
        .ok_or_else(|| failure("NOT_FOUND", "requestId", "Public human request not found"))?;
    if decision.expected_revision != "0"
        || row.get::<&str, _>("revision") != "0"
        || row.get::<i64, _>("submitted") != 0
    {
        return Err(conflict("Human request is closed or changed"));
    }
    let request: work_protocol030::HumanRequest030 = serde_json::from_str(row.get("request_json"))?;
    owner(
        &stored.state,
        &request.owner,
        &decision.scope.system_start_id,
    )?;
    require(
        matches!(stored.state.stop, EngineStopState::None),
        "Stopped system cannot accept an answer",
    )?;
    let contexts: Vec<String> = sqlx::query_scalar("SELECT p.context_json FROM engine_human_works030 w JOIN engine_work_protocol030 p ON p.system_id=w.system_id AND p.activation_id=w.activation_id WHERE w.system_id=? AND w.request_id=?")
        .bind(&decision.scope.system_start_id).bind(&request.request_id).fetch_all(&mut *tx).await?;
    let mut live_work = false;
    for raw in contexts {
        let current: EngineContext = serde_json::from_str(&raw)?;
        if current.owner != request.owner {
            return Err(conflict("Human work owner changed"));
        }
        if let Ok(a) = activation(&stored.state, &current.work) {
            if a.work_state == "active"
                && matches!(a.stop_state, EngineStopState::None)
                && !stored
                    .state
                    .rejected
                    .contains_key(&current.work.activation_id)
                && context(&stored, &current).is_ok()
            {
                live_work = true;
            }
        }
    }
    if !live_work {
        return Err(conflict("No live attributed work can accept a submission"));
    }
    let content: HumanContent030 = serde_json::from_str(row.get("content_json"))?;
    validate_answer(&content, &decision.answer)?;
    sqlx::query("INSERT INTO engine_human_submissions030 VALUES (?,?,?)")
        .bind(&decision.scope.system_start_id)
        .bind(&request.request_id)
        .bind(encode(&decision.answer)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Private broker recovery. Reading a submission grants no authority to resume
/// work; the native arbiter must revalidate the epoch, links, Stop and clock.
pub(crate) async fn pending_submissions(
    pool: &SqlitePool,
    system: &str,
) -> Result<Vec<(work_protocol030::HumanRequest030, HumanAnswer030)>> {
    let mut tx = pool.begin().await?;
    load(&mut tx, system).await?;
    let rows = sqlx::query("SELECT r.request_json,s.answer_json FROM engine_human_submissions030 s JOIN engine_human_requests030 r ON r.system_id=s.system_id AND r.request_id=s.request_id WHERE s.system_id=? AND r.revision='0' ORDER BY s.rowid")
        .bind(system).fetch_all(&mut *tx).await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        result.push((
            serde_json::from_str(row.get("request_json"))?,
            serde_json::from_str(row.get("answer_json"))?,
        ));
    }
    tx.commit().await?;
    Ok(result)
}

#[cfg(test)]
#[path = "public030_tests.rs"]
mod tests;
