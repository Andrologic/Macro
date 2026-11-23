pub(crate) use argentic_runtime::api::{
    OperatorWorkState, RuntimeProjectionContinuation030, RuntimeProjectionPage030,
    RuntimeProjectionQuery030,
};
pub(crate) async fn read(
    host: &crate::agsdl_host::HostState,
    pool: &sqlx::SqlitePool,
    scope: RuntimeProjectionQuery030,
    continuation: Option<RuntimeProjectionContinuation030>,
) -> crate::db::agsdl_execution::Result<RuntimeProjectionPage030> {
    let mut page = host.runtime_projection(pool, scope, continuation).await?;
    if matches!(page.verdict.as_deref(), Some("cancelled" | "interrupted")) {
        let shutdown: Option<(bool, String)> = sqlx::query_as(
            "SELECT paused, holds_json FROM operate_shutdown_holds WHERE system_id=? AND invocation_id=?",
        )
        .bind(&page.scope.system_start_id)
        .bind(&page.flow_invocation_id)
        .fetch_optional(pool)
        .await?;
        if let Some((paused, holds_json)) = shutdown {
            let holds: std::collections::BTreeMap<String, serde_json::Value> =
                serde_json::from_str(&holds_json)?;
            page.verdict = Some("interrupted".into());
            page.interrupted_while_paused |= paused;
            page.operator_works.extend(holds.into_keys().map(|id| {
                (
                    id,
                    OperatorWorkState::Interrupted {
                        code: "INTERRUPTED".into(),
                    },
                )
            }));
        }
    }
    Ok(page)
}
#[path = "agsdl_host_projection030_ipc.rs"]
pub(crate) mod ipc;
