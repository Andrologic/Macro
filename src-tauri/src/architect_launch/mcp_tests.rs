use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::{net::SocketAddr, sync::Mutex};

const TOKEN: &str = "fixture-archive-issues-credential";
const CLIENT_KEY: &str = "fixture-archive-client-credential";

struct Peer {
    address: SocketAddr,
    calls: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Peer {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/issues", post(reply))
            .with_state(calls.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await });
        Self {
            address,
            calls,
            task,
        }
    }

    fn endpoint(&self) -> String {
        format!("http://{}/issues?version=1", self.address)
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn reply(
    State(calls): State<Arc<Mutex<Vec<Value>>>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let raw = request.to_string();
    assert!(!raw.contains(TOKEN) && !raw.contains(CLIENT_KEY));
    if !headers
        .get("authorization")
        .is_some_and(|v| v == &format!("Bearer {TOKEN}"))
        || !headers.get("client_key").is_some_and(|v| v == CLIENT_KEY)
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let result = match request["method"].as_str() {
        Some("initialize") => json!({
            "protocolVersion":"2025-03-26", "capabilities":{"tools":{}},
            "serverInfo":{"name":"fixture","version":"1"},
        }),
        Some("notifications/initialized") => return StatusCode::ACCEPTED.into_response(),
        Some("tools/list") => {
            let tools = ["lookup", "read", "remove"].map(|name| json!({
                "name":name, "description":"Synthetic fixture tool", "inputSchema":{"type":"object"},
            }));
            json!({"tools":tools})
        }
        Some("tools/call") => {
            calls.lock().unwrap().push(request["params"].clone());
            json!({"content":[],"structuredContent":{"issue":"fixture"}})
        }
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
}

fn write_json(root: &Path, path: &str, value: Value) {
    fs::write(root.join(path), value.to_string()).unwrap();
}

fn loopback_review_project(data: &Path, endpoint: &str, direct: bool) -> tempfile::TempDir {
    let project = review_project(data);
    let root = project.path();
    let mut agent: Value =
        serde_json::from_slice(&fs::read(root.join("agents/reviewer/agent.json")).unwrap())
            .unwrap();
    agent["permissions"] = json!({
        "preset":"read-only",
        "rules":[
            {"action":"mcp","match":"issues/read","effect":"allow"},
            {"action":"mcp","match":"issues/lookup","effect":"ask"},
            {"action":"mcp","match":"issues/remove","effect":"deny"},
        ],
    });
    write_json(root, "agents/reviewer/agent.json", agent);
    write_json(root, "mcp/issues.json", json!({"url":endpoint}));
    write_json(
        root,
        "secrets/requirements.json",
        json!({"issues":["ISSUES_TOKEN","CLIENT_KEY"]}),
    );
    if direct {
        write_json(
            root,
            "flows/review.json",
            json!({
                "entry":"review","steps":{
                    "review":{"type":"agent","agent":"reviewer","next":{"approve":"read"}},
                    "read":{"type":"call","mcp":{"server":"issues","tool":"read"},
                        "arguments":{"number":{"value":9007199254740993u64}}},
                },
            }),
        );
    } else {
        fs::write(root.join("agents/reviewer/instructions.md"),
            "Call the issues lookup tool with an object containing number 7, then finish the review.").unwrap();
    }
    project
}

fn remote_settings() -> mcp::RemoteSettings {
    mcp::RemoteSettings {
        delivery: BTreeMap::from([
            ("ISSUES_TOKEN".into(), mcp::SecretDelivery::Bearer),
            (
                "CLIENT_KEY".into(),
                mcp::SecretDelivery::Header {
                    name: "Client_Key".into(),
                },
            ),
        ]),
        address_scope: None,
    }
}

fn remote_configuration(url: &str) -> LaunchConfiguration {
    LaunchConfiguration {
        remote_mcp: BTreeMap::from([(
            "issues".into(),
            BTreeMap::from([(
                url::Url::parse(url).unwrap().as_str().into(),
                remote_settings(),
            )]),
        )]),
        ..Default::default()
    }
}

fn remote_request(
    version: VersionKey,
    consent: Option<String>,
    configuration: LaunchConfiguration,
) -> start::LaunchRequest {
    start::LaunchRequest {
        configuration,
        ..request(version, consent)
    }
}

async fn store_credentials(
    manager: &ConfigManager,
    pool: &SqlitePool,
    data: &Path,
    version: &VersionKey,
    configuration: &LaunchConfiguration,
) {
    for (name, value) in [("ISSUES_TOKEN", TOKEN), ("CLIENT_KEY", CLIENT_KEY)] {
        set_secret(
            manager,
            pool,
            data,
            version.clone(),
            "issues",
            name,
            value,
            Some(configuration.clone()),
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn archive_review_project_remote_headers_consent_and_current_tool_policy() {
    let _guard = crate::secrets::lock_test_store();
    let data = tempfile::tempdir().unwrap();
    crate::secrets::init(data.path()).unwrap();
    let peer = Peer::start().await;
    let endpoint = peer.endpoint();
    let project = loopback_review_project(data.path(), &endpoint, true);
    let (pool, version) = import_archive_fixture(data.path(), project.path()).await;
    let manager = manager_for_test(data.path()).await;
    set_host_ceiling(&manager, json!("workspace")).await;
    observe_fixture(&manager);

    let unconfigured = preview(&manager, &pool, data.path(), version.clone(), None).await;
    assert!(unconfigured
        .blockers
        .iter()
        .any(|b| b.code == "mcpSecretDeliveryRequired"));
    assert!(unconfigured.secrets.is_empty());
    let configuration = remote_configuration(&endpoint);
    let prepared = preview(
        &manager,
        &pool,
        data.path(),
        version.clone(),
        Some(configuration.clone()),
    )
    .await;
    assert!(
        prepared.blockers.is_empty(),
        "{}",
        serde_json::to_string(&prepared.blockers).unwrap()
    );
    assert_eq!(prepared.secrets.len(), 2);
    assert!(prepared.secrets.iter().all(|secret| !secret.stored));
    let projection = serde_json::to_value(&prepared).unwrap();
    assert_eq!(
        projection["agentMcp"]["reviewer"]["issues"]["tools"],
        json!({
            "lookup":"ask", "read":"allow", "remove":"deny",
        })
    );
    assert_eq!(projection["remoteMcp"]["issues"]["url"], endpoint);
    assert_eq!(
        projection["remoteMcp"]["issues"]["delivery"],
        json!({
            "ISSUES_TOKEN":"Authorization: Bearer", "CLIENT_KEY":"client_key",
        })
    );

    let host = HostState::new();
    let agent = Arc::new(ScriptedAgent::default());
    agent.install(&host);
    let token = prepared.consent_token.unwrap();
    let launch = |consent| {
        start::launch(
            runtime(&host, &manager, &pool, data.path()),
            remote_request(version.clone(), consent, configuration.clone()),
        )
    };
    assert_eq!(launch(None).await.err().unwrap().code, "CONSENT_REQUIRED");
    assert_eq!(
        launch(Some(token.clone())).await.err().unwrap().code,
        "MCP_SECRETS_UNAVAILABLE"
    );
    assert!(peer.calls.lock().unwrap().is_empty());
    assert!(set_secret(
        &manager,
        &pool,
        data.path(),
        version.clone(),
        "issues",
        "ISSUES_TOKEN",
        "invalid\nvalue",
        Some(configuration.clone()),
    )
    .await
    .is_err());
    store_credentials(&manager, &pool, data.path(), &version, &configuration).await;
    let prepared = preview(
        &manager,
        &pool,
        data.path(),
        version.clone(),
        Some(configuration.clone()),
    )
    .await;
    assert!(prepared.secrets.iter().all(|secret| secret.stored));
    let receipt = launch(Some(token)).await.unwrap();
    let id = &receipt.capture.identity.system_start_id;
    tokio::time::timeout(Duration::from_secs(10), agent.wait(&host, id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        *peer.calls.lock().unwrap(),
        [json!({"name":"read","arguments":{"number":9007199254740993u64}})]
    );
    let run = host
        .runtime_projection(
            &pool,
            api::RuntimeProjectionQuery030 {
                system_start_id: id.clone(),
                source: receipt.capture.source.clone(),
                snapshot_id: None,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(run.verdict.as_deref(), Some("succeeded"));
    let consent: String =
        sqlx::query_scalar("SELECT permissions_json FROM architect_launch_consents")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(serde_json::from_str::<Permissions>(&consent)
        .unwrap()
        .mcp
        .contains_key("issues"));
    for filename in ["launch.db", "launch.db-wal"] {
        if let Ok(bytes) = fs::read(data.path().join(filename)) {
            for secret in [TOKEN, CLIENT_KEY] {
                assert!(!bytes
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes()));
            }
        }
    }
    assert!(preview(&manager, &pool, data.path(), version.clone(), None)
        .await
        .consent_token
        .is_none());

    let mut different_delivery = configuration.clone();
    different_delivery
        .remote_mcp
        .get_mut("issues")
        .unwrap()
        .get_mut(&endpoint)
        .unwrap()
        .delivery
        .insert(
            "CLIENT_KEY".into(),
            mcp::SecretDelivery::Header {
                name: "X-Client-Key".into(),
            },
        );
    let delivery_changed = preview(
        &manager,
        &pool,
        data.path(),
        version.clone(),
        Some(different_delivery),
    )
    .await;
    assert!(delivery_changed.consent_token.is_some());
    assert!(delivery_changed
        .secrets
        .iter()
        .any(|secret| secret.name == "CLIENT_KEY" && !secret.stored));
    assert!(delivery_changed
        .secrets
        .iter()
        .any(|secret| secret.name == "ISSUES_TOKEN" && secret.stored));

    // The broker supplies the same native request after a person's decision.
    // Macro rechecks the actual folder and the current grant before handoff.
    let action = json!({"nativeRequest":{"method":"mcp/tool/requestApproval","params":{
        "server":"issues","tool":"lookup","arguments":{"number":7},
    }}});
    let policy = crate::agsdl_host_action_approval030::ArchiveActionPolicy030 {
        pool: pool.clone(),
        config: manager.clone(),
    };
    assert!(
        policy
            .lock_decision(&receipt.capture, &action)
            .await
            .unwrap()
            .0
    );

    let storage = Storage::new(data.path());
    let draft = storage
        .open_draft_project(&pool, &version.blueprint_id)
        .await
        .unwrap();
    let changed_endpoint = endpoint.replace("version=1", "version=2");
    let patch = serde_json::from_value(json!({"files":[{"kind":"write","path":"mcp/issues.json",
        "text":json!({"url":changed_endpoint}).to_string()}]}))
    .unwrap();
    let edited = storage
        .edit_project(
            &pool,
            &version.blueprint_id,
            draft.project.revision,
            patch,
            true,
        )
        .await
        .unwrap();
    storage
        .freeze(
            &pool,
            version.blueprint_id.clone(),
            edited.revision,
            None,
            None,
        )
        .await
        .unwrap();
    let changed = preview(
        &manager,
        &pool,
        data.path(),
        VersionKey {
            number: 2,
            ..version
        },
        Some(remote_configuration(&changed_endpoint)),
    )
    .await;
    assert!(changed.consent_token.is_some());
    assert!(changed.secrets.iter().all(|secret| secret.stored));

    set_host_ceiling(
        &manager,
        json!({
            "preset":"workspace","rules":[{"action":"mcp","match":"iss*/lookup","effect":"deny"}],
        }),
    )
    .await;
    assert!(
        !policy
            .lock_decision(&receipt.capture, &action)
            .await
            .unwrap()
            .0
    );
    remove_test_snapshot(&pool, &manager, id).await;
}

#[tokio::test]
async fn remote_credential_rotation_is_shared_only_by_origin_and_delivery() {
    let _guard = crate::secrets::lock_test_store();
    let data = tempfile::tempdir().unwrap();
    crate::secrets::init(data.path()).unwrap();
    let (pool, version) = archive_fixture(data.path(), manifest()).await;
    let input = VersionInput::read(&pool, &Storage::new(data.path()), version)
        .await
        .unwrap();
    let names = vec!["ISSUES_TOKEN".to_owned()];
    let launch = |url| mcp::LaunchMcp {
        secrets: BTreeMap::from([("issues".into(), names.clone())]),
        remote: BTreeMap::from([(
            "issues".into(),
            mcp::RemoteGrant::new(url::Url::parse(url).unwrap(), &names, &remote_settings())
                .unwrap(),
        )]),
        ..Default::default()
    };
    let first = launch("https://example.invalid/mcp?tenant=one");
    let same_origin = launch("https://EXAMPLE.invalid:443/other-path");
    let moved = launch("https://example.invalid:8443/mcp");
    let key = |launch: &mcp::LaunchMcp| {
        input
            .secret_id("issues", &names[0], launch.remote.get("issues"))
            .unwrap()
    };
    let source = input.source_revision();
    let first_provider = secret_provider(&input, &first).unwrap();

    archive_mcp::set(&key(&first), "original").unwrap();
    assert!(!secret_requirements(&input, &moved).unwrap()[0].stored);
    archive_mcp::set(&key(&moved), "new-server").unwrap();
    assert_eq!(
        first_provider(&source, "issues", &names).unwrap()[&names[0]],
        "original"
    );
    archive_mcp::set(&key(&same_origin), "rotated").unwrap();
    assert_eq!(
        first_provider(&source, "issues", &names).unwrap()[&names[0]],
        "rotated"
    );
    assert_eq!(
        secret_provider(&input, &moved).unwrap()(&source, "issues", &names).unwrap()[&names[0]],
        "new-server"
    );
}

#[test]
fn remote_delivery_rejects_missing_reserved_and_duplicate_headers() {
    use mcp::SecretDelivery::{Bearer, Header};
    let url = url::Url::parse("https://example.invalid/mcp").unwrap();
    let names = vec!["FIRST_TOKEN".to_owned(), "SECOND_TOKEN".to_owned()];
    let mut settings = mcp::RemoteSettings::default();
    settings.delivery.insert(names[0].clone(), Bearer);
    assert_eq!(
        mcp::RemoteGrant::new(url.clone(), &names, &settings).err(),
        Some("mcpSecretDeliveryRequired")
    );
    for (delivery, error) in [
        (Bearer, "mcpSecretHeaderConflict"),
        (
            Header {
                name: "AUTHORIZATION".into(),
            },
            "mcpSecretHeaderConflict",
        ),
        (
            Header {
                name: "Mcp-Session-Id".into(),
            },
            "mcpSecretHeader",
        ),
        (
            Header {
                name: "invalid header".into(),
            },
            "mcpSecretHeader",
        ),
    ] {
        settings.delivery.insert(names[1].clone(), delivery);
        assert_eq!(
            mcp::RemoteGrant::new(url.clone(), &names, &settings).err(),
            Some(error)
        );
    }
    settings.delivery.insert(
        names[1].clone(),
        Header {
            name: "X-Second-Token".into(),
        },
    );
    assert!(mcp::RemoteGrant::new(url, &names, &settings).is_ok());
}

#[tokio::test]
async fn endpoint_consent_matches_exact_revision_destination_and_secret_names() {
    let data = tempfile::tempdir().unwrap();
    let (pool, version) = archive_fixture(data.path(), manifest()).await;
    let input = VersionInput::read(&pool, &Storage::new(data.path()), version)
        .await
        .unwrap();
    let source = input.source_revision();
    let names = vec!["ISSUES_TOKEN".to_owned()];
    let url = url::Url::parse("https://example.invalid/mcp?tenant=one").unwrap();
    let authorize = mcp::authorizer(
        source.clone(),
        BTreeMap::from([(
            "issues".to_owned(),
            mcp::RemoteGrant::new(url.clone(), &names, &remote_settings()).unwrap(),
        )]),
    );
    let public = ["1.1.1.1:443".parse().unwrap()];
    assert!(authorize(&source, "issues", &url, &public, &names).is_some());
    let changed = url.join("/mcp?tenant=two").unwrap();
    assert!(authorize(&source, "issues", &changed, &public, &names).is_none());
    assert!(authorize(&source, "other", &url, &public, &names).is_none());
    assert!(authorize(&source, "issues", &url, &public, &[]).is_none());
    let mut other = source.clone();
    other.revision = "2".into();
    assert!(authorize(&other, "issues", &url, &public, &names).is_none());
    let mixed = [public[0], "127.0.0.1:443".parse().unwrap()];
    assert!(authorize(&source, "issues", &url, &mixed, &names).is_none());
}

#[tokio::test]
async fn remote_mcp_scope_checks_every_pinned_address_and_changes_consent() {
    use mcp::AddressScope::{PrivateNetwork, ThisComputer};
    let data = tempfile::tempdir().unwrap();
    let endpoint = "https://mcp.intranet.invalid/issues";
    let project = loopback_review_project(data.path(), endpoint, false);
    let (pool, version) = import_archive_fixture(data.path(), project.path()).await;
    let input = VersionInput::read(&pool, &Storage::new(data.path()), version)
        .await
        .unwrap();
    let preview = input.preview().unwrap();
    let names = &preview.mcp_servers["issues"].required_secrets;
    let url = url::Url::parse(endpoint).unwrap();
    let source = input.source_revision();
    let mut configuration = remote_configuration(endpoint);
    let prepare = |configuration: &LaunchConfiguration| {
        let (blockers, launch_mcp) = requirements(
            &input,
            &preview,
            &json!({"agsdlHostPermissions":"workspace"}),
            &serde_json::from_value(json!("workspace")).unwrap(),
            data.path(),
            LOCAL_MCP_SUPPORTED,
            configuration,
        )
        .unwrap();
        assert!(blockers.is_empty());
        let consent = permissions(&input, &preview, &launch_mcp).unwrap();
        (consent, mcp::authorizer(source.clone(), launch_mcp.remote))
    };
    let (public_consent, public) = prepare(&configuration);
    configuration
        .remote_mcp
        .get_mut("issues")
        .unwrap()
        .get_mut(endpoint)
        .unwrap()
        .address_scope = Some(PrivateNetwork);
    let (private_consent, private) = prepare(&configuration);
    assert!(!public_consent.covers(&private_consent));
    assert!(!private_consent.covers(&public_consent));

    let lan = "192.168.1.10:443".parse().unwrap();
    let mapped_lan = "[::ffff:192.168.1.11]:443".parse().unwrap();
    let internet = "8.8.8.8:443".parse().unwrap();
    assert!(public(&source, "issues", &url, &[internet], names).is_some());
    assert!(public(&source, "issues", &url, &[lan], names).is_none());
    assert!(private(&source, "issues", &url, &[lan, mapped_lan], names).is_some());
    for rejected in [
        internet,
        "127.0.0.1:443".parse().unwrap(),
        "[::ffff:0.0.0.0]:443".parse().unwrap(),
        "224.0.0.1:443".parse().unwrap(),
        "192.168.1.10:80".parse().unwrap(),
    ] {
        assert!(private(&source, "issues", &url, &[lan, rejected], names).is_none());
    }

    let mut settings = mcp::RemoteSettings::default();
    let ip = url::Url::parse("https://[::ffff:192.168.1.10]/mcp").unwrap();
    assert_eq!(
        mcp::RemoteGrant::new(ip.clone(), &[], &settings).err(),
        Some("mcpPrivateNetworkRequired")
    );
    settings.address_scope = Some(PrivateNetwork);
    assert!(mcp::RemoteGrant::new(ip, &[], &settings).is_ok());
    settings.address_scope = Some(ThisComputer);
    for invalid in [
        "https://[::ffff:0.0.0.0]",
        "https://[ff02::1]",
        "https://255.255.255.255",
    ] {
        assert_eq!(
            mcp::RemoteGrant::new(invalid.parse().unwrap(), &[], &settings).err(),
            Some("mcpAddressUnsupported")
        );
    }
}

#[tokio::test]
async fn equipping_another_agent_requires_new_consent_for_the_same_endpoint() {
    let data = tempfile::tempdir().unwrap();
    let mut doc = manifest();
    doc["agents"]["worker"]["permissions"] = json!("workspace");
    doc["agents"]["worker"]["mcpServers"] = json!(["issues"]);
    doc["agents"]["reviewer"] = json!({"harness":"codex","permissions":"workspace"});
    doc["mcpServers"] = json!({"issues":{"url":"https://example.invalid/issues"}});
    doc["flow"]["steps"]["run"]["next"] = json!("review");
    doc["flow"]["steps"]["review"] = json!({"type":"agent","agent":"reviewer"});
    let (pool, version) = archive_fixture(data.path(), doc).await;
    let input = VersionInput::read(&pool, &Storage::new(data.path()), version)
        .await
        .unwrap();
    let mut preview = input.preview().unwrap();
    let summary = |preview: &ImportPreview| {
        let (blockers, mcp) = requirements(
            &input,
            preview,
            &json!({"agsdlHostPermissions":"workspace"}),
            &crate::agsdl_permissions::RequestedPermissions::Preset(
                crate::agsdl_permissions::Preset::Workspace,
            ),
            data.path(),
            LOCAL_MCP_SUPPORTED,
            &LaunchConfiguration::default(),
        )
        .unwrap();
        assert!(blockers.is_empty());
        permissions(&input, preview, &mcp).unwrap()
    };
    let first = summary(&preview);
    preview
        .agents
        .get_mut("reviewer")
        .unwrap()
        .mcp_servers
        .push("issues".into());
    let expanded = summary(&preview);
    assert_eq!(first.mcp, expanded.mcp);
    assert!(expanded.covers(&first));
    assert!(!first.covers(&expanded));
}

#[tokio::test]
async fn archive_equipment_denies_every_tool_before_discovery() {
    let data = tempfile::tempdir().unwrap();
    let project = loopback_review_project(data.path(), "https://example.invalid/issues", false);
    let (pool, version) = import_archive_fixture(data.path(), project.path()).await;
    let manager = manager_for_test(data.path()).await;
    observe_fixture(&manager);
    set_host_ceiling(
        &manager,
        json!({
            "preset":"workspace","rules":[{"action":"mcp","match":"iss*/**","effect":"deny"}],
        }),
    )
    .await;
    let prepared = preview(&manager, &pool, data.path(), version, None).await;
    assert!(prepared.blockers.is_empty());
    assert!(!prepared.agent_mcp["reviewer"]["issues"].equipped);
    assert!(prepared.remote_mcp.is_empty());
    assert!(prepared.secrets.is_empty());
}

#[tokio::test]
async fn invalid_endpoint_blocks_equipment_or_direct_calls_but_not_excluded_equipment() {
    for (direct, denied, blocked) in [
        (false, true, false),
        (false, false, true),
        (true, true, true),
    ] {
        let data = tempfile::tempdir().unwrap();
        let project = loopback_review_project(data.path(), "http://example.invalid/issues", direct);
        let (pool, version) = import_archive_fixture(data.path(), project.path()).await;
        let input = VersionInput::read(&pool, &Storage::new(data.path()), version)
            .await
            .unwrap();
        let ceiling = serde_json::from_value(if denied {
            json!({"preset":"workspace","rules":[{"action":"mcp","match":"issues","effect":"deny"}]})
        } else {
            json!("workspace")
        })
        .unwrap();
        let (blockers, mcp) = requirements(
            &input,
            &input.preview().unwrap(),
            &json!({"agsdlHostPermissions":"workspace"}),
            &ceiling,
            data.path(),
            LOCAL_MCP_SUPPORTED,
            &LaunchConfiguration::default(),
        )
        .unwrap();
        assert_eq!(
            blockers.iter().any(|b| b.code == "mcpEndpointUnsupported"),
            blocked
        );
        assert!(mcp.remote.is_empty());
        assert!(mcp.secrets.is_empty());
    }
}

#[cfg(all(target_arch = "aarch64", any(target_os = "macos", target_os = "linux")))]
#[tokio::test]
#[ignore = "requires a disposable Macro data directory with a qualified, logged-in Codex profile"]
async fn real_codex_asks_before_dispatching_archive_mcp_tool() {
    use argentic_runtime::persistence::public030::HumanScope030;

    let _guard = crate::secrets::lock_test_store();
    let root = PathBuf::from(
        std::env::var_os("MACRO_ARCHIVE_SMOKE_DATA").expect("set disposable Macro data directory"),
    );
    let data = tempfile::tempdir_in(&root).unwrap();
    crate::secrets::init(data.path()).unwrap();
    let peer = Peer::start().await;
    let project = loopback_review_project(data.path(), &peer.endpoint(), false);
    let (pool, version) = import_archive_fixture(data.path(), project.path()).await;
    let manager = manager_for_test(&root).await;
    set_host_ceiling(&manager, json!("workspace")).await;
    let configuration = remote_configuration(&peer.endpoint());
    store_credentials(&manager, &pool, data.path(), &version, &configuration).await;

    let prepared = preview(
        &manager,
        &pool,
        data.path(),
        version.clone(),
        Some(configuration.clone()),
    )
    .await;
    assert!(
        prepared.blockers.is_empty(),
        "{}",
        serde_json::to_string(&prepared.blockers).unwrap()
    );
    let host = HostState::new();
    let receipt = start::launch(
        runtime(&host, &manager, &pool, data.path()),
        remote_request(version, prepared.consent_token, configuration),
    )
    .await
    .unwrap();
    let scope = HumanScope030 {
        system_start_id: receipt.capture.identity.system_start_id.clone(),
        source: receipt.capture.source.clone(),
    };
    let pending = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let page = host.human_page(&pool, scope.clone(), None).await.unwrap();
            if let Some(request) = page
                .requests
                .into_iter()
                .find(|request| request.status == "open")
            {
                break request;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("Codex did not request the MCP tool");
    let facts: Value = serde_json::from_str(pending.flow_json.as_deref().unwrap()).unwrap();
    let action: Value =
        serde_json::from_str(facts["content"]["actionJson"].as_str().unwrap()).unwrap();
    assert_eq!(
        action["nativeRequest"]["method"],
        "mcp/tool/requestApproval"
    );
    assert_eq!(action["nativeRequest"]["params"]["server"], "issues");
    assert_eq!(action["nativeRequest"]["params"]["tool"], "lookup");
    assert_eq!(
        action["nativeRequest"]["params"]["arguments"],
        json!({"number":7})
    );
    assert!(peer.calls.lock().unwrap().is_empty());
    host.submit_person(
        &pool,
        api::HumanSubmission {
            scope: scope.clone(),
            request_id: pending.id,
            expected_revision: pending.revision,
            answer: api::HumanAnswer030::Decision {
                decision: "yes".into(),
                comment: String::new(),
            },
        },
    )
    .await
    .unwrap();
    let verdict = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let page = host
                .runtime_projection(
                    &pool,
                    api::RuntimeProjectionQuery030 {
                        system_start_id: scope.system_start_id.clone(),
                        source: scope.source.clone(),
                        snapshot_id: None,
                    },
                    None,
                )
                .await
                .unwrap();
            if let Some(verdict) = page.verdict {
                break verdict;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("Codex did not complete the run");
    assert_eq!(verdict, "succeeded");
    assert_eq!(
        *peer.calls.lock().unwrap(),
        [json!({"name":"lookup","arguments":{"number":7}})]
    );
    remove_test_snapshot(&pool, &manager, &scope.system_start_id).await;
}
