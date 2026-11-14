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
    codex_auth_file: Option<PathBuf>,
}
impl HostContext {
    pub fn new(root: PathBuf, policy: Arc<dyn PolicySource>) -> Self {
        Self {
            root,
            policy,
            network: Arc::new(crate::content_network::UnavailableNetwork),
            codex_auth_file: None,
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
    /// Explicit native-host opt-in to read an existing ChatGPT auth file. No
    /// configuration, refresh writes or credentials cross the public API.
    /// The isolated private login remains the default. See HOST.md.
    pub fn with_codex_auth_file(mut self, path: PathBuf) -> Self {
        self.codex_auth_file = Some(path);
        self
    }
    pub(crate) fn codex_auth_file(&self) -> Option<&Path> {
        self.codex_auth_file.as_deref()
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

/// Current source/policy checks only. A policy result never replaces the
/// runtime's reserved human decision or permits a physical response by itself.
pub trait ActionPolicySource: Send + Sync {
    fn lock_current<'a>(
        &'a self,
        capture: &'a crate::persistence::start030::StartCapture030,
        payload: &'a Value,
    ) -> PolicyFuture<'a, ActionPolicyLease>;
}
/// Owns the host's real guards through native delivery and acknowledgement.
pub struct ActionPolicyLease {
    allowed: bool,
    _guard: Box<dyn Send + Sync>,
}
impl ActionPolicyLease {
    pub fn new(allowed: bool, guard: impl Send + Sync + 'static) -> Self {
        Self {
            allowed,
            _guard: Box::new(guard),
        }
    }
    pub(crate) fn allows(&self) -> bool {
        self.allowed
    }
}
