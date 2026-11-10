//! Native call authority. No process or network grant is manufactured here.
use crate::{
    agsdl_host::{HostStartLease, HostState},
    agsdl_host_calls030::{CallAuthority030, CallCommitFence030},
    agsdl_host_flow030::Authority,
    db::agsdl_execution::{
        dto::EngineOwner,
        flow030::{FlowEffect030, FlowIdentity030},
        flow_store030::{Authority030, CheckFuture, StoreError030},
        start030::StartCapture030,
        Result,
    },
};
use sqlx::SqliteConnection;
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) struct NativeCallAuthority030<'a> {
    host: &'a HostState,
    lease: HostStartLease,
    owner: EngineOwner,
}
impl<'a> NativeCallAuthority030<'a> {
    pub(crate) async fn capture(host: &'a HostState, owner: &EngineOwner) -> Result<Self> {
        let lease = host.start_lease().await?;
        if lease.owner(&owner.system_start_id)? != *owner {
            return Err(crate::db::agsdl_execution::failure(
                "AUTHORITY",
                "call",
                "Foreign call owner",
            ));
        }
        Ok(Self {
            host,
            lease,
            owner: owner.clone(),
        })
    }
    fn flow_authority(&self) -> Authority<'_> {
        Authority {
            runtime: self.host.flow030(),
            lease: &self.lease,
            owner: self.owner.clone(),
        }
    }
}
impl Authority030 for NativeCallAuthority030<'_> {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move { self.flow_authority().owner(db, id).await })
    }
    fn effect<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async move { self.flow_authority().effect(db, effect).await })
    }
    fn settlement<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
        receipt: &'a serde_json::Value,
    ) -> CheckFuture<'a> {
        Box::pin(async move { self.flow_authority().settlement(db, effect, receipt).await })
    }
    fn owner_epoch(&self) -> &str {
        &self.owner.owner_epoch
    }
}
impl CallAuthority030 for NativeCallAuthority030<'_> {
    fn generation(&self) -> &str {
        self.lease.generation()
    }
    fn ensure_live(&self) -> Result<()> {
        self.lease.ensure_live()
    }
    fn call_commits(&self) -> &CallCommitFence030 {
        &self.host.flow030().call_commits
    }
    fn admission_lock(&self) -> Arc<Mutex<()>> {
        self.host.admission_lock()
    }
    fn qualify_tx<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        capture: &'a StartCapture030,
        effect: &'a FlowEffect030,
        declaration: &'a str,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            self.owner(db, &capture.identity).await?;
            self.effect(db, effect).await?;
            #[cfg(test)]
            if crate::agsdl_host_example030::qualify_synthetic_call030(capture, effect, declaration)
                .is_ok()
            {
                return Ok(());
            }
            let step: serde_json::Value = serde_json::from_str(declaration)?;
            let document: serde_json::Value = serde_json::from_str(&capture.authored_source)?;
            if crate::agsdl_host_capture::product_slice030(
                &capture.authored_source,
                Some(&capture.compiled_plan_json),
            )
            .is_some()
                || step["type"] != "call"
                || step.get("timeoutMs").is_some()
                || step.get("answerTimeoutMs").is_some()
                || step.get("command").is_some() == step.get("mcp").is_some()
            {
                return Err(StoreError030::Authority);
            }
            if let Some(mcp) = step.get("mcp") {
                let server = mcp["server"].as_str().ok_or(StoreError030::Authority)?;
                if document["mcpServers"][server]["command"]
                    .as_array()
                    .is_none()
                {
                    return Err(StoreError030::Authority);
                }
            }
            Ok(())
        })
    }
}

#[cfg(all(test, feature = "agsdl-engine-qa", debug_assertions))]
mod tests {
    use super::*;
    use crate::agsdl_host_calls030::{self as calls, tests::Fixture};

    #[tokio::test]
    async fn native_authority_refuses_unqualified_transport_and_foreign_generation() {
        let f = Fixture::new(r#"{"type":"call","command":"true"}"#).await;
        let owner = EngineOwner {
            system_start_id: f.id.system_start_id.clone(),
            owner_epoch: "owner".into(),
        };
        let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
        let authority = NativeCallAuthority030::capture(&host, &owner)
            .await
            .unwrap();
        assert!(calls::reserve_call030(&f.pool, &authority, &f.effect)
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM engine_flow030_calls")
            .fetch_one(&f.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let other =
            crate::agsdl_host::route_attestation_test_host030(owner.clone(), "retired-generation");
        let authority = NativeCallAuthority030::capture(&other, &owner)
            .await
            .unwrap();
        let mut tx = f.pool.begin().await.unwrap();
        assert!(authority.owner(&mut tx, &f.id).await.is_err());
    }

    #[tokio::test]
    async fn unknown_call_commit_blocks_all_flow_dispatch_until_exact_readback() {
        let f = Fixture::new(r#"{"type":"call","command":"true"}"#).await;
        let attempt = f.reserve().await;
        let owner = EngineOwner {
            system_start_id: f.id.system_start_id.clone(),
            owner_epoch: "owner".into(),
        };
        let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
        let authority = NativeCallAuthority030::capture(&host, &owner)
            .await
            .unwrap();
        let mut tx = f.pool.begin().await.unwrap();
        let marker =
            crate::db::agsdl_execution::call_protocol030::commit_marker_tx(&mut tx, &attempt)
                .await
                .unwrap();
        tx.commit().await.unwrap();
        authority.call_commits().begin(&marker).unwrap();
        assert!(host.flow030().available(&f.id).is_err());
        assert!(crate::agsdl_host_flow030::claim_expected(
            host.flow030(),
            &host,
            &f.pool,
            &f.id,
            &f.effect.id
        )
        .await
        .is_err());
        assert!(calls::inspect_call_commit030(&f.pool, &authority, &f.id)
            .await
            .unwrap());
        assert!(host.flow030().available(&f.id).is_ok());
    }
}
