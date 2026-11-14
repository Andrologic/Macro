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

/// Shared physical process lifecycle and containment.
pub mod process;

pub mod content_io;

#[doc(hidden)]
pub mod skill_text;

pub mod content_network;

pub mod content;

#[doc(hidden)]
pub mod tool_policy;
