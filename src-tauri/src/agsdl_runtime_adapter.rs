//! Macro keeps configuration ownership; the runtime receives locked projections.
use crate::config::ConfigManager;
use argentic_runtime::{
    host::{PolicyFuture, PolicySource},
    persistence::failure,
};
use std::sync::Arc;

struct MacroPolicy(ConfigManager);
impl PolicySource for MacroPolicy {
    fn lock_project<'a>(&'a self, project: &'a str) -> PolicyFuture<'a, ProjectPolicyLease> {
        Box::pin(async move {
            let lease = self.0.lock_execution_tools(project).await.map_err(|_| {
                failure(
                    "PERMISSION",
                    "project",
                    "Approved project configuration is unavailable",
                )
            })?;
            Ok(ProjectPolicyLease::new(
                lease.tools.clone(),
                lease.agsdl_host_permissions.clone(),
                lease,
            ))
        })
    }
    fn lock_ceiling(&self) -> PolicyFuture<'_, HostPolicyLease> {
        Box::pin(async move {
            let lease = self.0.lock_agsdl_host_permissions().await.map_err(|_| {
                failure(
                    "PERMISSION",
                    "policy",
                    "Approved host permissions are unavailable",
                )
            })?;
            Ok(HostPolicyLease::new(
                lease.permissions().clone(),
                lease.fingerprint().to_owned(),
                lease,
            ))
        })
    }
}
impl ConfigManager {
    pub(crate) fn engine_context(&self) -> HostContext {
        HostContext::new(self.root().to_owned(), Arc::new(MacroPolicy(self.clone())))
    }
}
impl From<ConfigManager> for HostContext {
    fn from(config: ConfigManager) -> Self {
        config.engine_context()
    }
}

pub(crate) use argentic_runtime::host::{HostContext, HostPolicyLease, ProjectPolicyLease};
