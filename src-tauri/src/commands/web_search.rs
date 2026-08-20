use crate::commands::{command_error, CommandResult};
use crate::config::{ConfigDocumentKind, ConfigManager};
use crate::secrets;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

const TAVILY_PROVIDER: &str = "tavily";
const BRAVE_PROVIDER: &str = "brave";
const DEFAULT_MAX_RESULTS: u32 = 5;
const MAX_RESULTS: u32 = 20;

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
}
