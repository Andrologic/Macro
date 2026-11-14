pub(crate) use argentic_runtime::api::{
    codex_status as profile_status, observe_codex as observe_catalogue030,
    qualified_codex_version as qualified_version030, CodexObservation as CodexObservation030,
    CodexStatus, CODEX_ADAPTER as ADAPTER,
};
pub(crate) async fn observe(
    context: &argentic_runtime::host::HostContext,
    scope: &serde_json::Value,
    read_only: bool,
) -> crate::db::agsdl_execution::Result<Option<((), Vec<String>, String)>> {
    Ok(observe_catalogue030(context, scope, read_only)
        .await?
        .map(|observed| {
            (
                (),
                observed
                    .models
                    .iter()
                    .filter_map(|model| model["name"].as_str().map(str::to_owned))
                    .collect(),
                observed.account_digest,
            )
        }))
}
