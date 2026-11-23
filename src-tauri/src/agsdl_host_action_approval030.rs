//! Current Macro source/policy verification; no native approval or response API.
use crate::db::agsdl_execution::{failure, start030::StartCapture030, Result};
use argentic_runtime::host::{ActionPolicyLease, ActionPolicySource, PolicyFuture};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;
pub(crate) struct CurrentActionPolicy030<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
    pub config: crate::config::ConfigManager,
}
impl<R: tauri::Runtime> ActionPolicySource for CurrentActionPolicy030<R> {
    fn lock_current<'a>(
        &'a self,
        capture: &'a StartCapture030,
        payload: &'a serde_json::Value,
    ) -> PolicyFuture<'a, ActionPolicyLease> {
        Box::pin(async move {
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
                &capture.source.owner,
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
                .lock_execution_tools(&capture.source.owner.project_id)
                .await
                .map_err(|_| {
                    failure(
                        "PERMISSION",
                        "approval",
                        "Current project permissions are unavailable",
                    )
                })?;
            let scope = captured_scope(capture)?;
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
            let current_permissions = crate::agsdl_host_tools::permissions(
                "Implement",
                source.project.user_read_only || source.project.is_read_only,
                &project.tools,
            )?;
            let allowed =
                policy_allows(ceiling.permissions(), &current_permissions, &scope, payload)?;
            Ok(ActionPolicyLease::new(allowed, (source, ceiling, project)))
        })
    }
}

/// The admitted archive run is the source owner. Its folder is independent
/// of the legacy project registry and must still match the captured identity.
pub(crate) struct ArchiveActionPolicy030 {
    pub pool: sqlx::SqlitePool,
    pub config: crate::config::ConfigManager,
}

impl ActionPolicySource for ArchiveActionPolicy030 {
    fn lock_current<'a>(
        &'a self,
        capture: &'a StartCapture030,
        payload: &'a Value,
    ) -> PolicyFuture<'a, ActionPolicyLease> {
        Box::pin(async move {
            let (allowed, guards) = self.lock_decision(capture, payload).await?;
            Ok(ActionPolicyLease::new(allowed, guards))
        })
    }
}

impl ArchiveActionPolicy030 {
    pub(crate) async fn lock_decision(
        &self,
        capture: &StartCapture030,
        payload: &Value,
    ) -> Result<(bool, impl Send + Sync + 'static)> {
        use crate::architect_launch::{current_run_folder, start::scope_for, BRANCH, PROJECT_ID};
        let owner = &capture.source.owner;
        if owner.project_id != PROJECT_ID || owner.branch != BRANCH {
            return Err(failure(
                "CORRELATION",
                "approval",
                "Archive source owner changed",
            ));
        }
        let scope = captured_scope(capture)?;
        let folder = current_run_folder(&self.pool, capture, &scope).await?;
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
            .lock_execution_tools(PROJECT_ID)
            .await
            .map_err(|_| failure("PERMISSION", "approval", "Current tools are unavailable"))?;
        if scope_for(&folder, owner)?["rootIdentity"] != scope["rootIdentity"] {
            return Err(failure(
                "CAPTURE_CHANGED",
                "approval",
                "Archive workspace identity changed",
            ));
        }
        let current = crate::agsdl_host_tools::permissions("Implement", false, &project.tools)?;
        let path = write_target(payload)?;
        let in_scope = path != folder
            && path.starts_with(&folder)
            && path.is_file()
            && path.canonicalize().is_ok_and(|actual| actual == path);
        let allowed = in_scope && policy_allows(ceiling.permissions(), &current, &scope, payload)?;
        Ok((allowed, (ceiling, project)))
    }
}

fn captured_scope(capture: &StartCapture030) -> Result<Value> {
    let private: Value = serde_json::from_str(&capture.private_capture_json)?;
    Ok(serde_json::from_str(
        private["callScopeJson"]
            .as_str()
            .ok_or_else(|| failure("CORRELATION", "approval", "Native scope is absent"))?,
    )?)
}

fn write_target(payload: &Value) -> Result<&Path> {
    payload
        .pointer("/nativeRequest/params/additionalPermissions/fileSystem/write/0")
        .and_then(Value::as_str)
        .map(Path::new)
        .ok_or_else(|| failure("CORRELATION", "approval", "Native file scope is absent"))
}

fn policy_allows(
    ceiling: &crate::agsdl_permissions::RequestedPermissions,
    tools: &Value,
    scope: &Value,
    payload: &Value,
) -> Result<bool> {
    use crate::agsdl_permissions::*;
    let root = scope["root"]
        .as_str()
        .ok_or_else(|| failure("CORRELATION", "approval", "Native root is absent"))?;
    let policy = normalize_requested(
        ceiling.clone(),
        PathContext {
            workspace: root.into(),
            home: std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or_else(|| failure("PERMISSION", "approval", "Native home is absent"))?,
        },
    )
    .map_err(|_| failure("PERMISSION", "approval", "Current permissions are invalid"))?;
    let path = write_target(payload)?.to_string_lossy().into_owned();
    Ok(!crate::core::tool_policy::agsdl_native_read_only(tools)
        && evaluate_requested(&policy, &ActionRequest::Write { path })
            .is_ok_and(|effect| effect != Effect::Deny)
        && evaluate_requested(
            &policy,
            &ActionRequest::Shell {
                command: payload["nativeRequest"]["params"]["command"]
                    .as_str()
                    .unwrap_or("")
                    .into(),
            },
        )
        .is_ok_and(|effect| effect == Effect::Allow))
}
