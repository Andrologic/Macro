//! Existing synthetic model peer for boundary tests. It publishes no native
//! owner, admission, resolution, callback, or executable-provider authority.
use crate::agsdl_host_runtime030::*;
use crate::agsdl_host_work_admission030::{AttestedWorkPolicy030, PreparedEffectiveAgentWork030};
use crate::Engine;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
#[derive(Default)]
pub struct ScriptedAgent {
    pub starts: Arc<AtomicUsize>,
    pub started: Arc<Notify>,
    pub cleanup: Option<Arc<Notify>>,
    pub cancelled: Arc<Notify>,
    pub submitted: Option<Arc<Notify>>,
    pub independent_finish: bool,
}
impl AgentExecutor030 for ScriptedAgent {
    fn prepare(
        &self,
        prepared: PreparedEffectiveAgentWork030,
    ) -> crate::persistence::Result<AttestedWorkPolicy030> {
        AttestedWorkPolicy030::from_codex(prepared)
    }
    fn run(
        &self,
        work: AgentWork030,
        events: WorkEventSink030,
        cancel: CancellationToken,
    ) -> futures::future::BoxFuture<'static, crate::persistence::Result<()>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let started = self.started.clone();
        let submission = if work.attempt.agent() == "reviewer" {
            "{\"choice\":\"approve\"}"
        } else {
            "{}"
        };
        let writer = work.attempt.agent() == "writer";
        let independent = self.independent_finish;
        let (cleanup, cancelled, submitted) = (
            self.cleanup.clone(),
            self.cancelled.clone(),
            self.submitted.clone(),
        );
        Box::pin(async move {
            if writer {
                events.emit(json!({"kind":"visibleText","messageId":"draft","textParts":["Synthetic draft"]}), &cancel).await?;
            }
            started.notify_one();
            if let Some(signal) = submitted {
                events
                    .emit(
                        json!({"kind":"submit","callId":"fake","argumentsJson":submission}),
                        &cancel,
                    )
                    .await?;
                signal.notify_one();
            }
            if let Some(cleanup) = cleanup {
                if !independent {
                    cancel.cancelled().await;
                    cancelled.notify_one();
                }
                cleanup.notified().await;
            } else {
                events
                    .emit(
                        json!({"kind":"submit","callId":"fake","argumentsJson":submission}),
                        &cancel,
                    )
                    .await?;
            }
            Ok(())
        })
    }
}
struct FailingPreparation {
    panic: bool,
}
impl AgentExecutor030 for FailingPreparation {
    fn prepare(
        &self,
        _: PreparedEffectiveAgentWork030,
    ) -> crate::persistence::Result<AttestedWorkPolicy030> {
        assert!(!self.panic, "synthetic supervisor panic");
        Err(crate::persistence::failure(
            "HOST_CAPABILITY",
            "test",
            "Synthetic preparation failure",
        ))
    }
    fn run(
        &self,
        _: AgentWork030,
        _: WorkEventSink030,
        _: CancellationToken,
    ) -> futures::future::BoxFuture<'static, crate::persistence::Result<()>> {
        unreachable!("failed preparation must never start work")
    }
}

impl ScriptedAgent {
    pub fn install(self: &Arc<Self>, engine: &Engine) {
        *engine
            .flow030()
            .fixture_agents
            .lock()
            .expect("synthetic executor") = Some(self.clone());
    }
    pub fn install_failure(&self, engine: &Engine, panic: bool) {
        *engine
            .flow030()
            .fixture_agents
            .lock()
            .expect("synthetic executor") = Some(Arc::new(FailingPreparation { panic }));
    }
    pub async fn wait(&self, engine: &Engine, system: &str) -> crate::persistence::Result<()> {
        engine.flow030().supervisor_registry().wait(system).await
    }
}
