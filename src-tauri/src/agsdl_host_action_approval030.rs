//! Current Macro source/policy verification; no native approval or response API.
use crate::db::agsdl_execution::{failure, start030::StartCapture030, Result};
use argentic_runtime::host::{ActionPolicyLease, ActionPolicySource, PolicyFuture};
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
            use crate::agsdl_permissions::*;
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
            let private: serde_json::Value = serde_json::from_str(&capture.private_capture_json)?;
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
            Ok(ActionPolicyLease::new(allowed, (source, ceiling, project)))
        })
    }
}
