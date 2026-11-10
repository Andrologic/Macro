use super::*;
/// Native lifetime owner shared by product IPC and owned execution drivers.
pub(crate) struct HumanRuntime030 {
    clock: Mutex<Arc<dyn Clock030>>,
    brokers: tokio::sync::Mutex<BTreeMap<(String, String), Arc<HumanBroker030>>>,
}
impl Default for HumanRuntime030 {
    fn default() -> Self {
        Self {
            clock: Mutex::new(Arc::new(
                crate::agsdl_host_clock030::MonotoneClock030::default(),
            )),
            brokers: Default::default(),
        }
    }
}
impl HumanRuntime030 {
    pub(crate) fn clock(&self) -> Arc<dyn Clock030> {
        self.clock.lock().expect("native clock").clone()
    }
    #[cfg(test)]
    pub(crate) async fn virtual_clock(
        &self,
    ) -> Result<Arc<crate::agsdl_host_clock030::VirtualClock030>> {
        require(
            self.brokers.lock().await.is_empty(),
            "QA clock already admitted",
        )?;
        let clock = Arc::new(crate::agsdl_host_clock030::VirtualClock030::default());
        *self.clock.lock().expect("native clock") = clock.clone();
        Ok(clock)
    }
    pub(crate) async fn broker(
        &self,
        host: &HostState,
        pool: &SqlitePool,
        identity: &FlowIdentity030,
    ) -> Result<Arc<HumanBroker030>> {
        let mut brokers = self.brokers.lock().await;
        let key = (
            identity.system_start_id.clone(),
            identity.flow_invocation_id.clone(),
        );
        if let Some(broker) = brokers.get(&key) {
            return Ok(broker.clone());
        }
        let lease = host.start_lease().await?;
        let jobs = lease.clock_jobs030();
        drop(lease);
        let broker = Arc::new(
            HumanBroker030::attach(host, pool.clone(), identity.clone(), self.clock(), jobs)
                .await?,
        );
        brokers.insert(key, broker.clone());
        Ok(broker)
    }
}

impl HumanBroker030 {
    pub(crate) async fn pending_resolutions(&self) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar("SELECT request_id FROM engine_flow030_human_requests WHERE system_id=? AND invocation_id=? AND resolution_json IS NOT NULL AND delivery='pending' ORDER BY rowid")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).fetch_all(&self.pool).await?)
    }
    /// Approval has no provider. Join its owned waiting future before committing
    /// its terminal result; the retained resolution is the sole output source.
    pub(crate) async fn finish_approval(
        &self,
        host: &HostState,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        decision: &ResolvedHumanDecision030,
    ) -> Result<()> {
        require(
            decision.identity == self.identity
                && decision.kind == "approval"
                && decision.work_ids.len() == 1,
            "Foreign approval",
        )?;
        let id = &decision.work_ids[0];
        let raw: String = sqlx::query_scalar("SELECT work_json FROM engine_flow030_clock_works WHERE system_id=? AND invocation_id=? AND activation_id=?")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(id).fetch_one(&self.pool).await?;
        let work: OwnedHumanWork030 = serde_json::from_str(&raw)?;
        let parent = format!(
            "flow030:{}:{}",
            self.identity.system_start_id, work.reference.start_effect_id
        );
        require(
            tasks
                .cancel_owned(&parent)
                .await
                .map_err(|_| failure("UNCERTAIN", "approval", "Approval owner did not join"))?,
            "Approval owner absent",
        )?;
        let lease = host.start_lease().await?;
        let _gate = host.admission_lock().lock_owned().await;
        let mut db = self.durable_connection().await?;
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        self.guard(&mut tx, &lease).await?;
        validation::validate_stored(self, &mut tx, &decision.request_id).await?;
        let row = self.request_row(&mut tx, &decision.request_id).await?;
        require(
            row.get::<&str, _>("delivery") == "reserved"
                && row.get::<&str, _>("resolution_json") == decision.resolution.to_string(),
            "Approval resolution changed",
        )?;
        use crate::db::agsdl_execution::flow030::{
            Failure030, FlowEvent030, FlowEventKind030, PhysicalEvidence030, WorkResult030,
        };
        let result = if decision.resolution["expired"] == true {
            require(
                decision.resolution["failure"] == "APPROVAL_TIMEOUT",
                "Approval timeout differs",
            )?;
            WorkResult030::Failed {
                error: Failure030::new("APPROVAL_TIMEOUT"),
            }
        } else {
            let output = decision.approval_output()?;
            WorkResult030::Completed {
                route_key: output["choice"].as_str().map(str::to_owned),
                output_json: output.to_string(),
            }
        };
        let state: String = sqlx::query_scalar(
            "SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?",
        )
        .bind(&self.identity.system_start_id)
        .bind(&self.identity.flow_invocation_id)
        .fetch_one(&mut *tx)
        .await?;
        let state: FlowState030 = serde_json::from_str(&state)?;
        let event = FlowEvent030 {
            identity: self.identity.clone(),
            event_id: format!("human:{}:terminal", decision.request_id),
            expected_revision: state.revision,
            kind: FlowEventKind030::WorkResult {
                work: work.reference,
                result,
                physical: Some(PhysicalEvidence030 {
                    native_receipt_id: decision.request_id.clone(),
                    descendants_joined: true,
                }),
            },
        };
        // apply_native_event owns the flow COMMIT fence and validates the reducer.
        tx.commit().await?;
        drop(_gate);
        drop(lease);
        crate::agsdl_host_flow030::apply_native_event(host.flow030(), host, &self.pool, &event)
            .await?;
        self.acknowledge(host, decision).await?;
        self.pump(host, &CancellationToken::new()).await?;
        Ok(())
    }
}
