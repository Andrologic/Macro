//! A host validation is bound to durable inputs before it can select a declared route.
//! Only native preparation mints successor identities. A lost acknowledgement reuses them.
use super::*;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Validation {
    pub snapshot_digest: String,
    pub input: EngineValue,
    pub declaration_json: Option<String>,
    pub closure_digest: String,
    /// Semantic result of the trusted embedded evaluator, correlated with the fields above.
    /// Rust reconstructs the destination from the captured declaration, never this value alone.
    pub selected_branch: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Prepare {
    pub owner: EngineOwner,
    pub work: EngineWork,
    pub outcome: EngineOutcome,
    pub response_cursor: String,
    pub termination_evidence_json: String,
    pub memory: Option<EngineMemory>,
    pub validation: Validation,
}
/// Not deserializable from IPC. The host can only reference a native retained witness by ID.
pub(crate) struct PreparedTerminalWitness {
    id: String,
    generation: String,
    request: Prepare,
    commit: EngineTerminalCommit,
}
#[derive(Serialize, Deserialize)]
struct Retained {
    id: String,
    generation: String,
    request: Prepare,
    commit: EngineTerminalCommit,
    final_commit: Option<EngineTerminalCommit>,
}
pub(crate) fn snapshot_digest(snapshot: &EngineSnapshot) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(encode(snapshot)?.as_bytes())
    ))
}
fn declaration(snapshot: &EngineSnapshot, work: &EngineWork) -> Result<Option<String>> {
    let Some(address) = &work.step else {
        return Ok(None);
    };
    require(
        address.len() == 1,
        "Nested routes are outside the inline profile",
    )?;
    let document: Value = serde_json::from_str(&snapshot.authored_source)?;
    let step = document
        .get("flow")
        .and_then(|v| v.get("steps"))
        .and_then(|v| v.get(&address[0]))
        .ok_or_else(|| failure("CORRELATION", "step", "Step declaration is absent"))?;
    Ok(Some(encode(step)?))
}
pub(super) fn target(snapshot: &EngineSnapshot, request: &Prepare) -> Result<Option<Vec<String>>> {
    let expected = declaration(snapshot, &request.work)?;
    require(
        equal_optional(
            expected.as_deref(),
            request.validation.declaration_json.as_deref(),
        )?,
        "Validated declaration differs from frozen source",
    )?;
    let Some(raw) = expected else {
        if let EngineOutcome::Completed { output } = &request.outcome {
            require(
                output.origin == "agent",
                "Graphless Agent output has another origin",
            )?;
        }
        require(
            request.validation.selected_branch.is_none(),
            "Graphless work has no branch",
        )?;
        return Ok(None);
    };
    let step: Value = serde_json::from_str(&raw)?;
    let destinations = match &request.outcome {
        EngineOutcome::Stopped { .. } => return Ok(None),
        EngineOutcome::Failed { .. } => {
            require(
                request.validation.selected_branch.is_none(),
                "Failure cannot select a success branch",
            )?;
            step.get("onError")
        }
        EngineOutcome::Completed { output } => {
            let step_type = step.get("type").and_then(Value::as_str);
            if step_type != Some("condition") {
                require(
                    step_type == Some(output.origin.as_str()),
                    "Output origin contradicts its step",
                )?;
            }
            match step_type {
                Some("condition") => {
                    require(
                        record_equal(output, &request.validation.input)?,
                        "Condition changed its durable input",
                    )?;
                    let branch = request
                        .validation
                        .selected_branch
                        .as_deref()
                        .filter(|v| matches!(*v, "true" | "false"))
                        .ok_or_else(|| {
                            failure(
                                "CORRELATION",
                                "branch",
                                "Condition validation is incomplete",
                            )
                        })?;
                    step.get("next").and_then(|v| v.get(branch))
                }
                Some("agent") if step.get("decision").is_some() => {
                    let completion: Value = serde_json::from_str(&output.value_json)?;
                    let choice = completion
                        .get("choice")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            failure("OUTPUT_CONSTRAINT", "choice", "Missing validated choice")
                        })?;
                    require(
                        request.validation.selected_branch.as_deref() == Some(choice)
                            && step
                                .get("decision")
                                .and_then(|v| v.get("choices"))
                                .and_then(Value::as_array)
                                .is_some_and(|choices| {
                                    choices.iter().any(|v| v.as_str() == Some(choice))
                                }),
                        "Choice contradicts declared decision",
                    )?;
                    step.get("next").and_then(|v| v.get(choice))
                }
                Some("agent" | "prepare" | "call") => {
                    require(
                        request.validation.selected_branch.is_none(),
                        "Step has no selectable branch",
                    )?;
                    step.get("next")
                }
                _ => {
                    return Err(failure(
                        "UNSUPPORTED",
                        "step",
                        "Step is outside the inline profile",
                    ))
                }
            }
        }
    };
    let Some(destinations) = destinations else {
        return Ok(None);
    };
    let destinations = destinations
        .as_array()
        .ok_or_else(|| failure("CORRELATION", "next", "Invalid frozen route"))?;
    require(
        destinations.len() <= 1,
        "Parallel routes are outside the inline profile",
    )?;
    destinations
        .first()
        .map(|v| {
            v.as_str()
                .map(|v| vec![v.to_owned()])
                .ok_or_else(|| failure("CORRELATION", "next", "Invalid destination identity"))
        })
        .transpose()
}
async fn validate(db: &mut SqliteConnection, stored: &Stored, request: &Prepare) -> Result<()> {
    require(
        snapshot_digest(&stored.snapshot)? == request.validation.snapshot_digest,
        "Validation belongs to another snapshot",
    )?;
    let activation = activation(&stored.state, &request.work)?;
    require(
        record_equal(
            &activation.delivery.delivery.input,
            &request.validation.input,
        )?,
        "Validation belongs to another durable input",
    )?;
    validate_outcome(&request.outcome)?;
    if let EngineOutcome::Failed { code, error_json } = &request.outcome {
        // Vocabulary comes from the pinned official schema, not backend diagnostic codes.
        let schema: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/vendor/agsdl/v0.2/schema.json"
        )))?;
        let portable: Value = serde_json::from_str(error_json)?;
        require(
            schema
                .pointer("/$defs/Error/properties/code/enum")
                .and_then(Value::as_array)
                .is_some_and(|codes| codes.iter().any(|value| value.as_str() == Some(code)))
                && portable
                    .get("error")
                    .and_then(|error| error.get("code"))
                    .and_then(Value::as_str)
                    == Some(code),
            "Terminal failure contradicts the portable AgSDL error vocabulary",
        )?;
    }

    let raw: String = sqlx::query_scalar(
        "SELECT receipt_json FROM engine_response_closures WHERE system_id=? AND activation_id=?",
    )
    .bind(&request.work.system_start_id)
    .bind(&request.work.activation_id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(|| {
        failure(
            "CORRELATION",
            "responses",
            "Native response closure is absent",
        )
    })?;
    let closure: responses::Closure = serde_json::from_str(&raw)?;
    require(
        closure.owner == request.owner
            && closure.work == request.work
            && closure.cursor == request.response_cursor
            && closure.digest == request.validation.closure_digest,
        "Validation belongs to another response closure",
    )?;
    if matches!(&request.outcome, EngineOutcome::Completed { output } if output.origin == "agent") {
        let validation: Value = serde_json::from_str(&closure.validation_json)?;
        require(
            validation["kind"] == "success",
            "Failed publication cannot complete an Agent",
        )?;
        let EngineOutcome::Completed { output } = &request.outcome else {
            unreachable!()
        };
        let results = validation
            .get("resultsJson")
            .and_then(Value::as_str)
            .ok_or_else(|| failure("CORRELATION", "responses", "Closure results are absent"))?;
        let text = validation
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| failure("CORRELATION", "responses", "Closure text is absent"))?;
        let mut completion =
            serde_json::json!({"text":text,"results":serde_json::from_str::<Value>(results)?});
        if let Some(choice) = validation.get("choice").and_then(Value::as_str) {
            completion["choice"] = Value::String(choice.into());
        }
        require(
            super::super::exact_json::equal(&encode(&completion)?, &output.value_json)?,
            "Agent terminal contradicts its retained publication",
        )?;
    }
    Ok(())
}
fn stopped(stored: &Stored, work: &EngineWork) -> Result<bool> {
    Ok(!matches!(stored.state.stop, EngineStopState::None)
        || !matches!(
            activation(&stored.state, work)?.stop_state,
            EngineStopState::None
        ))
}
fn successor(stored: &Stored, request: &Prepare, address: Vec<String>) -> Result<EngineDelivery> {
    let policy = stored
        .policies
        .iter()
        .find(|p| p.step == address)
        .ok_or_else(|| failure("CORRELATION", "next", "Destination is not captured"))?;
    let input = match &request.outcome {
        EngineOutcome::Completed { output } => output.clone(),
        EngineOutcome::Failed { error_json, .. } => EngineValue {
            origin: "error".into(),
            value_json: error_json.clone(),
        },
        EngineOutcome::Stopped { .. } => {
            return Err(failure(
                "CORRELATION",
                "next",
                "Stopped work cannot continue",
            ))
        }
    };
    Ok(EngineDelivery {
        delivery_id: uuid::Uuid::new_v4().to_string(),
        work: EngineWork {
            system_start_id: request.work.system_start_id.clone(),
            flow_invocation_id: request.work.flow_invocation_id.clone(),
            activation_id: uuid::Uuid::new_v4().to_string(),
            step: Some(address),
            agent_instance_id: policy
                .agent_name
                .as_ref()
                .map(|name| stored.state.agents[name].id.clone()),
        },
        input,
    })
}
pub(crate) async fn prepare(
    pool: &SqlitePool,
    generation: &str,
    request: Prepare,
) -> Result<String> {
    opaque(generation)?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let stored = load(&mut tx, &request.work.system_start_id).await?;
    owner(&stored.state, &request.owner, &request.work.system_start_id)?;
    if let Some(raw) = sqlx::query_scalar::<_, String>(
        "SELECT witness_json FROM engine_prepared_terminals WHERE system_id=? AND activation_id=?",
    )
    .bind(&request.work.system_start_id)
    .bind(&request.work.activation_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        let retained: Retained = serde_json::from_str(&raw)?;
        require(
            retained.generation == generation && record_equal(&retained.request, &request)?,
            "Conflicting terminal preparation",
        )?;
        return Ok(retained.id);
    }
    live(&stored.state, &request.owner, &request.work)?;
    validate(&mut tx, &stored, &request).await?;
    let route = target(&stored.snapshot, &request)?;
    let outgoing = if stopped(&stored, &request.work)? {
        vec![]
    } else {
        route
            .map(|address| successor(&stored, &request, address))
            .transpose()?
            .into_iter()
            .collect()
    };
    let retained = Retained {
        id: uuid::Uuid::new_v4().to_string(),
        generation: generation.into(),
        commit: EngineTerminalCommit {
            owner: request.owner.clone(),
            work: request.work.clone(),
            outcome: request.outcome.clone(),
            response_cursor: request.response_cursor.clone(),
            termination_evidence_json: request.termination_evidence_json.clone(),
            memory: request.memory.clone(),
            outgoing,
        },
        request,
        final_commit: None,
    };
    sqlx::query("INSERT INTO engine_prepared_terminals VALUES (?,?,?,?)")
        .bind(&retained.commit.work.system_start_id)
        .bind(&retained.commit.work.activation_id)
        .bind(&retained.id)
        .bind(encode(&retained)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(retained.id)
}
impl RouteAuthority for PreparedTerminalWitness {
    fn outgoing(
        &self,
        snapshot: &EngineSnapshot,
        work: &EngineWork,
        outcome: &EngineOutcome,
    ) -> Result<Vec<EngineDelivery>> {
        require(
            !self.id.is_empty()
                && !self.generation.is_empty()
                && work == &self.request.work
                && record_equal(outcome, &self.request.outcome)?
                && snapshot_digest(snapshot)? == self.request.validation.snapshot_digest,
            "Terminal witness attribution mismatch",
        )?;
        let route = target(snapshot, &self.request)?;
        require(
            self.commit.outgoing.len() <= 1
                && self
                    .commit
                    .outgoing
                    .first()
                    .map(|d| d.work.step.clone())
                    .flatten()
                    == route,
            "Native continuation contradicts source declaration",
        )?;
        Ok(self.commit.outgoing.clone())
    }
}
pub(crate) async fn commit(
    pool: &SqlitePool,
    generation: &str,
    runtime: &EngineOwner,
    witness_id: &str,
) -> Result<EngineTerminalCommit> {
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let raw: String = sqlx::query_scalar(
        "SELECT witness_json FROM engine_prepared_terminals WHERE system_id=? AND witness_id=?",
    )
    .bind(&runtime.system_start_id)
    .bind(witness_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| failure("CORRELATION", "witness", "Unknown terminal witness"))?;
    let mut retained: Retained = serde_json::from_str(&raw)?;
    let mut stored = load(&mut tx, &runtime.system_start_id).await?;
    owner(&stored.state, runtime, &runtime.system_start_id)?;
    require(
        retained.generation == generation && retained.request.owner == *runtime,
        "Stale terminal witness",
    )?;
    if let Some(final_commit) = retained.final_commit {
        return Ok(final_commit);
    }
    live(&stored.state, runtime, &retained.request.work)?;
    validate(&mut tx, &stored, &retained.request).await?;
    // Stop wins preparation/commit races. Retain the final receipt after removing successors.
    if stopped(&stored, &retained.request.work)? {
        retained.commit.outgoing.clear();
    }
    let witness = PreparedTerminalWitness {
        id: retained.id.clone(),
        generation: retained.generation.clone(),
        request: retained.request.clone(),
        commit: retained.commit.clone(),
    };
    commit_terminal_on(
        &mut tx,
        &mut stored,
        retained.commit.clone(),
        &witness,
        false,
    )
    .await?;
    retained.final_commit = Some(retained.commit.clone());
    sqlx::query("UPDATE engine_prepared_terminals SET witness_json=? WHERE witness_id=?")
        .bind(encode(&retained)?)
        .bind(witness_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(retained.commit)
}
