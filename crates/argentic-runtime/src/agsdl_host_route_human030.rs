use super::*;

/// Carry the already accepted incoming prompt through a flow choice. This
/// reads the existing entry or occurrence; it creates no instruction authority.
pub(crate) async fn received_prompt_tx(
    db: &mut SqliteConnection,
    capture: &StartCapture030,
    producer: &Producer030,
    owner: &EngineOwner,
    generation: &str,
) -> Verified<Value> {
    let id = &capture.identity;
    let raw: String = sqlx::query_scalar(
        "SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?",
    )
    .bind(&id.system_start_id)
    .bind(&id.flow_invocation_id)
    .fetch_one(&mut *db)
    .await?;
    let state: FlowState030 = serde_json::from_str(&raw)?;
    let matches: Vec<_> = state
        .activations
        .iter()
        .filter(|a| a.id == producer.activation_id)
        .collect();
    require(matches.len() == 1)?;
    let activation = matches[0];
    require(activation.step == producer.step && activation.message_json == producer.message_json)?;
    let message: Value = serde_json::from_str(
        producer
            .message_json
            .as_deref()
            .ok_or(StoreError030::Authority)?,
    )?;
    if message.get("prompt").is_none() {
        return Ok(json!({"kind":"none"}));
    }
    if let Some(occurrence) = &activation.occurrence {
        let raw = crate::agsdl_host_flow030::check_persisted_occurrence(
            db,
            id,
            occurrence,
            &activation.producer,
            &owner.owner_epoch,
            generation,
        )
        .await?;
        let provenance: Value = serde_json::from_str(&raw)?;
        let prompt = provenance.get("prompt").ok_or(StoreError030::Authority)?;
        require(prompt["kind"].as_str().is_some_and(|kind| kind != "none"))?;
        return Ok(prompt.clone());
    }
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
    let request: String = sqlx::query_scalar(
        "SELECT request_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&id.system_start_id)
    .bind(&id.flow_invocation_id)
    .fetch_one(&mut *db)
    .await?;
    let request: crate::persistence::dto::EngineStartRequest = serde_json::from_str(&request)?;
    // A flow entry may be several compose wrappers away from this approval.
    // Follow only their exact entry chain, preserving the incoming occurrence.
    let mut entry = activation;
    for frame in activation.context.iter().rev() {
        let crate::persistence::flow030::Frame030::Compose { activation_id } = frame else {
            continue;
        };
        let parent = state
            .activations
            .iter()
            .find(|a| a.id == *activation_id)
            .ok_or(StoreError030::Authority)?;
        let scope = plan
            .scopes
            .iter()
            .find(|s| Some(&s.address) == parent.step.as_ref())
            .ok_or(StoreError030::Authority)?;
        require(
            Some(&scope.entry) == entry.step.as_ref()
                && parent.input_json == entry.input_json
                && parent.message_json == entry.message_json
                && parent.item_json == entry.item_json
                && parent.producer == entry.producer
                && parent.occurrence == entry.occurrence,
        )?;
        entry = parent;
    }
    require(
        plan.entry == entry.step
            && activation.producer.is_none()
            && activation.item_json.is_none()
            && request.source == capture.source
            && request.entry.as_ref().is_some_and(|entry| {
                exact(
                    &entry.message_json,
                    producer.message_json.as_deref().unwrap(),
                )
                .unwrap_or(false)
            }),
    )?;
    Ok(json!({"kind":"host"}))
}

/// Approval and compose failures derive from retained native decisions. A
/// deserialized source or a reducer phase alone cannot authorize either one.
pub(crate) fn verify_human_compose_source_tx<'a>(
    db: &'a mut SqliteConnection,
    capture: &'a StartCapture030,
    producer: &'a Producer030,
    owner: &'a EngineOwner,
    generation: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Verified<()>> + Send + 'a>> {
    Box::pin(async move {
        let id = &capture.identity;
        let raw: String = sqlx::query_scalar(
            "SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?",
        )
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .fetch_one(&mut *db)
        .await?;
        let state: FlowState030 = serde_json::from_str(&raw)?;
        let activation = state
            .activations
            .iter()
            .find(|a| a.id == producer.activation_id)
            .ok_or(StoreError030::Authority)?;
        require(activation.step == producer.step)?;
        if producer.kind == "compose" {
            verify_native_failure_source_tx(db, capture, producer, owner).await?;
            return Ok(());
        }
        require(producer.kind == "approval")?;
        let rows = sqlx::query("SELECT r.request_id,r.payload_json,r.resolution_json,r.delivery,p.resolution_json AS proof,p.event_id,w.work_json,w.owner_epoch,w.generation FROM engine_flow030_human_requests r JOIN engine_flow030_human_resolution_proofs p USING(system_id,invocation_id,request_id) JOIN engine_flow030_clock_works w ON w.system_id=r.system_id AND w.invocation_id=r.invocation_id AND w.activation_id=json_extract(r.work_ids_json,'$[0]') WHERE r.system_id=? AND r.invocation_id=? AND r.kind='approval' AND w.activation_id=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&producer.activation_id).fetch_all(&mut *db).await?;
        require(rows.len() == 1)?;
        let row = &rows[0];
        require(
            row.get::<&str, _>("owner_epoch") == owner.owner_epoch
                && row.get::<&str, _>("generation") == generation
                && row.get::<&str, _>("delivery") == "acknowledged"
                && row.get::<&str, _>("resolution_json") == row.get::<&str, _>("proof"),
        )?;
        let payload: Value = serde_json::from_str(row.get("payload_json"))?;
        let resolution: Value = serde_json::from_str(row.get("resolution_json"))?;
        let request: &str = row.get("request_id");
        let output = if resolution["expired"] == true {
            require(resolution["failure"] == "APPROVAL_TIMEOUT")?;
            json!({"error":crate::persistence::flow030::Failure030::new("APPROVAL_TIMEOUT")})
        } else {
            json!({"choice":resolution["answer"]["choice"],"comment":resolution["answer"]["comment"],"message":payload["message"]})
        };
        require(value_equal(
            &serde_json::from_str(&producer.output_json)?,
            &output,
        )?)?;
        let event_raw: String=sqlx::query_scalar("SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=? AND diagnostic_json IS NULL AND receipt_json IS NOT NULL")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(format!("human:{request}:terminal")).fetch_one(&mut *db).await?;
        let event: Value = serde_json::from_str(&event_raw)?;
        let work: Value = serde_json::from_str(row.get("work_json"))?;
        require(
            event["identity"] == serde_json::to_value(id)?
                && event.pointer("/kind/WorkResult/work") == Some(&work["reference"])
                && event.pointer("/kind/WorkResult/physical")
                    == Some(&json!({"native_receipt_id":request,"descendants_joined":true})),
        )?;
        Ok(())
    })
}
