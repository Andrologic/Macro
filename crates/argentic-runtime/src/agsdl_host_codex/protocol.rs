//! Bounded stdio client. Protocol JSON is metadata; authored JSON travels inside
//! strings so Codex's ordinary JSON decoder cannot round AgSDL numbers.
use super::{
    auth,
    profile::{self, Profile},
};
use crate::persistence::{failure, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

/// A writer handle lets the owned session keep reading steer receipts while
/// the human broker is waiting for admission to send its bounded response.
#[derive(Clone)]
pub(crate) struct ReplySender030(
    std::sync::Arc<tokio::sync::Mutex<ChildStdin>>,
    Option<auth::Guard>,
);
impl ReplySender030 {
    async fn send(&self, message: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(message)?;
        if bytes.len() > 2_000_000 {
            return Err(failure(
                "UNSUPPORTED",
                "input",
                "Codex request exceeds the bounded protocol limit",
            ));
        }
        bytes.push(b'\n');
        let mut stdin = self.0.lock().await;
        stdin.write_all(&bytes).await.map_err(|_| {
            failure(
                "NATIVE_UNCERTAIN",
                "operation",
                "Codex request may have been sent",
            )
        })?;
        stdin.flush().await.map_err(|_| {
            failure(
                "NATIVE_UNCERTAIN",
                "operation",
                "Codex request flush is uncertain",
            )
        })
    }
    pub(crate) async fn answer_request030(&self, id: Value, result: Value) -> Result<()> {
        self.answer_request_checked030(id, || result).await
    }
    /// Re-evaluate cancellation and the grant after waiting for auth refresh.
    /// The existing approval broker still owns admission through physical send.
    pub(crate) async fn answer_request_checked030(
        &self,
        id: Value,
        result: impl FnOnce() -> Value + Send,
    ) -> Result<()> {
        let _auth = match &self.1 {
            Some(auth) => Some(auth.lock_current().await?),
            None => None,
        };
        if !id.is_string() && !id.is_u64() {
            return Err(failure(
                "CORRELATION",
                "protocol",
                "Invalid native request id",
            ));
        }
        self.send(&json!({"id":id,"result":result()})).await
    }
}

pub(crate) struct Client {
    stdin: ReplySender030,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    pending: Vec<Value>,
    pending_bytes: usize,
    frame: Vec<u8>,
    auth_source: Option<PathBuf>,
    expected_account: Option<String>,
    external_auth: Option<auth::Guard>,
    deferred: VecDeque<Value>,
}
impl Client {
    pub fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            stdin: ReplySender030(std::sync::Arc::new(tokio::sync::Mutex::new(stdin)), None),
            stdout: BufReader::new(stdout),
            next_id: 0,
            pending: Vec::new(),
            pending_bytes: 0,
            frame: Vec::new(),
            auth_source: None,
            expected_account: None,
            external_auth: None,
            deferred: VecDeque::new(),
        }
    }
    async fn send(&mut self, message: &Value) -> Result<()> {
        self.stdin.send(message).await
    }
    pub(crate) fn reply_sender030(&self) -> ReplySender030 {
        ReplySender030(self.stdin.0.clone(), self.external_auth.clone())
    }
    pub(crate) fn use_auth_source(
        &mut self,
        source: Option<PathBuf>,
        expected_account: Option<String>,
    ) {
        self.auth_source = source;
        self.expected_account = expected_account;
    }
    pub(crate) async fn next(&mut self) -> Result<Value> {
        if let Some(value) = self.deferred.pop_front() {
            return Ok(value);
        }
        self.wire_next().await
    }
    async fn wire_next(&mut self) -> Result<Value> {
        loop {
            let chunk =
                self.stdout.fill_buf().await.map_err(|_| {
                    failure("NATIVE_UNCERTAIN", "stdio", "Codex protocol read failed")
                })?;
            if chunk.is_empty() {
                return Err(failure(
                    "NATIVE_UNCERTAIN",
                    "stdio",
                    "Codex closed stdio without the required receipt",
                ));
            }
            let end = chunk
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1);
            let count = end.unwrap_or(chunk.len());
            if self.frame.len() + count > 2_000_000 {
                return Err(failure(
                    "NATIVE_UNCERTAIN",
                    "stdio",
                    "Codex protocol frame exceeds the limit",
                ));
            }
            self.frame.extend_from_slice(&chunk[..count]);
            self.stdout.consume(count);
            if end.is_some() {
                break;
            }
        }
        let bytes = std::mem::take(&mut self.frame);
        serde_json::from_slice(&bytes).map_err(|_| {
            failure(
                "NATIVE_UNCERTAIN",
                "stdio",
                "Malformed Codex protocol frame",
            )
        })
    }
    pub(crate) async fn begin_request(&mut self, method: &str, params: Value) -> Result<u64> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        Ok(id)
    }
    pub(crate) async fn answer_request030(&mut self, id: Value, result: Value) -> Result<()> {
        self.reply_sender030().answer_request030(id, result).await
    }
    pub(crate) fn response_value030(&mut self, value: &Value) -> Result<Value> {
        if value.get("error").is_some() {
            return Err(failure(
                "CODEX_REQUEST_FAILED",
                "protocol",
                "Codex rejected the request; no replacement execution was started",
            ));
        }
        value.get("result").cloned().ok_or_else(|| {
            failure(
                "NATIVE_UNCERTAIN",
                "protocol",
                "Codex response has no result",
            )
        })
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.begin_request(method, params).await?;
        self.response(id).await
    }
    pub(crate) async fn notification(&mut self) -> Result<Value> {
        if !self.pending.is_empty() {
            let value = self.pending.remove(0);
            self.pending_bytes = self
                .pending_bytes
                .saturating_sub(serde_json::to_vec(&value)?.len());
            Ok(value)
        } else {
            self.next().await
        }
    }
    async fn response(&mut self, id: u64) -> Result<Value> {
        loop {
            let value = self.next().await?;
            if self.handle_auth_request(&value).await? {
                continue;
            }
            if value.get("method").is_none() && value.get("id").and_then(Value::as_u64) == Some(id)
            {
                return self.response_value030(&value);
            }
            // Server requests could ask for approval or run a client tool. This
            // profile has no client tools and never grants an escalation.
            if value.get("id").is_some() {
                self.send(&json!({"id":value["id"],"error":{"code":-32601,"message":"Client requests are unavailable in Macro's isolated native profile"}})).await?;
                return Err(failure(
                    "CODEX_PROFILE_UNQUALIFIED",
                    "protocol",
                    "Codex requested an unavailable host capability",
                ));
            }
            self.pending_bytes += serde_json::to_vec(&value)?.len();
            if self.pending.len() >= 1000 || self.pending_bytes > 4_000_000 {
                return Err(failure(
                    "NATIVE_UNCERTAIN",
                    "protocol",
                    "Codex notification limit exceeded",
                ));
            }
            self.pending.push(value);
        }
    }
    pub async fn initialize(&mut self) -> Result<()> {
        self.request("initialize", json!({"clientInfo":{"name":"macro_agsdl","version":"1"},"capabilities":{"experimentalApi":true}})).await?;
        self.send(&json!({"method":"initialized"})).await
    }
    pub async fn preflight(&mut self, profile: &Profile, cwd: &str, read_only: bool) -> Result<()> {
        let config = self
            .request(
                "config/read",
                json!({"includeLayers":true,"cwd":profile.bootstrap}),
            )
            .await?;
        profile::verify_layers(&config, profile, std::path::Path::new(cwd), read_only)?;
        let skills = self
            .request(
                "skills/list",
                json!({"cwds":[profile.bootstrap],"forceReload":true}),
            )
            .await?;
        verify_skills(&skills, &profile.bootstrap)?;
        // This local command has no model or account dependency. Initializing
        // app-server alone does not prove that its nested native sandbox works.
        let command = self.request("command/exec",json!({"command":["/usr/bin/true"],"cwd":cwd,"permissionProfile":"macro-agsdl","timeoutMs":5000,"outputBytesCap":4096})).await?;
        if command["exitCode"].as_i64() != Some(0) {
            return Err(failure(
                "CODEX_SANDBOX_UNQUALIFIED",
                "engine",
                "The native Codex tool sandbox could not start inside the isolated host profile",
            ));
        }
        self.bootstrap_auth(profile, std::path::Path::new(cwd), read_only)
            .await
    }
    pub async fn qualify(
        &mut self,
        profile: &Profile,
        cwd: &str,
        read_only: bool,
    ) -> Result<(Vec<String>, String)> {
        let (models, account) = self.qualify_catalogue030(profile, cwd, read_only).await?;
        Ok((
            models
                .iter()
                .filter_map(|model| model["name"].as_str().map(str::to_owned))
                .collect(),
            account,
        ))
    }
    pub async fn qualify_catalogue030(
        &mut self,
        profile: &Profile,
        cwd: &str,
        read_only: bool,
    ) -> Result<(Vec<Value>, String)> {
        self.preflight(profile, cwd, read_only).await?;
        let account = self
            .request("account/read", json!({"refreshToken":false}))
            .await?;
        if account.get("account").is_none_or(Value::is_null) {
            return Err(failure(
                "CODEX_LOGIN_REQUIRED",
                "engine",
                "Connect a test account in the private Codex profile",
            ));
        }
        let account_digest = account_digest(&account)?;
        if let Some(auth) = &self.external_auth {
            let state = auth.lock_current().await?;
            if state.routing_digest.as_deref() != Some(&account_digest) {
                return Err(auth::error("CODEX_AUTH_ACCOUNT_CHANGED"));
            }
        }
        let models = self.request("model/list", json!({"limit":100})).await?;
        Ok((model_observations030(&models)?, account_digest))
    }
}

fn account_digest(account: &Value) -> Result<String> {
    if account["account"]["type"] != "chatgpt" {
        return Err(failure(
            "CODEX_ACCOUNT_UNQUALIFIED",
            "engine",
            "Codex account identity cannot be attested for this profile",
        ));
    }
    let routing = &account["workspaceRouting"];
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&(
            required(routing, "chatgptAccountId")?,
            required(routing, "backendOrigin")?,
            required(routing, "accountRoutingOverride")?
        ))?)
    ))
}

#[cfg(all(test, unix))]
#[path = "auth_tests.rs"]
mod auth_tests;

impl Client {
    pub(crate) async fn check_auth_current(&self) -> Result<()> {
        if let Some(auth) = &self.external_auth {
            drop(auth.lock_current().await?);
        }
        Ok(())
    }
    async fn bootstrap_auth(
        &mut self,
        profile: &Profile,
        workspace: &Path,
        read_only: bool,
    ) -> Result<()> {
        let Some(source) = self.auth_source.clone() else {
            return Ok(());
        };
        if self.external_auth.is_some() {
            return self.check_auth_current().await;
        }
        auth::source_scope(&source, &profile.directory, workspace)?;
        let credential = auth::read(&source).await?;
        let state = auth::Guard(std::sync::Arc::new(tokio::sync::Mutex::new(
            auth::Session {
                source,
                profile: profile.clone(),
                workspace: workspace.to_owned(),
                read_only,
                account_id: credential.account_id.clone(),
                token_fingerprint: credential.fingerprint(),
                routing_digest: None,
                valid: false,
            },
        )));
        self.external_auth = Some(state.clone());
        let result = tokio::time::timeout(auth::TIMEOUT, async {
            let response = self.request("account/login/start", json!({"type":"chatgptAuthTokens", "accessToken":credential.access_token, "chatgptAccountId":credential.account_id})).await
                .map_err(|_| auth::error("CODEX_AUTH_FAILED"))?;
            if response["type"] != "chatgptAuthTokens" { return Err(auth::error("CODEX_AUTH_FAILED")); }
            let mut guard = state.0.lock().await;
            let expected = self.expected_account.clone();
            self.check_external_account(&mut guard, expected.as_deref()).await?;
            guard.valid = true;
            Ok(())
        }).await.map_err(|_| auth::error("CODEX_AUTH_TIMEOUT"))?;
        result
    }

    /// Consume only the auth callback before approval/steer classification. Call
    /// outside cancellable notification selects; the run's outer Stop still
    /// cancels this operation and owns the contained process through drainage.
    pub(crate) async fn handle_auth_request(&mut self, event: &Value) -> Result<bool> {
        if event["method"] != "account/chatgptAuthTokens/refresh" {
            return Ok(false);
        }
        let state = self
            .external_auth
            .clone()
            .ok_or_else(|| auth::error("CODEX_AUTH_FAILED"))?;
        let mut guard = state.0.lock().await;
        let was_valid = guard.valid;
        guard.valid = false;
        let id = &event["id"];
        if !was_valid
            || (!id.is_u64()
                && !id
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 256))
            || event["params"]["reason"] != "unauthorized"
            || event["params"]["previousAccountId"].as_str() != Some(&guard.account_id)
        {
            return Err(auth::error("CODEX_AUTH_ACCOUNT_CHANGED"));
        }
        let credential = auth::read(&guard.source).await?;
        if credential.account_id != guard.account_id {
            return Err(auth::error("CODEX_AUTH_ACCOUNT_CHANGED"));
        }
        if credential.fingerprint() == guard.token_fingerprint {
            return Err(auth::error("CODEX_AUTH_REFRESH_REQUIRED"));
        }
        guard.token_fingerprint = credential.fingerprint();
        let result = tokio::time::timeout(auth::TIMEOUT, async {
            // No generic reply guard here: this operation owns it until the
            // renewed credential's real account/routing is attested below.
            self.send(&json!({"id":id,"result":{"accessToken":credential.access_token,"chatgptAccountId":credential.account_id}})).await?;
            self.check_external_account(&mut guard, None).await
        }).await.map_err(|_| auth::error("CODEX_AUTH_TIMEOUT"))?;
        result?;
        guard.valid = true;
        Ok(true)
    }

    async fn check_external_account(
        &mut self,
        state: &mut auth::Session,
        expected: Option<&str>,
    ) -> Result<()> {
        let account = self
            .auth_response("account/read", json!({"refreshToken":false}))
            .await?;
        let digest = account_digest(&account).map_err(|_| auth::error("CODEX_AUTH_FAILED"))?;
        if account["workspaceRouting"]["chatgptAccountId"].as_str() != Some(&state.account_id)
            || expected.is_some_and(|expected| expected != digest)
            || state
                .routing_digest
                .as_ref()
                .is_some_and(|old| old != &digest)
        {
            return Err(auth::error("CODEX_AUTH_ACCOUNT_CHANGED"));
        }
        // Login/refresh may reload managed configuration. Re-attest the exact
        // existing profile before the auth lock can release a physical reply.
        let profile = &state.profile;
        let config = self
            .auth_response(
                "config/read",
                json!({"includeLayers":true,"cwd":profile.bootstrap}),
            )
            .await?;
        profile::verify_layers(&config, profile, &state.workspace, state.read_only)?;
        let skills = self
            .auth_response(
                "skills/list",
                json!({"cwds":[profile.bootstrap],"forceReload":true}),
            )
            .await?;
        verify_skills(&skills, &profile.bootstrap)?;
        let command = self.auth_response("command/exec",json!({"command":["/usr/bin/true"],"cwd":state.workspace,"permissionProfile":"macro-agsdl","timeoutMs":5000,"outputBytesCap":4096})).await?;
        if command["exitCode"].as_i64() != Some(0) {
            return Err(failure(
                "CODEX_SANDBOX_UNQUALIFIED",
                "engine",
                "The native Codex tool sandbox could not start inside the isolated host profile",
            ));
        }
        auth::no_private_auth(&profile.directory)?;
        if auth::read(&state.source).await?.account_id != state.account_id {
            return Err(auth::error("CODEX_AUTH_ACCOUNT_CHANGED"));
        }
        state.routing_digest = Some(digest);
        Ok(())
    }

    async fn auth_response(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.begin_request(method, params).await?;
        let mut held = Vec::new();
        let mut held_bytes = self.deferred.iter().try_fold(0usize, |size, value| {
            serde_json::to_vec(value).map(|bytes| size + bytes.len())
        })?;
        loop {
            let value = self.wire_next().await?;
            if value.get("method").is_none() && value["id"].as_u64() == Some(id) {
                let result = self
                    .response_value030(&value)
                    .map_err(|_| auth::error("CODEX_AUTH_FAILED"))?;
                self.deferred.extend(held);
                return Ok(result);
            }
            if value["method"] == "account/chatgptAuthTokens/refresh" {
                return Err(auth::error("CODEX_AUTH_REFRESH_REQUIRED"));
            }
            held_bytes += serde_json::to_vec(&value)?.len();
            if self.deferred.len() + held.len() >= 1000 || held_bytes > 4_000_000 {
                return Err(auth::error("CODEX_AUTH_FAILED"));
            }
            held.push(value);
        }
    }
}
fn conclusive_turn(value: &Value, turn: &str) -> Result<bool> {
    if required(value, "id")? != turn {
        return Err(failure(
            "CORRELATION",
            "turn",
            "Codex completed another native turn",
        ));
    }
    match value["status"].as_str() {
        Some("completed") => Ok(false),
        Some("failed" | "interrupted") => Ok(true),
        _ => Err(failure(
            "CORRELATION",
            "turn",
            "Native turn has no conclusive status",
        )),
    }
}

pub(crate) fn required(value: &Value, name: &str) -> Result<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 1_000_000)
        .map(str::to_owned)
        .ok_or_else(|| {
            failure(
                "CORRELATION",
                "protocol",
                "Required Codex response field is missing",
            )
        })
}

fn verify_skills(value: &Value, bootstrap: &std::path::Path) -> Result<()> {
    let Some(entries) = value["data"].as_array() else {
        return Err(failure(
            "CODEX_CONTEXT_UNQUALIFIED",
            "skills",
            "Native skills inventory is absent",
        ));
    };
    if entries.len() != 1
        || entries[0]["cwd"] != json!(bootstrap)
        || entries[0]["skills"]
            .as_array()
            .is_none_or(|skills| !skills.is_empty())
        || entries[0]["errors"]
            .as_array()
            .is_none_or(|errors| !errors.is_empty())
    {
        return Err(failure(
            "CODEX_CONTEXT_UNQUALIFIED",
            "skills",
            "Native skills inventory is incomplete, foreign or failed",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_correlated_conclusive_turns_can_become_terminal() {
        for (status, failed) in [
            ("completed", false),
            ("failed", true),
            ("interrupted", true),
        ] {
            assert_eq!(
                conclusive_turn(&json!({"id":"turn","status":status}), "turn").unwrap(),
                failed
            );
        }
        for value in [
            json!({"id":"foreign","status":"failed"}),
            json!({"id":"turn","status":"inProgress"}),
            json!({"id":"turn"}),
        ] {
            assert_eq!(
                conclusive_turn(&value, "turn").unwrap_err().code,
                "CORRELATION"
            );
        }
    }
    #[test]
    fn skills_inventory_requires_one_complete_error_free_bootstrap_entry() {
        let root = std::path::Path::new("/synthetic/bootstrap");
        let entry = json!({"cwd":root,"skills":[],"errors":[]});
        verify_skills(&json!({"data":[entry.clone()]}), root).unwrap();
        for value in [
            json!({}),
            json!({"data":[]}),
            json!({"data":[entry.clone(),entry.clone()]}),
            json!({"data":[{"cwd":"/foreign","skills":[],"errors":[]}]}),
            json!({"data":[{"cwd":root,"skills":[]}]}),
            json!({"data":[{"cwd":root,"skills":[],"errors":[{"message":"synthetic discovery failure"}]}]}),
            json!({"data":[{"cwd":root,"skills":[{"name":"unobserved"}],"errors":[]}]}),
        ] {
            assert_eq!(
                verify_skills(&value, root).unwrap_err().code,
                "CODEX_CONTEXT_UNQUALIFIED"
            );
        }
    }
}

/// Preserve only model settings advertised by model/list. No effort or default
/// model is inferred from a module or a hard-coded model catalogue.
pub(crate) fn model_observations030(response: &Value) -> Result<Vec<Value>> {
    let refused = || {
        failure(
            "CODEX_MODEL_UNQUALIFIED",
            "/models",
            "Codex model catalogue is incomplete or inconsistent",
        )
    };
    if !response.get("nextCursor").is_none_or(Value::is_null) {
        return Err(refused());
    }
    let mut names = std::collections::BTreeSet::new();
    let mut defaults = 0;
    let models = response["data"].as_array().ok_or_else(refused)?.iter().map(|model| {
        let name = model["model"].as_str().filter(|s| !s.is_empty()).ok_or_else(refused)?;
        if !names.insert(name) { return Err(refused()); }
        let efforts = model["supportedReasoningEfforts"].as_array().ok_or_else(refused)?.iter().map(|entry| {
            entry["reasoningEffort"].as_str().filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(refused)
        }).collect::<Result<Vec<_>>>()?;
        let default = model["defaultReasoningEffort"].as_str().ok_or_else(refused)?;
        if !efforts.iter().any(|effort| effort == default) || efforts.iter().collect::<std::collections::BTreeSet<_>>().len() != efforts.len() { return Err(refused()); }
        let is_default = model["isDefault"].as_bool().ok_or_else(refused)?;
        defaults += usize::from(is_default);
        Ok(json!({"name":name,"efforts":efforts,"defaultEffort":default,"isDefault":is_default}))
    }).collect::<Result<Vec<_>>>()?;
    if models.is_empty() || defaults > 1 {
        return Err(refused());
    }
    Ok(models)
}

#[cfg(test)]
mod catalogue030_tests {
    use super::*;
    #[test]
    fn model_catalogue_keeps_observed_efforts_and_refuses_incomplete_pages() {
        let response = json!({"data":[{"model":"synthetic-model","supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"high"}],"defaultReasoningEffort":"medium","isDefault":true}],"nextCursor":null});
        let models = model_observations030(&response).unwrap();
        assert_eq!(
            models[0],
            json!({"name":"synthetic-model","efforts":["medium","high"],"defaultEffort":"medium","isDefault":true})
        );
        let mut incomplete = response.clone();
        incomplete["nextCursor"] = json!("next");
        assert!(model_observations030(&incomplete).is_err());
        let mut invalid = response.clone();
        invalid["data"][0]["defaultReasoningEffort"] = json!("invented");
        assert!(model_observations030(&invalid).is_err());
        let mut duplicate = response.clone();
        duplicate["data"]
            .as_array_mut()
            .unwrap()
            .push(response["data"][0].clone());
        assert!(model_observations030(&duplicate).is_err());
    }
}
