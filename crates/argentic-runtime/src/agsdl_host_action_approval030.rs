//! Existing native approval/resolution/delivery, owned entirely by runtime.
use crate::{
    agsdl_host::HostState,
    agsdl_host_flow030 as flow,
    host::ActionPolicySource,
    persistence::{failure, Result},
};
use futures::future::BoxFuture;
use sqlx::SqlitePool;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
pub(crate) struct AgentActionHumans030 {
    pub host: HostState,
    pub pool: SqlitePool,
    pub policy: Arc<dyn ActionPolicySource>,
}
impl crate::agsdl_host_codex030::approvals::CommandApprovals030 for AgentActionHumans030 {
    fn answer<'a>(
        &'a self,
        attempt: &'a crate::agsdl_host_flow030::FlowWorkAttempt030,
        mut payload: serde_json::Value,
        cancel: &'a CancellationToken,
        respond: crate::agsdl_host_codex030::approvals::Respond030<'a>,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let host = &self.host;
            let broker = host
                .flow030()
                .human_runtime()
                .broker(host, &self.pool, attempt.identity())
                .await?;
            payload["title"] = payload["nativeRequest"]["params"]["reason"].clone();
            let (work, ticket) = {
                let _operation = broker.operation.lock().await;
                let work = broker.admit_agent(host, attempt).await?;
                if !work.belongs_to(attempt) {
                    return Err(failure(
                        "CORRELATION",
                        "approval",
                        "Native action owner changed",
                    ));
                }
                let ticket = broker.open(host, &work, "ask", payload.clone()).await?;
                broker.pump(host, cancel).await?;
                (work, ticket)
            };
            host.flow030()
                .supervisor_registry()
                .wake(&attempt.identity().system_start_id);
            while !broker.resolution_ready(&ticket).await? {
                tokio::select! {
                    _ = cancel.cancelled() => return Err(failure("STOP_PENDING", "approval", "Native action was stopped")),
                    _ = tokio::time::sleep(Duration::from_millis(25)) => {}
                }
            }
            let _operation = broker.operation.lock().await;
            let decision = broker.take_resolution(host, &ticket).await?;
            let view = flow::inspect_run(host.flow030(), host, &self.pool, attempt.owner()).await?;
            // The host's real source/configuration guards remain owned until
            // native delivery and its correlated acknowledgement have returned.
            let policy = self.policy.lock_current(&view.capture, &payload).await?;
            let allowed = policy.allows();
            broker
                .deliver_action(host, &work, &decision, &payload, |yes| {
                    respond(yes && allowed && !cancel.is_cancelled())
                })
                .await?;
            broker.pump(host, cancel).await?;
            drop(policy);
            Ok(())
        })
    }
}
