//! Production human waits and the flow-owned monotone clock.
use crate::{
    agsdl_host::HostState,
    agsdl_host_flow030::{self as flow, NativeFlowInspection030},
    agsdl_host_runtime030::{HostExecutor030, RuntimeClock030},
    ai::stream_tasks::StreamTasks,
    db::agsdl_execution::{
        failure,
        flow030::{FlowEffect030, FlowIdentity030},
        Result,
    },
};
use futures::future::BoxFuture;
use sqlx::SqlitePool;
use std::{sync::Arc, time::Duration};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

pub(crate) struct HumanExecutor030 {
    pub pool: SqlitePool,
    pub tasks: StreamTasks,
}
impl<R: tauri::Runtime> HostExecutor030<R> for HumanExecutor030 {
    fn start(
        &self,
        app: tauri::AppHandle<R>,
        _inspection: NativeFlowInspection030,
        effect: FlowEffect030,
        _cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Option<crate::agsdl_host_call_executor030::StartedCall030>>>
    {
        let (pool, tasks) = (self.pool.clone(), self.tasks.clone());
        Box::pin(async move {
            let host = app.state::<HostState>();
            let claim =
                flow::claim_expected(host.flow030(), &host, &pool, &effect.identity, &effect.id)
                    .await?
                    .ok_or_else(|| {
                        failure("STALE_REFERENCE", "approval", "Approval start changed")
                    })?;
            claim.handoff_host(&tasks, std::future::pending()).await?;
            let broker = host
                .flow030()
                .humans
                .broker(&host, &pool, &effect.identity)
                .await?;
            let _operation = broker.operation.lock().await;
            broker.admit_host_work(&host, &effect.id).await?;
            broker.pump(&host, &CancellationToken::new()).await?;
            Ok(None)
        })
    }
}

pub(crate) struct HumanClockRuntime030<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
    pub pool: SqlitePool,
    pub tasks: StreamTasks,
    pub identity: FlowIdentity030,
}
impl<R: tauri::Runtime> RuntimeClock030 for HumanClockRuntime030<R> {
    fn tracks_humans(&self) -> bool {
        true
    }
    fn tick(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let result = async {
                let host = self.app.state::<HostState>();
                let broker = host
                    .flow030()
                    .humans
                    .broker(&host, &self.pool, &self.identity)
                    .await?;
                let _operation = broker.operation.lock().await;
                broker.pump(&host, &CancellationToken::new()).await?;
                // Timers are wake hints. Journal only actual deadlines, rather
                // than appending unbounded periodic ticks during a person's wait.
                if broker.next_wake_ms().await? == Some(0) {
                    broker.tick(&host).await?;
                    broker.pump(&host, &CancellationToken::new()).await?;
                }
                for request in broker.pending_resolutions().await? {
                    // Protocol questions are consumed by their native transport.
                    if broker.request_kind(&request).await? != "approval" {
                        continue;
                    }
                    let decision = broker.take_resolution(&host, &request).await?;
                    broker
                        .finish_approval(&host, &self.tasks, &decision)
                        .await?;
                }
                Ok(())
            }
            .await;
            if result.is_err() {
                let state: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?")
                    .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).fetch_one(&self.pool).await?;
                let state: crate::db::agsdl_execution::flow030::FlowState030 =
                    serde_json::from_str(&state)?;
                if state.stopping {
                    return Ok(());
                }
            }
            result
        })
    }
    fn next_wake(&self) -> BoxFuture<'_, Result<Option<Duration>>> {
        Box::pin(async move {
            let host = self.app.state::<HostState>();
            let broker = host
                .flow030()
                .humans
                .broker(&host, &self.pool, &self.identity)
                .await?;
            Ok(broker.next_wake_ms().await?.map(Duration::from_millis))
        })
    }
}

pub(crate) struct CallHumans030<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
    pub pool: SqlitePool,
    pub identity: FlowIdentity030,
}
struct McpAnswer030;
impl crate::agsdl_host_human030::QuestionValidator030 for McpAnswer030 {
    fn validate(&self, _: &serde_json::Value, answer: &str) -> Result<()> {
        let value: serde_json::Value = serde_json::from_str(answer)?;
        if !matches!(
            value["action"].as_str(),
            Some("accept" | "decline" | "cancel")
        ) || value["action"] == "accept" && !value["content"].is_object()
        {
            return Err(failure(
                "INPUT_CONSTRAINT",
                "answer",
                "Expected an MCP form response",
            ));
        }
        Ok(())
    }
}
fn transport_error(
    error: crate::db::agsdl_execution::dto::EngineFailure,
) -> crate::agsdl_host_calls::CallError {
    crate::agsdl_host_calls::CallError::new(&error.code, error.message)
}
#[async_trait::async_trait]
impl<R: tauri::Runtime> crate::agsdl_host_calls::HostPort for CallHumans030<R> {
    fn supports_human_requests(&self) -> bool {
        true
    }
    async fn claim(
        &self,
        _: &crate::agsdl_host_calls::CallRequest,
    ) -> crate::agsdl_host_calls::Result<crate::agsdl_host_calls::ClaimedCall> {
        Err(crate::agsdl_host_calls::CallError::new(
            "AUTHORITY",
            "Use the flow call admission",
        ))
    }
    fn launch_gate(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.app.state::<HostState>().admission_lock()
    }
    async fn authorize_launch(
        &self,
        _: &crate::agsdl_host_calls::CallRequest,
        _: &str,
    ) -> crate::agsdl_host_calls::Result<crate::agsdl_host_calls::LaunchGrant> {
        Err(crate::agsdl_host_calls::CallError::new(
            "AUTHORITY",
            "Use the flow call admission",
        ))
    }
    async fn finish(
        &self,
        _: &str,
        _: &crate::agsdl_host_calls::Completion,
    ) -> crate::agsdl_host_calls::Result<()> {
        Err(crate::agsdl_host_calls::CallError::new(
            "AUTHORITY",
            "Use the flow call join",
        ))
    }
    async fn human_open(
        &self,
        call: &crate::agsdl_host_calls::CallIdentity,
        server: &str,
        raw: &str,
    ) -> crate::agsdl_host_calls::Result<String> {
        let request: serde_json::Value = serde_json::from_str(raw)
            .map_err(|e| crate::agsdl_host_calls::CallError::transport(e.to_string()))?;
        if raw.len() > 65_536
            || request["method"] != "elicitation/create"
            || request["params"]["mode"]
                .as_str()
                .is_some_and(|m| m != "form")
            || !request["params"]["requestedSchema"].is_object()
        {
            return Err(crate::agsdl_host_calls::CallError::new(
                "HOST_CAPABILITY",
                "Only MCP form questions are supported",
            ));
        }
        let host = self.app.state::<HostState>();
        let broker = host
            .flow030()
            .humans
            .broker(&host, &self.pool, &self.identity)
            .await
            .map_err(transport_error)?;
        let _operation = broker.operation.lock().await;
        let work = broker
            .owned_work(&call.work_id)
            .await
            .map_err(transport_error)?;
        let payload = serde_json::json!({"nativeCallId":call.native_call_id,"protocolReceiptId":uuid::Uuid::new_v4().to_string(),"server":server,"question":request["params"]["message"],"expectedResponse":"","schema":{"type":"object","required":["action"],"properties":{"action":{"enum":["accept","decline","cancel"]},"content":request["params"]["requestedSchema"]}},"protocolRequest":request});
        let id = broker
            .open_question(&host, &work, payload, Arc::new(McpAnswer030))
            .await
            .map_err(transport_error)?;
        broker
            .pump(&host, &CancellationToken::new())
            .await
            .map_err(transport_error)?;
        host.flow030()
            .supervisors
            .wake(&self.identity.system_start_id);
        Ok(id)
    }
    async fn human_answer(&self, ticket: &str) -> crate::agsdl_host_calls::Result<String> {
        let host = self.app.state::<HostState>();
        let broker = host
            .flow030()
            .humans
            .broker(&host, &self.pool, &self.identity)
            .await
            .map_err(transport_error)?;
        loop {
            if broker
                .resolution_ready(ticket)
                .await
                .map_err(transport_error)?
            {
                let _operation = broker.operation.lock().await;
                let decision = broker
                    .take_resolution(&host, ticket)
                    .await
                    .map_err(transport_error)?;
                let answer = broker
                    .protocol_answer(&decision)
                    .await
                    .map_err(transport_error)?
                    .unwrap_or_else(|| "{\"action\":\"decline\"}".into());
                broker
                    .acknowledge(&host, &decision)
                    .await
                    .map_err(transport_error)?;
                broker
                    .pump(&host, &CancellationToken::new())
                    .await
                    .map_err(transport_error)?;
                return Ok(answer);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    async fn human_close(
        &self,
        _: &str,
        _: &crate::agsdl_host_calls::Result<String>,
    ) -> crate::agsdl_host_calls::Result<()> {
        Ok(())
    }
}
