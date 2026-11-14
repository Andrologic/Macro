//! Owned AgSDL runtime.
mod native_numbers;

/// Native calculations preserve the integrated codec's scalar conversions.
pub mod calculation {
    pub use argentic_core::calculation::Failure;
    pub fn compile(authored: &str, source: &str, registry: &str) -> Result<String, Failure> {
        argentic_core::calculation::compile(
            authored,
            source,
            registry,
            super::native_numbers::normalize,
        )
    }
    pub fn work(input: &str) -> Result<String, Failure> {
        argentic_core::calculation::work(input, super::native_numbers::normalize)
    }
    pub fn route(input: &str) -> Result<String, Failure> {
        argentic_core::calculation::route(input, super::native_numbers::normalize)
    }
}

pub mod permissions;

pub mod persistence;
pub mod sqlite;

pub mod host;

/// Native capture preparation shared with desktop and standalone hosts.
pub mod capture;

/// Small, explicitly configured single-process host.
pub mod standalone;

/// Shared physical process lifecycle and containment.
pub mod process;

pub mod content_io;

#[doc(hidden)]
pub mod skill_text;

pub mod content_network;

pub mod content;

#[doc(hidden)]
pub mod tool_policy;

mod agsdl_host;
mod agsdl_host_call_authority030;
mod agsdl_host_call_executor030;
mod agsdl_host_calls;
mod agsdl_host_calls030;
mod agsdl_host_clock030;
mod agsdl_host_codex;
mod agsdl_host_codex030;
mod agsdl_host_compiler;
mod agsdl_host_completion030;
mod agsdl_host_confinement;
mod agsdl_host_dispatch030;
mod agsdl_host_evaluation030;
mod agsdl_host_flow030;
mod agsdl_host_harness030;
mod agsdl_host_human030;
mod agsdl_host_human_executor030;
mod agsdl_host_human_projection030;
mod agsdl_host_projection030;
mod agsdl_host_qualification030;
mod agsdl_host_route030;
mod agsdl_host_route_attestations030;
mod agsdl_host_route_verifier030;
mod agsdl_host_runtime030;
mod agsdl_host_steer030;
mod agsdl_host_stop030;
mod agsdl_host_work;
mod agsdl_host_work_admission030;
mod tasks;

/// One independently owned execution incarnation; clones share it.
pub use agsdl_host::HostState as Engine;

pub mod api;

mod agsdl_host_action_approval030;

/// Runs the bounded synthetic native approval regressions. No caller-supplied
/// authority, native request, decision or physical reply can cross this entry.
#[cfg(feature = "dev-support")]
#[doc(hidden)]
pub async fn check_approval_boundary() {
    agsdl_host_human030::HumanRuntime030::check_approval_boundary().await;
}

#[cfg(test)]
mod agsdl_host_scenario030;

#[cfg(test)]
mod agsdl_host_example030;

#[cfg(test)]
mod test_context;

#[cfg(any(test, feature = "dev-support"))]
#[doc(hidden)]
pub mod dev_fixture;
