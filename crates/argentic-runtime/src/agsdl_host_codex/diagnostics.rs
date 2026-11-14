//! Fixed failure categories only. Never retain a native error's free text,
//! details, auth callback, account identifiers or arbitrary error codes.
use crate::persistence::dto::EngineFailure;
use serde_json::Value;

pub(crate) fn turn_error(error: &Value) -> &'static str {
    let info = &error["codexErrorInfo"];
    match info.as_str() {
        Some("sandboxError") => "CODEX_TURN_SANDBOX_ERROR",
        Some("unauthorized") => "CODEX_TURN_UNAUTHORIZED",
        Some("internalServerError") => "CODEX_TURN_INTERNAL_ERROR",
        Some("badRequest") => "CODEX_TURN_BAD_REQUEST",
        Some("contextWindowExceeded" | "sessionBudgetExceeded") => "CODEX_TURN_CONTEXT_LIMIT",
        Some("usageLimitExceeded" | "rateLimitExceeded") => "CODEX_TURN_USAGE_LIMIT",
        Some("modelNotFound") => "CODEX_TURN_MODEL_NOT_FOUND",
        Some("flexUnavailable" | "serverOverloaded" | "policyCapacityUnavailable") => {
            "CODEX_TURN_CAPACITY"
        }
        Some("cyberPolicy" | "misalignmentPolicyViolation" | "tooManyDenials") => {
            "CODEX_TURN_POLICY"
        }
        _ => match info
            .as_object()
            .filter(|object| object.len() == 1)
            .and_then(|object| object.keys().next())
            .map(String::as_str)
        {
            Some("httpConnectionFailed" | "responseStreamConnectionFailed") => {
                "CODEX_TURN_CONNECTION_FAILED"
            }
            Some("responseStreamDisconnected" | "responseTooManyFailedAttempts") => {
                "CODEX_TURN_STREAM_FAILED"
            }
            _ => "CODEX_TURN_FAILED",
        },
    }
}

/// Only a value from this closed list enters the diagnostic. The existing work
/// protocol keeps its own closed AGENT_FAILED terminal code unchanged.
pub(crate) fn fixed_code(error: &EngineFailure) -> &'static str {
    if error.code == "CORRELATION" {
        return if error.pointer == "approvalMethod" {
            "CODEX_APPROVAL_METHOD_UNQUALIFIED"
        } else {
            "AGENT_CORRELATION"
        };
    }
    const CODES: &[&str] = &[
        "CODEX_REQUEST_FAILED",
        "CODEX_RPC_SERVER_REQUEST_UNQUALIFIED",
        "CODEX_PROFILE_UNQUALIFIED",
        "CODEX_CONTEXT_UNQUALIFIED",
        "CODEX_SANDBOX_UNQUALIFIED",
        "CODEX_START_FAILED",
        "CODEX_ACCOUNT_UNQUALIFIED",
        "CODEX_PACKAGE_INCOMPLETE",
        "CODEX_AUTH_FAILED",
        "CODEX_AUTH_EXPIRED",
        "CODEX_AUTH_ACCOUNT_CHANGED",
        "CODEX_AUTH_REFRESH_REQUIRED",
        "CODEX_AUTH_TIMEOUT",
        "CODEX_AUTH_PROFILE_CONFLICT",
        "CODEX_AUTH_SOURCE_UNSUPPORTED",
        "CODEX_AUTH_SOURCE_UNAVAILABLE",
        "CODEX_AUTH_VERSION_UNQUALIFIED",
        "CODEX_TURN_FAILED",
        "CODEX_TURN_SANDBOX_ERROR",
        "CODEX_TURN_UNAUTHORIZED",
        "CODEX_TURN_INTERNAL_ERROR",
        "CODEX_TURN_BAD_REQUEST",
        "CODEX_TURN_CONTEXT_LIMIT",
        "CODEX_TURN_USAGE_LIMIT",
        "CODEX_TURN_MODEL_NOT_FOUND",
        "CODEX_TURN_CAPACITY",
        "CODEX_TURN_POLICY",
        "CODEX_TURN_CONNECTION_FAILED",
        "CODEX_TURN_STREAM_FAILED",
        "CODEX_TURN_INTERRUPTED",
        "CODEX_TURN_FAILED_AFTER_SCOPE_DECLINE",
        "CODEX_APPROVAL_METHOD_UNQUALIFIED",
        "NATIVE_UNCERTAIN",
        "HARNESS_CAPABILITY",
    ];
    CODES
        .iter()
        .copied()
        .find(|code| *code == error.code)
        .unwrap_or("AGENT_FAILED")
}

pub(crate) fn entry(
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    error: &EngineFailure,
) -> Value {
    serde_json::json!({"kind":"argentic.nativeAgentFailure","code":fixed_code(error),
        "identity":attempt.identity(),"activationId":attempt.work().activation_id,
        "startEffectId":attempt.start_effect_id(),"generation":attempt.generation()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_never_exports_arbitrary_native_fields() {
        let error = crate::persistence::failure(
            "SYNTHETIC_NATIVE_SECRET",
            "SYNTHETIC_NATIVE_SECRET",
            "SYNTHETIC_NATIVE_SECRET",
        );
        assert_eq!(fixed_code(&error), "AGENT_FAILED");
        assert_eq!(
            turn_error(
                &serde_json::json!({"codexErrorInfo":{"SYNTHETIC_NATIVE_SECRET":{}},"message":"SYNTHETIC_NATIVE_SECRET"})
            ),
            "CODEX_TURN_FAILED"
        );
    }
}
