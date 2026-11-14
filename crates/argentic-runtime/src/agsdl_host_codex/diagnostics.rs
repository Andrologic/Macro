//! Fixed failure categories only. Never retain a native error's free text,
//! details, auth callback, account identifiers or arbitrary error codes.
use crate::persistence::dto::EngineFailure;
use serde_json::Value;

/// Native call sites select these stages; no model, event or error pointer can
/// supply a stage. Several lines may describe the same propagated failure.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Stage {
    Executor,
    ExecutorStop,
    Session,
    Ask,
    BrokerAttach,
    BrokerAdmit,
    BrokerOwner,
    BrokerOpen,
    BrokerPump,
    BrokerWait,
    BrokerResolution,
    BrokerInspect,
    BrokerPolicy,
    BrokerDeliver,
    BrokerReply,
    WorkEvent,
    WorkSubmit,
    WorkCheck,
}

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
    // EngineFailure conversions discard SQL/JSON details before reaching us.
    // Preserve their category and native guard categories without exporting any
    // original message, pointer, work payload or unrecognized code.
    const ENGINE_CODES: &[(&str, &str)] = &[
        ("STORAGE", "ENGINE_STORAGE"),
        ("AUTHORITY", "ENGINE_AUTHORITY"),
        ("PERMISSION", "ENGINE_PERMISSION"),
        ("RUNTIME_UNAVAILABLE", "ENGINE_RUNTIME_UNAVAILABLE"),
        ("HOST_CAPABILITY", "ENGINE_HOST_CAPABILITY"),
        ("HARNESS_REFUSED", "ENGINE_HARNESS_REFUSED"),
        ("STALE_REFERENCE", "ENGINE_STALE_REFERENCE"),
        ("STALE_TICKET", "ENGINE_STALE_TICKET"),
        ("FLOW_BLOCKED", "ENGINE_FLOW_BLOCKED"),
        ("NOT_CLAIMABLE", "ENGINE_NOT_CLAIMABLE"),
        ("INPUT_LIMIT", "ENGINE_INPUT_LIMIT"),
        ("INPUT_CONSTRAINT", "ENGINE_INPUT_CONSTRAINT"),
        ("INTERRUPTED", "ENGINE_INTERRUPTED"),
        ("CANCELLED", "ENGINE_CANCELLED"),
        ("STOP_PENDING", "ENGINE_STOP_PENDING"),
        ("STOPPED", "ENGINE_STOPPED"),
        ("UNCERTAIN", "ENGINE_UNCERTAIN"),
        ("COMMIT_UNCERTAIN", "ENGINE_COMMIT_UNCERTAIN"),
        ("CAPTURE_CHANGED", "ENGINE_CAPTURE_CHANGED"),
        ("UNSUPPORTED", "ENGINE_UNSUPPORTED"),
        ("UNSUPPORTED_EDITION", "ENGINE_UNSUPPORTED_EDITION"),
        ("PARSE", "ENGINE_PARSE"),
        ("OPERAND", "ENGINE_OPERAND"),
        ("OUTPUT_INVALID", "ENGINE_OUTPUT_INVALID"),
        ("CALL_FAILED", "ENGINE_CALL_FAILED"),
        ("TIMEOUT", "ENGINE_TIMEOUT"),
        ("CONFLICT", "ENGINE_CONFLICT"),
        ("NOT_FOUND", "ENGINE_NOT_FOUND"),
        ("SOURCE_UNAVAILABLE", "ENGINE_SOURCE_UNAVAILABLE"),
        (
            "ROUTE_PREPARATION_FAILED",
            "ENGINE_ROUTE_PREPARATION_FAILED",
        ),
        (
            "PARTIAL_STOP_UNAVAILABLE",
            "ENGINE_PARTIAL_STOP_UNAVAILABLE",
        ),
        ("SHUTDOWN_PENDING", "ENGINE_SHUTDOWN_PENDING"),
        (
            "SHUTDOWN_ACTIVITY_CHANGED",
            "ENGINE_SHUTDOWN_ACTIVITY_CHANGED",
        ),
        (
            "UNSPECIFIED_SHARED_CANCELLATION",
            "ENGINE_UNSPECIFIED_SHARED_CANCELLATION",
        ),
    ];
    if let Some((_, code)) = ENGINE_CODES
        .iter()
        .find(|(source, _)| *source == error.code)
    {
        return code;
    }
    const CODES: &[&str] = &[
        "CODEX_OPT_IN_REQUIRED",
        "CODEX_NOT_INSTALLED",
        "CODEX_PLATFORM_UNQUALIFIED",
        "CODEX_VERSION_UNQUALIFIED",
        "CODEX_MODEL_UNQUALIFIED",
        "CODEX_LOGIN_REQUIRED",
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
        "CONTENT_SOURCE_UNSUPPORTED",
        "CONTENT_UNAVAILABLE",
        "CONTENT_ENCODING",
        "CONTENT_FORMAT",
        "CONTENT_JSON",
        "CONTENT_ORIGIN",
        "CONTENT_TERMINATION_UNCERTAIN",
        "CONTENT_URI",
        "CONTENT_SCHEME",
        "INVALID_SKILL",
        "INVALID_SOURCE",
    ];
    CODES
        .iter()
        .copied()
        .find(|code| *code == error.code)
        .unwrap_or("UNCLASSIFIED_FAILURE")
}

pub(crate) fn entry(
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    error: &EngineFailure,
) -> Value {
    entry_at(attempt, Stage::Executor, error)
}

pub(crate) fn entry_at(
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    stage: Stage,
    error: &EngineFailure,
) -> Value {
    serde_json::json!({"kind":"argentic.nativeAgentFailure","code":fixed_code(error),
        "stage":stage,
        "identity":attempt.identity(),"activationId":attempt.work().activation_id,
        "startEffectId":attempt.start_effect_id(),"generation":attempt.generation()})
}

/// Report at an actual fallible boundary, then propagate the original result.
/// Diagnostic IO cannot change admission, failure handling or physical cleanup.
pub(crate) fn at<T>(
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    stage: Stage,
    result: crate::persistence::Result<T>,
) -> crate::persistence::Result<T> {
    if let Err(error) = &result {
        use std::io::Write;
        let _ = writeln!(
            std::io::stderr().lock(),
            "{}",
            entry_at(attempt, stage, error)
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_boundaries_preserve_the_error_and_reject_private_fields() {
        let attempt =
            crate::agsdl_host_flow030::FlowWorkAttempt030::registry_fixture030("diagnostic");
        for (stage, name) in [
            (Stage::Executor, "executor"),
            (Stage::ExecutorStop, "executorStop"),
            (Stage::Session, "session"),
            (Stage::Ask, "ask"),
            (Stage::BrokerAttach, "brokerAttach"),
            (Stage::BrokerAdmit, "brokerAdmit"),
            (Stage::BrokerOwner, "brokerOwner"),
            (Stage::BrokerOpen, "brokerOpen"),
            (Stage::BrokerPump, "brokerPump"),
            (Stage::BrokerWait, "brokerWait"),
            (Stage::BrokerResolution, "brokerResolution"),
            (Stage::BrokerInspect, "brokerInspect"),
            (Stage::BrokerPolicy, "brokerPolicy"),
            (Stage::BrokerDeliver, "brokerDeliver"),
            (Stage::BrokerReply, "brokerReply"),
            (Stage::WorkEvent, "workEvent"),
            (Stage::WorkSubmit, "workSubmit"),
            (Stage::WorkCheck, "workCheck"),
        ] {
            let mut error =
                crate::persistence::failure("STORAGE", "SYNTHETIC_PRIVATE", "SYNTHETIC_PRIVATE");
            error.work = Some(attempt.work().clone());
            let entry = entry_at(&attempt, stage, &error);
            assert_eq!(entry["stage"], name);
            assert_eq!(entry["code"], "ENGINE_STORAGE");
            assert_eq!(entry.as_object().unwrap().len(), 7);
            assert!(!entry.to_string().contains("SYNTHETIC_PRIVATE"));
            assert_eq!(
                at::<()>(&attempt, stage, Err(error.clone())).unwrap_err(),
                error
            );
            assert_eq!(at(&attempt, stage, Ok(42)).unwrap(), 42);
        }
        for code in [
            "SYNTHETIC_PRIVATE",
            "CODEX_SYNTHETIC_PRIVATE",
            "STORAGE\nSYNTHETIC_PRIVATE",
        ] {
            assert_eq!(
                fixed_code(&crate::persistence::failure(code, "", "")),
                "UNCLASSIFIED_FAILURE"
            );
        }
    }
    #[test]
    fn diagnostic_engine_conversions_do_not_collapse_to_agent_failed() {
        let storage: EngineFailure = sqlx::Error::RowNotFound.into();
        assert_eq!(fixed_code(&storage), "ENGINE_STORAGE");
        let malformed: EngineFailure = serde_json::from_str::<Value>("SYNTHETIC_PRIVATE")
            .unwrap_err()
            .into();
        assert_eq!(fixed_code(&malformed), "AGENT_CORRELATION");
        assert!(!serde_json::to_string(&malformed)
            .unwrap()
            .contains("SYNTHETIC_PRIVATE"));
        for (code, expected) in [
            ("RUNTIME_UNAVAILABLE", "ENGINE_RUNTIME_UNAVAILABLE"),
            ("AUTHORITY", "ENGINE_AUTHORITY"),
            ("PERMISSION", "ENGINE_PERMISSION"),
            ("INPUT_LIMIT", "ENGINE_INPUT_LIMIT"),
            ("UNCERTAIN", "ENGINE_UNCERTAIN"),
            ("STOP_PENDING", "ENGINE_STOP_PENDING"),
            ("CONTENT_SCHEME", "CONTENT_SCHEME"),
        ] {
            let error = crate::persistence::failure(code, "SYNTHETIC_PRIVATE", "SYNTHETIC_PRIVATE");
            assert_eq!(fixed_code(&error), expected, "{code}");
        }
    }
    #[test]
    fn diagnostic_never_exports_arbitrary_native_fields() {
        let error = crate::persistence::failure(
            "SYNTHETIC_NATIVE_SECRET",
            "SYNTHETIC_NATIVE_SECRET",
            "SYNTHETIC_NATIVE_SECRET",
        );
        assert_eq!(fixed_code(&error), "UNCLASSIFIED_FAILURE");
        assert_eq!(
            turn_error(
                &serde_json::json!({"codexErrorInfo":{"SYNTHETIC_NATIVE_SECRET":{}},"message":"SYNTHETIC_NATIVE_SECRET"})
            ),
            "CODEX_TURN_FAILED"
        );
    }
}
