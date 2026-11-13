//! Approved host policy inputs. These leases freeze inputs, never grant work.
use crate::{permissions::RequestedPermissions, persistence::Result};
use serde_json::Value;
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

pub type PolicyFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// Retains the host's actual approval/configuration locks until admission ends.
pub struct ProjectPolicyLease {
    pub tools: Value,
    pub agsdl_host_permissions: RequestedPermissions,
    _guard: Box<dyn Send + Sync>,
}
impl ProjectPolicyLease {
    pub fn new(
        tools: Value,
        agsdl_host_permissions: RequestedPermissions,
        guard: impl Send + Sync + 'static,
    ) -> Self {
        Self {
            tools,
            agsdl_host_permissions,
            _guard: Box::new(guard),
        }
    }
}
pub struct HostPolicyLease {
    permissions: RequestedPermissions,
    fingerprint: String,
    _guard: Box<dyn Send + Sync>,
}
impl HostPolicyLease {
    pub fn new(
        permissions: RequestedPermissions,
        fingerprint: String,
        guard: impl Send + Sync + 'static,
    ) -> Self {
        Self {
            permissions,
            fingerprint,
            _guard: Box::new(guard),
        }
    }
    pub fn permissions(&self) -> &RequestedPermissions {
        &self.permissions
    }
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

/// Native host implementations return only approved policy projections and
/// retain their real locks. They expose neither provider configuration nor secrets.
pub trait PolicySource: Send + Sync {
    fn lock_project<'a>(&'a self, project: &'a str) -> PolicyFuture<'a, ProjectPolicyLease>;
    fn lock_ceiling(&self) -> PolicyFuture<'_, HostPolicyLease>;
}

#[derive(Clone)]
pub struct HostContext {
    root: PathBuf,
    policy: Arc<dyn PolicySource>,
    network: Arc<dyn crate::content_network::ContentNetwork>,
}
impl HostContext {
    pub fn new(root: PathBuf, policy: Arc<dyn PolicySource>) -> Self {
        Self {
            root,
            policy,
            network: Arc::new(crate::content_network::UnavailableNetwork),
        }
    }
    pub fn with_network(
        mut self,
        network: Arc<dyn crate::content_network::ContentNetwork>,
    ) -> Self {
        self.network = network;
        self
    }
    pub fn network(&self) -> Arc<dyn crate::content_network::ContentNetwork> {
        self.network.clone()
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub async fn lock_execution_tools(&self, project: &str) -> Result<ProjectPolicyLease> {
        self.policy.lock_project(project).await
    }
    pub async fn lock_agsdl_host_permissions(&self) -> Result<HostPolicyLease> {
        self.policy.lock_ceiling().await
    }
}
