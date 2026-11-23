pub(crate) use argentic_runtime::api::{
    RuntimeProjectionContinuation030, RuntimeProjectionPage030, RuntimeProjectionQuery030,
};
pub(crate) async fn read(
    host: &crate::agsdl_host::HostState,
    pool: &sqlx::SqlitePool,
    scope: RuntimeProjectionQuery030,
    continuation: Option<RuntimeProjectionContinuation030>,
) -> crate::db::agsdl_execution::Result<RuntimeProjectionPage030> {
    host.runtime_projection(pool, scope, continuation).await
}
#[path = "agsdl_host_projection030_ipc.rs"]
pub(crate) mod ipc;
