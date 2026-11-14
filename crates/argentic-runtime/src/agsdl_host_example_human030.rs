use super::*;
pub(super) struct ScriptedApproval030 {
    pub(super) key: crate::agsdl_host_scenario030::WorkKey030,
    pub(super) work: crate::agsdl_host_human030::OwnedHumanWork030,
}
pub(super) struct ScenarioHumans030 {
    pub(super) broker: std::sync::Arc<crate::agsdl_host_human030::HumanBroker030>,
    pub(super) clock: std::sync::Arc<crate::agsdl_host_clock030::VirtualClock030>,
    pub(super) approvals: Vec<ScriptedApproval030>,
    pub(super) joined:
        std::collections::BTreeMap<String, crate::agsdl_host_dispatch030::JoinedOwnedAgent030>,
}
pub(super) struct ScriptedAgentEvent030 {
    pub(super) label: &'static str,
    pub(super) body: serde_json::Value,
    pub(super) reply: tokio::sync::oneshot::Sender<Result<ProtocolDecision030>>,
}
pub(super) async fn emit_scripted_agent030(
    work: &ScriptedWork030,
    label: &'static str,
    body: serde_json::Value,
) -> Result<ProtocolDecision030> {
    let (reply, result) = tokio::sync::oneshot::channel();
    work.protocol
        .send(ScriptedAgentEvent030 { label, body, reply })
        .await
        .map_err(|_| failure("UNCERTAIN", "example", "Owned agent protocol closed"))?;
    result.await.map_err(|_| {
        failure(
            "UNCERTAIN",
            "example",
            "Owned agent protocol did not acknowledge",
        )
    })?
}
pub(super) async fn submit_scripted_human030(
    host: &HostState,
    pool: &SqlitePool,
    owner: &crate::persistence::dto::EngineOwner,
    broker: &crate::agsdl_host_human030::HumanBroker030,
    work: &crate::agsdl_host_human030::OwnedHumanWork030,
    answer: crate::agsdl_host_human030::HumanAnswer030,
    cancelled: &CancellationToken,
) -> Result<()> {
    let request_id = broker
        .oldest_open(work)
        .await?
        .ok_or_else(|| failure("CORRELATION", "human", "No open request"))?;
    let capture = crate::agsdl_host_flow030::inspect_run(host.flow030(), host, pool, owner)
        .await?
        .capture;
    broker
        .submit(
            host,
            crate::agsdl_host_human030::HumanSubmission030 {
                scope: crate::persistence::public030::HumanScope030 {
                    source: capture.source,
                    system_start_id: capture.identity.system_start_id,
                },
                request_id,
                expected_revision: "0".into(),
                answer,
            },
            crate::agsdl_host_human030::HumanOrigin030::SyntheticPerson,
        )
        .await?;
    broker.pump(host, cancelled).await?;
    Ok(())
}
pub(super) async fn settle_humans030(
    app: &HostState,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    humans: &mut ScenarioHumans030,
    works: &mut Vec<ScriptedWork030>,
    cancelled: &CancellationToken,
) -> Result<()> {
    let host = app;
    let mut failures = Vec::new();
    for request in humans.broker.pending_resolutions().await? {
        let decision = humans.broker.take_resolution(&host, &request).await?;
        if decision.kind() == "approval" {
            let id = decision.payload()["work"]["activationId"]
                .as_str()
                .ok_or_else(|| failure("CORRELATION", "approval", "Approval work absent"))?;
            let index = humans
                .approvals
                .iter()
                .position(|a| a.work.work_id() == id)
                .ok_or_else(|| failure("CORRELATION", "approval", "Approval owner absent"))?;
            humans
                .broker
                .finish_approval(&host, tasks, &decision)
                .await?;
            humans.approvals.remove(index);
            continue;
        }
        if decision.kind() == "plan" {
            let id = decision.resolution()["workActions"][0]["workId"]
                .as_str()
                .ok_or_else(|| failure("CORRELATION", "plan", "Plan work absent"))?;
            let work = works
                .iter()
                .find(|w| w.human.work_id() == id)
                .ok_or_else(|| failure("CORRELATION", "plan", "Plan owner absent"))?;
            work.plan_lock
                .as_ref()
                .ok_or_else(|| failure("CORRELATION", "plan", "Plan lock absent"))?
                .resolve(&work.attempt, &decision)
                .await?;
            let result =
                emit_scripted_agent030(work, "plan-resolved", decision.plan_event()?).await?;
            let receipt: serde_json::Value = serde_json::from_str(&result.receipt_json)?;
            if receipt["decision"]["kind"] == "stopping" {
                failures.push((id.to_owned(), "PLAN_REJECTED".to_owned()));
            }
        }
        // The synthetic provider/server receives the resolution here, while its
        // native owned future remains alive until the timeline returns a result.
        humans.broker.acknowledge(&host, &decision).await?;
        humans.broker.pump(&host, cancelled).await?;
    }
    for control in humans.broker.timeout_controls().await? {
        failures.push((control.work_id().into(), "TIMEOUT".into()));
    }
    for (id, code) in failures {
        let index = works
            .iter()
            .position(|w| w.human.work_id() == id)
            .ok_or_else(|| failure("CORRELATION", "clock", "Timed out work owner absent"))?;
        let work = works.remove(index);
        work.send
            .send(crate::agsdl_host_scenario030::ExampleResult030::Failed(
                code,
            ))
            .map_err(|_| failure("UNCERTAIN", "clock", "Owned work mailbox closed"))?;
        let joined =
            crate::agsdl_host_dispatch030::join_owned_agent030(tasks, &work.attempt).await?;
        work.result
            .await
            .map_err(|_| failure("UNCERTAIN", "clock", "Owned work result absent"))??;
        flow_work_protocol030::finish_joined_agent030(&host, pool, &joined, cancelled).await?;
        humans.broker.retire(&host, &work.human).await?;
        humans.broker.pump(&host, cancelled).await?;
        humans.joined.insert(id, joined);
    }
    Ok(())
}
