//! Test-only access to the same resolvers used by the runtime, without connections.
use super::*;
use rmcp::transport::auth::{CredentialStore, StoredCredentials};
use std::collections::HashMap;

pub(crate) async fn qualification_backup_consumers(context: &str, attached: bool) {
    let env = HashMap::from([(
        "API_TOKEN".into(),
        "macro-secret://mcp-env/synthetic_server/API_TOKEN".into(),
    )]);
    let server = McpServerDto {
        id: "synthetic_server".into(),
        name: "Synthetic".into(),
        transport: Some(McpTransportDto::Stdio {
            command: "unused".into(),
            args: vec![],
            env,
        }),
        config: Some(serde_json::json!({"enabled":true})),
    };
    let resolved = stdio::resolve_stdio_transport(&server);
    if attached {
        assert_eq!(
            resolved.unwrap().2["API_TOKEN"],
            "synthetic-secret-mcp-env:synthetic_server:API_TOKEN"
        );
    } else {
        assert!(resolved.is_err());
    }
    let header = runtime_connector::qualification_header(
        "synthetic_server",
        "Authorization",
        "macro-secret://mcp-env/synthetic_server/Authorization",
    );
    if attached {
        assert_eq!(
            header.unwrap(),
            "synthetic-secret-mcp-env:synthetic_server:Authorization"
        );
    } else {
        assert!(header.is_err());
    }
    let definition:crate::config::McpServerDefinition = serde_json::from_value(serde_json::json!({
        "enabled":true,"transport":{"type":"stdio","command":"unused"},
        "authorization":{"type":"oauth","client_id":"synthetic-client","client_secret_ref":"macro-secret://mcp-oauth-client/synthetic_server","scopes":["synthetic"]}
    })).unwrap();
    let client = runtime_connector::resolve_oauth_settings("synthetic_server", &definition);
    if attached {
        assert_eq!(
            client.unwrap().unwrap().client_secret.as_deref(),
            Some("synthetic-secret-mcp-oauth-client:synthetic_server")
        );
    } else {
        assert!(client.is_err());
    }
    let key = McpRuntimeKey {
        server_id: "synthetic_server".into(),
        project_id: Some(context.into()),
        project_ids: vec![context.into()],
        config_generation: 1,
    };
    let id = oauth::oauth_credential_secret_id(&key, "https://resource.invalid/mcp");
    let store = oauth::McpOAuthCredentialStore::new(id);
    let loaded = store.load().await.unwrap();
    assert_eq!(loaded.is_some(), attached);
    if let Some(credentials) = loaded {
        assert_eq!(
            serde_json::to_value(&credentials).unwrap()["token_response"]["access_token"],
            "synthetic-oauth-access"
        );
        store.save(credentials.clone()).await.unwrap();
        assert_eq!(
            serde_json::to_value(store.load().await.unwrap()).unwrap(),
            serde_json::to_value(Some(credentials)).unwrap()
        );
    } else {
        // Exercise save/load/clear on a disjoint synthetic scope after observing absence.
        let probe = oauth::McpOAuthCredentialStore::new("mcp-oauth:qualification-probe".into());
        let value: StoredCredentials = serde_json::from_value(
            serde_json::json!({"client_id":"synthetic-client","token_response":null}),
        )
        .unwrap();
        probe.save(value).await.unwrap();
        assert!(probe.load().await.unwrap().is_some());
        probe.clear().await.unwrap();
        assert!(probe.load().await.unwrap().is_none());
    }
}
