//! Historical public diagnostics are projected from a fixed native event boundary.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticIdentity {
    pub id: String,
    pub sequence: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticRequest {
    pub system_start_id: String,
    pub source: EngineSourceRevision,
    pub activation_id: Option<String>,
    pub through: String,
    #[serde(default)]
    pub selected: Option<Vec<DiagnosticIdentity>>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub recent: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicDiagnostic {
    pub id: String,
    pub sequence: String,
    pub work: Option<EngineWork>,
    pub code: String,
    pub pointer: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicExecutionDiagnostic {
    pub source: EngineSourceRevision,
    pub system_start_id: String,
    pub activation: Option<EngineWork>,
    pub through: String,
    pub diagnostics: Vec<PublicDiagnostic>,
    pub incomplete: bool,
    pub next_before: Option<String>,
}
fn known_message(code: &str) -> (&'static str, &'static str) {
    match code {
        "RECOVERY_RESULT_LOST" => ("RECOVERY_RESULT_LOST", "The native process ended. Its tool result was lost; inspect workspace effects before starting another execution."),
        "VISIT_LIMIT" => ("VISIT_LIMIT", "The step reached its captured visit limit."),
        "OUTPUT_CONSTRAINT" => (
            "OUTPUT_CONSTRAINT",
            "The Agent output does not satisfy its declared interface.",
        ),
        "INPUT_CONSTRAINT" => (
            "INPUT_CONSTRAINT",
            "The delivered input does not satisfy its declared interface.",
        ),
        "CALL_RESULT" => (
            "CALL_RESULT",
            "The tool result does not satisfy its captured contract.",
        ),
        "PERMISSION" => (
            "PERMISSION",
            "The invocation is not permitted in its captured scope.",
        ),
        "OPERAND" => ("OPERAND", "A declared operand could not be resolved."),
        "CONTENT_UNAVAILABLE" => (
            "CONTENT_UNAVAILABLE",
            "Required content is unavailable in the inline profile.",
        ),
        "RESOURCE_COLLISION" => (
            "RESOURCE_COLLISION",
            "Content declares conflicting resource identities.",
        ),
        "EXECUTION_COMPLETED" => ("EXECUTION_COMPLETED", "This activation completed."),
        "EXECUTION_STOPPED" => (
            "EXECUTION_STOPPED",
            "This activation stopped with native termination evidence.",
        ),
        "EXECUTION_UNCERTAIN" => (
            "EXECUTION_UNCERTAIN",
            "Termination is not confirmed. The activation remains owned and cannot be replayed.",
        ),
        "STOP_CONFIRMED" => ("STOP_CONFIRMED", "The native owner confirmed the stop."),
        "STOP_REQUESTED" => (
            "STOP_REQUESTED",
            "Stop was requested. This request alone does not confirm termination.",
        ),
        _ => (
            "EXECUTION_FAILED",
            "This activation failed. Private execution details are retained by the native owner.",
        ),
    }
}
fn project(event: EngineEvent) -> Result<PublicDiagnostic> {
    let payload: serde_json::Value = serde_json::from_str(&event.payload_json)?;
    let code = match event.kind.as_str() {
        "terminal" => match payload.pointer("/outcome/kind").and_then(|v| v.as_str()) {
            Some("completed") => "EXECUTION_COMPLETED",
            Some("stopped") => "EXECUTION_STOPPED",
            Some("failed") => payload
                .pointer("/outcome/code")
                .and_then(|v| v.as_str())
                .unwrap_or("EXECUTION_FAILED"),
            _ => "EXECUTION_FAILED",
        },
        "uncertain" => "EXECUTION_UNCERTAIN",
        "stop" if payload.get("kind").and_then(|v| v.as_str()) == Some("confirmed") => {
            "STOP_CONFIRMED"
        }
        "stop" => "STOP_REQUESTED",
        _ => payload
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("EXECUTION_FAILED"),
    };
    let (code, message) = known_message(code);
    // Never use an arbitrary error string or private payload as a public pointer.
    // These repository events have no authenticated source-location witness.
    Ok(PublicDiagnostic {
        id: format!("{}:{}", event.system_start_id, event.sequence),
        sequence: event.sequence,
        work: event.work,
        code: code.into(),
        pointer: String::new(),
        message: message.into(),
    })
}
pub(crate) async fn read(
    pool: &SqlitePool,
    request: DiagnosticRequest,
) -> Result<PublicExecutionDiagnostic> {
    decimal(&request.through)?;
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let stored = load(&mut tx, &request.system_start_id).await?;
    require(
        stored.snapshot.source == request.source,
        "Diagnostic source differs from the retained snapshot",
    )?;
    require(
        order(&request.through, &stored.state.cursor).is_le(),
        "Diagnostic cursor is beyond retained events",
    )?;
    if request.through != "0" {
        let exists: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_events WHERE system_id = ? AND sequence = ?",
        )
        .bind(&request.system_start_id)
        .bind(&request.through)
        .fetch_one(&mut *tx)
        .await?;
        require(exists == 1, "Diagnostic cursor does not exist in this run")?;
    }
    let activation = if let Some(id) = &request.activation_id {
        let a = stored.state.activations.get(id).ok_or_else(|| {
            failure(
                "CORRELATION",
                "activationId",
                "Activation does not belong to this run",
            )
        })?;
        let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_events WHERE system_id = ? AND json_extract(event_json,'$.work.activationId') = ? AND (length(sequence) < length(?) OR (length(sequence) = length(?) AND sequence <= ?))")
            .bind(&request.system_start_id).bind(id).bind(&request.through).bind(&request.through).bind(&request.through).fetch_one(&mut *tx).await?;
        require(
            exists > 0,
            "Activation did not exist at the diagnostic cursor",
        )?;
        Some(a.delivery.delivery.work.clone())
    } else {
        None
    };
    let (diagnostics, incomplete, next_before) = if let Some(selected) = &request.selected {
        require(
            selected.len() <= 64 && request.before.is_none() && !request.recent,
            "Explicit diagnostic selection cannot mix pagination or exceed its bound",
        )?;
        let mut seen = BTreeSet::new();
        let mut result = Vec::new();
        for selected in selected {
            decimal(&selected.sequence)?;
            require(
                selected.id == format!("{}:{}", request.system_start_id, selected.sequence)
                    && seen.insert(selected.sequence.clone())
                    && order(&selected.sequence, &request.through).is_le(),
                "Diagnostic identity is duplicate, foreign or future",
            )?;
            let raw: String = sqlx::query_scalar(
                "SELECT event_json FROM engine_events WHERE system_id=? AND sequence=?",
            )
            .bind(&request.system_start_id)
            .bind(&selected.sequence)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| failure("NOT_FOUND", "selected", "Selected diagnostic is absent"))?;
            let event: EngineEvent = serde_json::from_str(&raw)?;
            require(
                matches!(
                    event.kind.as_str(),
                    "diagnostic" | "uncertain" | "stop" | "terminal"
                ) && request.activation_id.as_ref().is_none_or(|id| {
                    event
                        .work
                        .as_ref()
                        .is_some_and(|work| &work.activation_id == id)
                }),
                "Selected event is not a diagnostic of this activation",
            )?;
            result.push(project(event)?);
        }
        (result, false, None)
    } else {
        if let Some(before) = &request.before {
            decimal(before)?;
            require(
                request.recent && order(before, &request.through).is_le(),
                "Before requires recent mode and a retained cursor",
            )?;
            let exists: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM engine_events WHERE system_id=? AND sequence=?",
            )
            .bind(&request.system_start_id)
            .bind(before)
            .fetch_one(&mut *tx)
            .await?;
            require(exists == 1, "Pagination cursor does not belong to this run")?;
        }
        let query="SELECT event_json FROM engine_events WHERE system_id = ? AND (? IS NULL OR json_extract(event_json,'$.work.activationId') = ?) AND (length(sequence) < length(?) OR (length(sequence) = length(?) AND sequence <= ?)) AND (? IS NULL OR length(sequence) < length(?) OR (length(sequence) = length(?) AND sequence < ?)) AND json_extract(event_json,'$.kind') IN ('diagnostic','uncertain','stop','terminal') ORDER BY CASE WHEN ? THEN length(sequence) END DESC, CASE WHEN ? THEN sequence END DESC, length(sequence), sequence LIMIT 65";
        let rows: Vec<String> = sqlx::query_scalar(query)
            .bind(&request.system_start_id)
            .bind(&request.activation_id)
            .bind(&request.activation_id)
            .bind(&request.through)
            .bind(&request.through)
            .bind(&request.through)
            .bind(&request.before)
            .bind(&request.before)
            .bind(&request.before)
            .bind(&request.before)
            .bind(request.recent)
            .bind(request.recent)
            .fetch_all(&mut *tx)
            .await?;
        let incomplete = rows.len() > 64;
        let diagnostics = rows
            .into_iter()
            .take(64)
            .map(|raw| project(serde_json::from_str(&raw)?))
            .collect::<Result<Vec<_>>>()?;
        let next = if request.recent && incomplete {
            diagnostics.last().map(|d| d.sequence.clone())
        } else {
            None
        };
        (diagnostics, incomplete, next)
    };
    tx.commit().await?;
    Ok(PublicExecutionDiagnostic {
        source: request.source,
        system_start_id: request.system_start_id,
        activation,
        through: request.through,
        diagnostics,
        incomplete,
        next_before,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_error_payload_never_becomes_public_text_or_pointer() {
        let event = EngineEvent { system_start_id: "system".into(), sequence: "7".into(), work: None, kind: "terminal".into(), payload_json: r#"{"outcome":{"kind":"failed","code":"secret-in-code","errorJson":"secret-in-error"},"memory":"secret-in-memory"}"#.into() };
        let output = serde_json::to_string(&project(event).unwrap()).unwrap();
        assert!(!output.contains("secret-in"));
        let (code, message) = known_message("OUTPUT_CONSTRAINT");
        assert_eq!(code, "OUTPUT_CONSTRAINT");
        assert!(message.chars().count() <= 512);
    }
}
