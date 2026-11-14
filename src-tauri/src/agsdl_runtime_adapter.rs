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
            .with_network(Arc::new(MacroContentNetwork))
    }
}
impl From<ConfigManager> for HostContext {
    fn from(config: ConfigManager) -> Self {
        config.engine_context()
    }
}

pub(crate) use argentic_runtime::host::{HostContext, HostPolicyLease, ProjectPolicyLease};

struct MacroContentNetwork;
impl argentic_runtime::content_network::ContentNetwork for MacroContentNetwork {
    fn fetch<'a>(
        &'a self,
        url: url::Url,
        cancel: &'a tokio_util::sync::CancellationToken,
        admit: &'a mut argentic_runtime::content_network::AdmitNetwork<'a>,
    ) -> argentic_runtime::content_network::FetchFuture<
        'a,
        argentic_runtime::content_network::NetworkResource,
    > {
        Box::pin(async move {
            let result = crate::commands::web_search::fetch_content_with_admission(
                url,
                cancel,
                &mut |target, ip| {
                    let pending = admit(target, ip);
                    async move { pending.await.map_err(crate::commands::command_error) }
                },
            )
            .await
            .map_err(|e| e.message)?;
            Ok(argentic_runtime::content_network::NetworkResource {
                url: result.url,
                content_type: result.content_type,
                body_base64: result.body_base64,
            })
        })
    }
}

impl From<argentic_runtime::content_io::admitted::ReadError> for crate::core::error::BackendError {
    fn from(value: argentic_runtime::content_io::admitted::ReadError) -> Self {
        use argentic_runtime::content_io::admitted::ReadError as R;
        match value {
            R::Io { message, source } => Self::Io { message, source },
            R::Filesystem { message } => Self::Filesystem { message },
            R::FilesystemNotFound { message } => Self::FilesystemNotFound { message },
            R::FilesystemPermissionDenied { message } => {
                Self::FilesystemPermissionDenied { message }
            }
            R::FilesystemAlreadyExists { message } => Self::FilesystemAlreadyExists { message },
            R::FilesystemInvalidPath { message } => Self::FilesystemInvalidPath { message },
            R::FilesystemDiskFull { message } => Self::FilesystemDiskFull { message },
            R::FilesystemIsDirectory { message } => Self::FilesystemIsDirectory { message },
            R::ResourcePressure { message } => Self::ResourcePressure { message },
        }
    }
}
