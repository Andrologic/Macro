//! Bounded stdio client. Protocol JSON is metadata; authored JSON travels inside
//! strings so Codex's ordinary JSON decoder cannot round AgSDL numbers.
use super::profile::{self, Profile};
use crate::db::agsdl_execution::{
    dto::*,
    failure,
    native_operations::{self, NativeOperation},
    responses::{self, Emission},
    Result,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

pub(crate) struct Client {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    pending: Vec<Value>,
    pending_bytes: usize,
}
impl Client {
    pub fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
            pending: Vec::new(),
            pending_bytes: 0,
        }
    }
    async fn send(&mut self, message: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(message)?;
        if bytes.len() > 2_000_000 {
            return Err(failure(
                "UNSUPPORTED",
                "input",
                "Codex request exceeds the bounded protocol limit",
            ));
        }
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await.map_err(|_| {
            failure(
                "NATIVE_UNCERTAIN",
                "operation",
                "Codex request may have been sent",
            )
        })?;
        self.stdin.flush().await.map_err(|_| {
            failure(
                "NATIVE_UNCERTAIN",
                "operation",
                "Codex request flush is uncertain",
            )
        })
    }
    async fn next(&mut self) -> Result<Value> {
        let mut bytes = Vec::new();
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
            if bytes.len() + count > 2_000_000 {
                return Err(failure(
                    "NATIVE_UNCERTAIN",
                    "stdio",
                    "Codex protocol frame exceeds the limit",
                ));
            }
            bytes.extend_from_slice(&chunk[..count]);
            self.stdout.consume(count);
            if end.is_some() {
                break;
            }
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    async fn begin_request(&mut self, method: &str, params: Value) -> Result<u64> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        Ok(id)
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.begin_request(method, params).await?;
        self.response(id).await
    }
    async fn response(&mut self, id: u64) -> Result<Value> {
        loop {
            let value = self.next().await?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if value.get("error").is_some() {
                    return Err(failure(
                        "CODEX_REQUEST_FAILED",
                        "protocol",
                        "Codex rejected the request; no replacement execution was started",
                    ));
                }
                return value.get("result").cloned().ok_or_else(|| {
                    failure(
                        "NATIVE_UNCERTAIN",
                        "protocol",
                        "Codex response has no result",
                    )
                });
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
        Ok(())
    }
    pub async fn qualify(
        &mut self,
        profile: &Profile,
        cwd: &str,
        read_only: bool,
    ) -> Result<(Vec<String>, String)> {
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
        let routing = &account["workspaceRouting"];
        if account["account"]["type"] != "chatgpt" {
            return Err(failure(
                "CODEX_ACCOUNT_UNQUALIFIED",
                "engine",
                "Codex account identity cannot be attested for this profile",
            ));
        }
        let account_digest = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&(
                required(routing, "chatgptAccountId")?,
                required(routing, "backendOrigin")?,
                required(routing, "accountRoutingOverride")?
            ))?)
        );
        let models = self.request("model/list", json!({"limit":100})).await?;
        if !models.get("nextCursor").is_none_or(Value::is_null) {
            return Err(failure(
                "CODEX_MODEL_UNQUALIFIED",
                "engine",
                "Codex model catalogue requires pagination",
            ));
        }
        Ok((
            models["data"]
                .as_array()
                .ok_or_else(|| {
                    failure(
                        "CODEX_MODEL_UNQUALIFIED",
                        "engine",
                        "Codex model catalogue is unavailable",
                    )
                })?
                .iter()
                .filter_map(|model| {
                    model
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect(),
            account_digest,
        ))
    }
    pub async fn operation(
        &mut self,
        pool: &SqlitePool,
        operation: NativeOperation,
        params: Value,
        gate: &std::sync::Arc<tokio::sync::Mutex<()>>,
    ) -> Result<Value> {
        let _guard = gate.lock().await;
        native_operations::admit(pool, &operation).await?;
        let id = self.begin_request(&operation.method, params).await?;
        drop(_guard);
        let response = self.response(id).await?;
        let references = match operation.method.as_str() {
            "thread/start" | "thread/resume" => {
                json!({"threadId":required(&response["thread"], "id")?,"turnId":null})
            }
            "turn/start" => {
                json!({"threadId":required(&serde_json::from_str::<Value>(&operation.request_json)?, "threadId")?,"turnId":required(&response["turn"], "id")?})
            }
            _ => {
                return Err(failure(
                    "UNSUPPORTED",
                    "operation",
                    "Unknown Codex operation",
                ))
            }
        };
        native_operations::received(pool, &operation, &references.to_string()).await?;
        Ok(response)
    }
    pub async fn collect(
        &mut self,
        pool: &SqlitePool,
        context: &EngineContext,
        attempt: &str,
        thread: &str,
        turn: &str,
        publication: bool,
    ) -> Result<bool> {
        let mut sequence = 0;
        self.pending_bytes = 0;
        let mut events: std::collections::VecDeque<_> = std::mem::take(&mut self.pending).into();
        loop {
            let event = match events.pop_front() {
                Some(event) => event,
                None => self.next().await?,
            };
            if event.get("id").is_some() {
                return Err(failure(
                    "CODEX_PROFILE_UNQUALIFIED",
                    "protocol",
                    "Unexpected Codex server request",
                ));
            }
            let method = event["method"].as_str().unwrap_or("");
            let params = &event["params"];
            if ["item/completed", "turn/completed"].contains(&method) {
                if required(params, "threadId")? != thread
                    || (method == "item/completed" && required(params, "turnId")? != turn)
                {
                    return Err(failure(
                        "CORRELATION",
                        "response",
                        "Codex emission belongs to another thread or turn",
                    ));
                }
            }
            if method == "item/completed" && params["item"]["type"] == "agentMessage" {
                let item = &params["item"];
                let text = required(item, "text")?;
                let (kind, body) = if publication && item["phase"] == "final_answer" {
                    match serde_json::from_str::<Value>(&text).ok().and_then(|value| {
                        value
                            .get("publicationJson")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    }) {
                        Some(raw) => ("publication", json!({"rawArguments":raw})),
                        None => ("rejectedPublication", json!({"rawArguments":text})),
                    }
                } else {
                    ("message", json!({"textParts":[text]}))
                };
                sequence += 1;
                responses::append(
                    pool,
                    Emission {
                        context: context.clone(),
                        provider_attempt_id: attempt.into(),
                        sequence: sequence.to_string(),
                        identity: format!("{attempt}:{}", required(item, "id")?),
                        kind: kind.into(),
                        body_json: body.to_string(),
                    },
                )
                .await?;
            }
            if method == "turn/completed" {
                return conclusive_turn(&params["turn"], turn);
            }
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
