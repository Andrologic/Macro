//! Macro's UI-intention hooks execute inside the runtime's Start transaction.
use super::{
    dto::EngineStartRequest,
    intents::{self, IntentAdmissionLink},
    Result,
};
use argentic_runtime::persistence::start030::{self as native, HookFuture, StartIntentHook};
pub(crate) use argentic_runtime::persistence::start030::{
    validate_capture, RetainedStart030, StartAuthority030, StartCapture030, StartInspection030,
    StartReceipt030,
};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};

struct IntentHook<'a> {
    link: Option<&'a IntentAdmissionLink>,
}
impl StartIntentHook for IntentHook<'_> {
    fn reserve<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        request: &'a EngineStartRequest,
    ) -> HookFuture<'a> {
        Box::pin(async move { intents::reserve_start(db, request, self.link).await })
    }
    fn verify<'a>(&'a self, db: &'a mut SqliteConnection, system: &'a str) -> HookFuture<'a> {
        Box::pin(async move {
            if let Some(link) = self.link {
                intents::verify_attached030(db, link, system).await?;
            }
            Ok(())
        })
    }
    fn attach<'a>(&'a self, db: &'a mut SqliteConnection, system: &'a str) -> HookFuture<'a> {
        Box::pin(async move {
            if let Some(link) = self.link {
                intents::attach030(db, link, system).await?;
            }
            Ok(())
        })
    }
}
pub(crate) async fn start<A: StartAuthority030>(
    pool: &SqlitePool,
    request: &EngineStartRequest,
    authority: &A,
) -> Result<RetainedStart030> {
    start_linked(pool, request, authority, None).await
}
pub(crate) async fn start_linked<A: StartAuthority030>(
    pool: &SqlitePool,
    request: &EngineStartRequest,
    authority: &A,
    link: Option<&IntentAdmissionLink>,
) -> Result<RetainedStart030> {
    native::start_linked(pool, request, authority, &IntentHook { link }).await
}
pub(crate) async fn inspect<A: StartAuthority030>(
    pool: &SqlitePool,
    request: &EngineStartRequest,
    authority: &A,
) -> Result<StartInspection030> {
    inspect_linked(pool, request, authority, None).await
}
pub(crate) async fn inspect_linked<A: StartAuthority030>(
    pool: &SqlitePool,
    request: &EngineStartRequest,
    authority: &A,
    link: Option<&IntentAdmissionLink>,
) -> Result<StartInspection030> {
    native::inspect_linked(pool, request, authority, &IntentHook { link }).await
}
#[cfg(test)]
#[path = "start030_tests.rs"]
mod tests;
