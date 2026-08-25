use crate::commands::{command_error, CommandResult};
use crate::config::{ConfigDocumentKind, ConfigManager};
use crate::secrets;
use base64::Engine;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use tauri::State;

const TAVILY_PROVIDER: &str = "tavily";
const BRAVE_PROVIDER: &str = "brave";
const DEFAULT_MAX_RESULTS: u32 = 5;
const MAX_RESULTS: u32 = 20;
const WEB_FETCH_PAGE_MAX_BYTES: usize = 2 * 1024 * 1024;
const WEB_FETCH_FAVICON_MAX_BYTES: usize = 256 * 1024;
const WEB_FETCH_MAX_REDIRECTS: usize = 5;
const WEB_FETCH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchSecretInput {
    pub provider: String,
    pub value: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchSecretStatus {
    pub provider: String,
    pub has_secret: bool,
    pub secret_ref: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResultDto {
    pub url: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResourceDto {
    pub url: String,
    pub content_type: Option<String>,
    pub body_base64: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WebFetchResourceKind {
    Page,
    Favicon,
}

impl WebFetchResourceKind {
    fn parse(value: &str) -> CommandResult<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "page" => Ok(Self::Page),
            "favicon" => Ok(Self::Favicon),
            _ => Err(command_error(
                "Le type de ressource web doit être « page » ou « favicon ».",
            )),
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Page => WEB_FETCH_PAGE_MAX_BYTES,
            Self::Favicon => WEB_FETCH_FAVICON_MAX_BYTES,
        }
    }

    fn accept(self) -> &'static str {
        match self {
            Self::Page => "text/html,application/xhtml+xml,text/plain;q=0.9",
            Self::Favicon => "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
        }
    }

    fn accepts_content_type(self, content_type: Option<&str>) -> bool {
        let Some(content_type) = content_type else {
            return self == Self::Page;
        };
        let mime = content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        match self {
            Self::Page => {
                mime == "text/html" || mime == "application/xhtml+xml" || mime == "text/plain"
            }
            Self::Favicon => mime.starts_with("image/"),
        }
    }
}

fn ipv4_is_public(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    if a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
    {
        return false;
    }
    true
}

fn ipv6_is_public(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return ipv4_is_public(mapped);
    }
    let segments = address.segments();
    if (segments[0] & 0xe000) != 0x2000 {
        return false;
    }
    if segments[0] == 0x2002
        || (segments[0] == 0x2001
            && (segments[1] == 0x0000
                || (0x0010..=0x002f).contains(&segments[1])
                || segments[1] == 0x0db8))
    {
        return false;
    }
    true
}

fn ip_is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => ipv4_is_public(address),
        IpAddr::V6(address) => ipv6_is_public(address),
    }
}

fn validate_web_fetch_url(url: &reqwest::Url) -> CommandResult<()> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(command_error(
            "Seuls les liens HTTP et HTTPS sont autorisés pour web_fetch.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(command_error(
            "Les identifiants intégrés dans une URL web_fetch sont interdits.",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| command_error("L’URL web_fetch ne contient aucun hôte."))?;
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized_host == "localhost"
        || normalized_host.ends_with(".localhost")
        || normalized_host.ends_with(".local")
    {
        return Err(command_error(
            "web_fetch refuse les hôtes locaux et privés.",
        ));
    }
    Ok(())
}

async fn resolve_public_web_fetch_target(
    url: &reqwest::Url,
) -> CommandResult<(String, SocketAddr)> {
    validate_web_fetch_url(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| command_error("L’URL web_fetch ne contient aucun hôte."))?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| command_error("Le port de l’URL web_fetch est invalide."))?;
    let addresses = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|error| {
            command_error(format!("Impossible de résoudre l’hôte web_fetch : {error}"))
        })?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(command_error("L’hôte web_fetch ne possède aucune adresse."));
    }
    if addresses.iter().any(|address| !ip_is_public(address.ip())) {
        return Err(command_error(
            "web_fetch refuse les adresses locales, privées, réservées et link-local.",
        ));
    }
    Ok((host, addresses[0]))
}

async fn fetch_public_web_resource(
    initial_url: reqwest::Url,
    kind: WebFetchResourceKind,
) -> CommandResult<WebFetchResourceDto> {
    let mut url = initial_url;
    for redirect_count in 0..=WEB_FETCH_MAX_REDIRECTS {
        let (host, address) = resolve_public_web_fetch_target(&url).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(WEB_FETCH_TIMEOUT)
            .resolve(host.as_str(), address)
            .build()
            .map_err(|error| {
                command_error(format!("Impossible de préparer web_fetch : {error}"))
            })?;
        let response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, kind.accept())
            .header(
                reqwest::header::USER_AGENT,
                "Macro/1.0 (+https://macro.app)",
            )
            .send()
            .await
            .map_err(|error| command_error(format!("web_fetch a échoué : {error}")))?;

        if response.status().is_redirection() {
            if redirect_count == WEB_FETCH_MAX_REDIRECTS {
                return Err(command_error(
                    "web_fetch a dépassé la limite de redirections.",
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| command_error("Redirection web_fetch sans destination valide."))?;
            url = url.join(location).map_err(|error| {
                command_error(format!(
                    "Destination de redirection web_fetch invalide : {error}"
                ))
            })?;
            continue;
        }

        if !response.status().is_success() {
            return Err(command_error(format!(
                "Impossible de récupérer la ressource web ({}).",
                response.status()
            )));
        }
        let max_bytes = kind.max_bytes();
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(command_error(format!(
                "La ressource web dépasse la limite de {max_bytes} octets."
            )));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if !kind.accepts_content_type(content_type.as_deref()) {
            return Err(command_error(
                "La ressource web possède un type de contenu non autorisé.",
            ));
        }
        let final_url = response.url().to_string();
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                command_error(format!("Impossible de lire la réponse web_fetch : {error}"))
            })?;
            if body.len().saturating_add(chunk.len()) > max_bytes {
                return Err(command_error(format!(
                    "La ressource web dépasse la limite de {max_bytes} octets."
                )));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(WebFetchResourceDto {
            url: final_url,
            content_type,
            body_base64: base64::engine::general_purpose::STANDARD.encode(body),
        });
    }
    unreachable!("the redirect loop always returns or continues within its bound")
}

fn normalize_provider(provider: &str) -> CommandResult<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        TAVILY_PROVIDER => Ok(TAVILY_PROVIDER),
        BRAVE_PROVIDER => Ok(BRAVE_PROVIDER),
        _ => Err(command_error(
            "Le fournisseur de recherche doit être « tavily » ou « brave ».",
        )),
    }
}

fn secret_id(provider: &str) -> String {
    format!("web-search:{provider}")
}

fn secret_reference(provider: &str) -> String {
    format!("macro-secret://web-search/{provider}")
}

#[tauri::command]
pub async fn web_search_get_secret_status(
    provider: String,
) -> CommandResult<WebSearchSecretStatus> {
    let provider = normalize_provider(&provider)?;
    let has_secret = secrets::get_api_key(&secret_id(provider))
        .map_err(|error| command_error(format!("Impossible de vérifier le secret : {error}")))?
        .is_some_and(|value| !value.trim().is_empty());
    Ok(WebSearchSecretStatus {
        provider: provider.to_string(),
        has_secret,
        secret_ref: secret_reference(provider),
    })
}

#[tauri::command]
pub async fn web_search_set_secret(
    input: WebSearchSecretInput,
) -> CommandResult<WebSearchSecretStatus> {
    let provider = normalize_provider(&input.provider)?;
    match input.value.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => secrets::set_api_key(&secret_id(provider), value),
        _ => secrets::delete_api_key(&secret_id(provider)),
    }
    .map_err(|error| command_error(format!("Impossible de mettre à jour le secret : {error}")))?;

    web_search_get_secret_status(provider.to_string()).await
}

#[tauri::command]
pub async fn web_search_execute(
    manager: State<'_, ConfigManager>,
    query: String,
    include_raw_content: Option<bool>,
) -> CommandResult<Vec<WebSearchResultDto>> {
    let query = query.trim();
    if query.is_empty() {
        return Err(command_error("La requête de recherche est vide."));
    }

    let tools = manager
        .effective_user_document(ConfigDocumentKind::Tools)
        .await;
    let settings = tools.get("webSearch").and_then(Value::as_object);
    let enabled = settings
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return Err(command_error(
            "La recherche web est désactivée dans tools.json.",
        ));
    }

    let provider = normalize_provider(
        settings
            .and_then(|value| value.get("provider"))
            .and_then(Value::as_str)
            .unwrap_or(TAVILY_PROVIDER),
    )?;
    let max_results = settings
        .and_then(|value| value.get("maxResults"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let api_key = secrets::get_api_key(&secret_id(provider))
        .map_err(|error| command_error(format!("Impossible de lire le secret : {error}")))?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| command_error("Aucune clé API de recherche web n’est configurée."))?;

    match provider {
        TAVILY_PROVIDER => {
            search_tavily(
                query,
                &api_key,
                max_results,
                include_raw_content.unwrap_or(false),
            )
            .await
        }
        BRAVE_PROVIDER => search_brave(query, &api_key, max_results).await,
        _ => unreachable!(),
    }
}

#[tauri::command]
pub async fn web_fetch_execute(
    url: String,
    resource_kind: String,
) -> CommandResult<WebFetchResourceDto> {
    let normalized = url.trim();
    if normalized.is_empty() {
        return Err(command_error("L’URL web_fetch est vide."));
    }
    let parsed = reqwest::Url::parse(normalized)
        .map_err(|error| command_error(format!("L’URL web_fetch est invalide : {error}")))?;
    fetch_public_web_resource(parsed, WebFetchResourceKind::parse(&resource_kind)?).await
}

async fn search_tavily(
    query: &str,
    api_key: &str,
    max_results: u32,
    include_raw_content: bool,
) -> CommandResult<Vec<WebSearchResultDto>> {
    let response = reqwest::Client::new()
        .post("https://api.tavily.com/search")
        .bearer_auth(api_key)
        .json(&json!({
            "query": query,
            "max_results": max_results,
            "include_raw_content": if include_raw_content { Value::String("markdown".to_string()) } else { Value::Bool(false) },
            "include_answer": "basic",
            "include_favicon": false,
            "search_depth": "basic"
        }))
        .send()
        .await
        .map_err(|error| command_error(format!("La recherche Tavily a échoué : {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(command_error(format!(
            "Tavily a refusé la requête ({status})."
        )));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| command_error(format!("Réponse Tavily invalide : {error}")))?;
    Ok(payload
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|result| {
            let url = result.get("url")?.as_str()?.to_string();
            let title = result.get("title")?.as_str()?.to_string();
            let snippet = if include_raw_content {
                result
                    .get("raw_content")
                    .and_then(Value::as_str)
                    .or_else(|| result.get("content").and_then(Value::as_str))
            } else {
                result.get("content").and_then(Value::as_str)
            }
            .unwrap_or_default()
            .to_string();
            Some(WebSearchResultDto {
                url,
                title,
                snippet,
                score: result.get("score").and_then(Value::as_f64).unwrap_or(1.0),
            })
        })
        .collect())
}

async fn search_brave(
    query: &str,
    api_key: &str,
    max_results: u32,
) -> CommandResult<Vec<WebSearchResultDto>> {
    let mut url = reqwest::Url::parse("https://api.search.brave.com/res/v1/web/search")
        .map_err(|error| command_error(format!("URL Brave invalide : {error}")))?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("count", &max_results.to_string())
        .append_pair("extra_snippets", "true");
    let response = reqwest::Client::new()
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await
        .map_err(|error| command_error(format!("La recherche Brave a échoué : {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(command_error(format!(
            "Brave Search a refusé la requête ({status})."
        )));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| command_error(format!("Réponse Brave invalide : {error}")))?;
    Ok(payload
        .pointer("/web/results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|result| {
            let url = result.get("url")?.as_str()?.to_string();
            let title = result.get("title")?.as_str()?.to_string();
            let mut snippets = vec![result
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()];
            snippets.extend(
                result
                    .get("extra_snippets")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string),
            );
            Some(WebSearchResultDto {
                url,
                title,
                snippet: snippets
                    .into_iter()
                    .filter(|value| !value.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n"),
                score: 1.0,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_search_secret_references_are_stable_and_do_not_contain_values() {
        assert_eq!(
            secret_reference(TAVILY_PROVIDER),
            "macro-secret://web-search/tavily"
        );
        assert_eq!(secret_id(BRAVE_PROVIDER), "web-search:brave");
        assert!(normalize_provider("unknown").is_err());
    }

    #[test]
    fn web_fetch_rejects_private_reserved_and_local_addresses() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "203.0.113.1",
        ] {
            let parsed: IpAddr = address.parse().expect("valid test address");
            assert!(!ip_is_public(parsed), "{address} must be rejected");
        }
        for address in [
            "::1",
            "fe80::1",
            "fd00::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            let parsed: IpAddr = address.parse().expect("valid test address");
            assert!(!ip_is_public(parsed), "{address} must be rejected");
        }
    }

    #[test]
    fn web_fetch_accepts_public_addresses_and_rejects_unsafe_urls() {
        for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            let parsed: IpAddr = address.parse().expect("valid test address");
            assert!(ip_is_public(parsed), "{address} must be accepted");
        }
        for url in [
            "file:///etc/passwd",
            "http://localhost/secret",
            "http://service.local/secret",
            "https://user:password@example.com/",
        ] {
            let parsed = reqwest::Url::parse(url).expect("valid test URL");
            assert!(
                validate_web_fetch_url(&parsed).is_err(),
                "{url} must be rejected"
            );
        }
        let public = reqwest::Url::parse("https://example.com/page").expect("public URL");
        assert!(validate_web_fetch_url(&public).is_ok());
        assert!(WebFetchResourceKind::Page.accepts_content_type(Some("text/html; charset=utf-8")));
        assert!(!WebFetchResourceKind::Page.accepts_content_type(Some("application/octet-stream")));
        assert!(WebFetchResourceKind::Favicon.accepts_content_type(Some("image/png")));
        assert!(!WebFetchResourceKind::Favicon.accepts_content_type(None));
    }
}
