//! Production human waits and the flow-owned monotone clock.
use crate::{
    agsdl_host::HostState,
    agsdl_host_flow030 as flow,
    db::agsdl_execution::{failure, Result},
};
use futures::future::BoxFuture;
use sqlx::SqlitePool;
use std::time::Duration;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

pub(crate) struct AgentActionHumans030<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
    pub pool: SqlitePool,
    pub config: crate::config::ConfigManager,
}
impl<R: tauri::Runtime> crate::agsdl_host_codex030::approvals::CommandApprovals030
    for AgentActionHumans030<R>
{
    fn answer<'a>(
        &'a self,
        attempt: &'a crate::agsdl_host_flow030::FlowWorkAttempt030,
        mut payload: serde_json::Value,
        cancel: &'a CancellationToken,
        respond: crate::agsdl_host_codex030::approvals::Respond030<'a>,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            use crate::agsdl_permissions::*;
            let host = self.app.state::<HostState>();
            let broker = host
                .flow030()
                .humans
                .broker(&host, &self.pool, attempt.identity())
                .await?;
            payload["title"] = payload["nativeRequest"]["params"]["reason"].clone();
            let (work, ticket) = {
                let _operation = broker.operation.lock().await;
                let work = broker.admit_agent(&host, attempt).await?;
                if !work.belongs_to(attempt) {
                    return Err(failure(
                        "CORRELATION",
                        "approval",
                        "Native action owner changed",
                    ));
                }
                let ticket = broker.open(&host, &work, "ask", payload.clone()).await?;
                broker.pump(&host, cancel).await?;
                (work, ticket)
            };
            host.flow030()
                .supervisors
                .wake(&attempt.identity().system_start_id);
            while !broker.resolution_ready(&ticket).await? {
                tokio::select! {
                    _ = cancel.cancelled() => return Err(failure("STOP_PENDING", "approval", "Native action was stopped")),
                    _ = tokio::time::sleep(Duration::from_millis(25)) => {}
                }
            }
            let _operation = broker.operation.lock().await;
            let decision = broker.take_resolution(&host, &ticket).await?;
            let view =
                flow::inspect_run(host.flow030(), &host, &self.pool, attempt.owner()).await?;
            let workspace = self
                .app
                .state::<crate::WorkspaceMetadataRoot>()
                .0
                .read()
                .await
                .clone();
            let metadata = crate::agsdl_host_capture::metadata_root(&workspace)?;
            let source = crate::workspace::architect::lock_execution_source_owner(
                &workspace,
                &metadata,
                &view.capture.source.owner,
                None,
            )
            .await?;
            let ceiling = self
                .config
                .lock_agsdl_host_permissions()
                .await
                .map_err(|_| {
                    failure(
                        "PERMISSION",
                        "approval",
                        "Current permissions are unavailable",
                    )
                })?;
            let project = self
                .config
                .lock_execution_tools(&view.capture.source.owner.project_id)
                .await
                .map_err(|_| {
                    failure(
                        "PERMISSION",
                        "approval",
                        "Current project permissions are unavailable",
                    )
                })?;
            let private: serde_json::Value =
                serde_json::from_str(&view.capture.private_capture_json)?;
            let scope: serde_json::Value =
                serde_json::from_str(private["callScopeJson"].as_str().ok_or_else(|| {
                    failure("CORRELATION", "approval", "Native scope is absent")
                })?)?;
            let root = scope["root"]
                .as_str()
                .ok_or_else(|| failure("CORRELATION", "approval", "Native root is absent"))?;
            let current_scope = crate::agsdl_host_capture::project_scope(&workspace, &source)?;
            if current_scope["root"] != scope["root"]
                || current_scope["rootIdentity"] != scope["rootIdentity"]
            {
                return Err(failure(
                    "CAPTURE_CHANGED",
                    "approval",
                    "Current project scope differs from the native command scope",
                ));
            }
            let policy = normalize_requested(
                ceiling.permissions().clone(),
                PathContext {
                    workspace: root.into(),
                    home: std::env::var_os("HOME")
                        .map(std::path::PathBuf::from)
                        .ok_or_else(|| {
                            failure("PERMISSION", "approval", "Native home is absent")
                        })?,
                },
            )
            .map_err(|_| failure("PERMISSION", "approval", "Current permissions are invalid"))?;
            let path = payload["nativeRequest"]
                .pointer("/params/additionalPermissions/fileSystem/write/0")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| failure("CORRELATION", "approval", "Native file scope is absent"))?;
            let current_permissions = crate::agsdl_host_tools::permissions(
                "Implement",
                source.project.user_read_only || source.project.is_read_only,
                &project.tools,
            )?;
            let allowed = !crate::core::tool_policy::agsdl_native_read_only(&current_permissions)
                && evaluate_requested(&policy, &ActionRequest::Write { path: path.into() })
                    .is_ok_and(|e| e != Effect::Deny)
                && evaluate_requested(
                    &policy,
                    &ActionRequest::Shell {
                        command: payload["nativeRequest"]["params"]["command"]
                            .as_str()
                            .unwrap_or("")
                            .into(),
                    },
                )
                .is_ok_and(|e| e == Effect::Allow);
            broker
                .deliver_action(&host, &work, &decision, &payload, |yes| {
                    respond(yes && allowed && !cancel.is_cancelled())
                })
                .await?;
            broker.pump(&host, cancel).await?;
            Ok(())
        })
    }
}
