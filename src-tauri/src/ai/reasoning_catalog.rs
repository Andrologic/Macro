use regex::Regex;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, Deserialize)]
struct ReasoningCatalogFile {
    #[allow(dead_code)]
    version: u32,
    entries: Vec<ReasoningCatalogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct ReasoningCatalogEntry {
    provider_types: Vec<String>,
    model_patterns: Vec<String>,
    supported_efforts: Vec<String>,
    default_effort: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReasoningCapability {
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
}

static REASONING_CATALOG: LazyLock<ReasoningCatalogFile> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/shared/ai/reasoningCatalog.json"))
        .expect("reasoning catalog must be valid JSON")
});

static CANONICAL_EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

fn is_safe_effort(effort: &str) -> bool {
    let mut chars = effort.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    effort.len() <= 64
        && first.is_ascii_alphanumeric()
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

fn normalize_efforts(efforts: Option<&[String]>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = efforts
        .into_iter()
        .flatten()
        .filter(|effort| is_safe_effort(effort) && seen.insert((*effort).clone()))
        .cloned()
        .enumerate()
        .collect::<Vec<_>>();
    normalized.sort_by_key(|(input_index, effort)| {
        (
            CANONICAL_EFFORTS
                .iter()
                .position(|known| known == effort)
                .unwrap_or(CANONICAL_EFFORTS.len()),
            *input_index,
        )
    });
    normalized.into_iter().map(|(_, effort)| effort).collect()
}

#[cfg(test)]
mod tests {
    use super::{normalize_efforts, resolve_reasoning_capability};

    #[test]
    fn preserves_max_and_safe_provider_defined_efforts() {
        let efforts = vec![
            "provider_custom".to_string(),
            "max".to_string(),
            "low".to_string(),
            "invalid effort".to_string(),
        ];
        assert_eq!(
            normalize_efforts(Some(&efforts)),
            vec!["low", "max", "provider_custom"]
        );
    }

    #[test]
    fn resolves_current_gpt_5_6_catalog_entry() {
        let capability =
            resolve_reasoning_capability(Some("openai"), Some("gpt-5.6"), None, None, None);
        assert!(capability.reasoning_efforts.contains(&"max".to_string()));
        assert_eq!(
            capability.default_reasoning_effort.as_deref(),
            Some("medium")
        );
    }
}

fn first_valid_effort(preferred: Option<&str>, efforts: &[String]) -> Option<String> {
    if let Some(preferred) = preferred {
        if efforts.iter().any(|effort| effort == preferred) {
            return Some(preferred.to_string());
        }
    }

    efforts.first().cloned()
}

fn has_openrouter_reasoning_support(supported_parameters: Option<&[String]>) -> bool {
    supported_parameters
        .map(|parameters| {
            parameters
                .iter()
                .any(|parameter| parameter == "reasoning" || parameter == "reasoning_effort")
        })
        .unwrap_or(false)
}

pub fn resolve_reasoning_capability(
    provider_type: Option<&str>,
    model_id: Option<&str>,
    supported_parameters: Option<&[String]>,
    supported_reasoning_efforts: Option<&[String]>,
    default_reasoning_effort: Option<&str>,
) -> ReasoningCapability {
    let Some(provider_type) = provider_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ReasoningCapability {
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
        };
    };
    let Some(model_id) = model_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return ReasoningCapability {
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
        };
    };

    let direct_efforts = normalize_efforts(supported_reasoning_efforts);
    if !direct_efforts.is_empty() {
        return ReasoningCapability {
            default_reasoning_effort: first_valid_effort(default_reasoning_effort, &direct_efforts),
            reasoning_efforts: direct_efforts,
        };
    }

    if provider_type.eq_ignore_ascii_case("openrouter")
        && !has_openrouter_reasoning_support(supported_parameters)
    {
        return ReasoningCapability {
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
        };
    }

    let matched = REASONING_CATALOG.entries.iter().find(|entry| {
        entry
            .provider_types
            .iter()
            .any(|supported_provider| supported_provider.eq_ignore_ascii_case(provider_type))
            && entry.model_patterns.iter().any(|pattern| {
                Regex::new(pattern)
                    .map(|compiled| compiled.is_match(model_id))
                    .unwrap_or(false)
            })
    });

    let Some(matched) = matched else {
        return ReasoningCapability {
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
        };
    };

    let reasoning_efforts = normalize_efforts(Some(&matched.supported_efforts));
    ReasoningCapability {
        default_reasoning_effort: first_valid_effort(
            Some(&matched.default_effort),
            &reasoning_efforts,
        ),
        reasoning_efforts,
    }
}
