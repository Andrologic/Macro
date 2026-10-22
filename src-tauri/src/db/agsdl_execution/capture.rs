//! Private capture is committed beside its snapshot, never reconstructed from the
//! current catalogue when a host resumes a retained system.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CallScope {
    pub step: Vec<String>,
    pub permissions_json: String,
    pub scope_json: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrivateCapture {
    pub registry_json: String,
    #[serde(default)]
    pub card_associations: Vec<super::card_associations::CardAssociation>,
    /// A typed native projection of descriptors, never ProviderConfig or secrets.
    pub native_catalogue_json: String,
    pub implementation_digest: String,
    pub call_scopes: Vec<CallScope>,
}
pub(super) fn validate(
    capture: &PrivateCapture,
    snapshot: &EngineSnapshot,
    policies: &[StepPolicy],
) -> Result<()> {
    validate_json(&capture.registry_json)?;
    validate_json(&capture.native_catalogue_json)?;
    opaque(&capture.implementation_digest)?;
    let registry = super::super::exact_json::value(&capture.registry_json)?;
    require(
        registry.get("version").and_then(|v| v.as_str())
            == Some(snapshot.versions.registry.as_str()),
        "Private registry version differs from snapshot",
    )?;
    let mut steps = BTreeSet::new();
    for scope in &capture.call_scopes {
        require(
            steps.insert(scope.step.clone())
                && policies
                    .iter()
                    .any(|p| p.step == scope.step && p.agent_name.is_none()),
            "Call scope does not name a unique non-Agent step",
        )?;
        validate_json(&scope.permissions_json)?;
        validate_json(&scope.scope_json)?;
    }
    Ok(())
}
pub(crate) async fn read(pool: &SqlitePool, runtime: &EngineOwner) -> Result<PrivateCapture> {
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let stored = load(&mut tx, &runtime.system_start_id).await?;
    owner(&stored.state, runtime, &runtime.system_start_id)?;
    let capture = stored.capture.ok_or_else(|| {
        failure(
            "VERSION_UNAVAILABLE",
            "registry",
            "Private runtime capture is unavailable",
        )
    })?;
    tx.commit().await?;
    Ok(capture)
}
