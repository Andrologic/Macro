#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderCapabilityProfile {
    pub provider_id: &'static str,
    pub provider_type: &'static str,
    pub http_only: bool,
    pub uses_local_secret_store: bool,
    pub uses_local_runtime: bool,
    pub supports_model_scan: bool,
}

const OPENAI_COMPATIBLE_DEFAULT: ProviderCapabilityProfile = ProviderCapabilityProfile {
    provider_id: "custom",
    provider_type: "openai",
    http_only: true,
    uses_local_secret_store: true,
    uses_local_runtime: false,
    supports_model_scan: true,
};

pub fn resolve_provider_capabilities(
    provider_id: &str,
    provider_type: &str,
    base_url: Option<&str>,
) -> ProviderCapabilityProfile {
    let normalized_id = provider_id.trim().to_ascii_lowercase();
    let normalized_type = provider_type.trim().to_ascii_lowercase();
    let normalized_base_url = base_url.unwrap_or_default().trim().to_ascii_lowercase();

    // Match native dispatch before considering endpoint-specific HTTP behavior.
    let effective_type = if normalized_type.is_empty() {
        match normalized_id.as_str() {
            "copilot" => "copilot",
            "chatgpt" => "chatgpt",
            _ => "openai",
        }
    } else {
        normalized_type.as_str()
    };

    match effective_type {
        "copilot" => ProviderCapabilityProfile {
            provider_id: "copilot",
            provider_type: "copilot",
            http_only: false,
            uses_local_secret_store: false,
            uses_local_runtime: true,
            supports_model_scan: true,
        },
        "chatgpt" => ProviderCapabilityProfile {
            provider_id: "chatgpt",
            provider_type: "chatgpt",
            http_only: false,
            uses_local_secret_store: true,
            uses_local_runtime: false,
            supports_model_scan: true,
        },
        _ => {
            if effective_type == "openai"
                && (normalized_id == "opencode-go" || normalized_base_url.contains("opencode.ai"))
            {
                return ProviderCapabilityProfile {
                    provider_id: "opencode-go",
                    provider_type: "openai",
                    http_only: true,
                    uses_local_secret_store: true,
                    uses_local_runtime: false,
                    supports_model_scan: true,
                };
            }

            OPENAI_COMPATIBLE_DEFAULT
        }
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_provider_capabilities;

    #[test]
    fn opencode_go_is_http_only_without_local_runtime() {
        let capabilities =
            resolve_provider_capabilities("opencode-go", "openai", Some("https://opencode.ai"));

        assert!(capabilities.http_only);
        assert!(!capabilities.uses_local_runtime);
        assert!(capabilities.uses_local_secret_store);
        assert_eq!(capabilities.provider_id, "opencode-go");
    }

    #[test]
    fn copilot_is_classified_as_local_runtime_provider() {
        let capabilities = resolve_provider_capabilities("copilot", "copilot", None);

        assert!(!capabilities.http_only);
        assert!(capabilities.uses_local_runtime);
        assert!(!capabilities.uses_local_secret_store);
    }
    #[test]
    fn capabilities_match_the_shared_dispatch_matrix() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/shared/providerCapabilityCases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let input = &case["input"];
            let actual = resolve_provider_capabilities(
                input["providerId"].as_str().unwrap(),
                input["providerType"].as_str().unwrap_or_default(),
                input["baseUrl"].as_str(),
            );
            assert_eq!(
                serde_json::json!({
                    "providerId": actual.provider_id,
                    "providerType": actual.provider_type,
                    "httpOnly": actual.http_only,
                    "usesLocalSecretStore": actual.uses_local_secret_store,
                    "usesLocalRuntime": actual.uses_local_runtime,
                    "supportsModelScan": actual.supports_model_scan,
                }),
                case["expected"],
                "input: {input}"
            );
        }
    }
}
