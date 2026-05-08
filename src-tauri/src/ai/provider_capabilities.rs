#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderCapabilityProfile {
    pub provider_id: &'static str,
    pub provider_type: &'static str,
    pub http_only: bool,
    pub uses_keyring: bool,
    pub uses_local_runtime: bool,
    pub supports_model_scan: bool,
}

const OPENAI_COMPATIBLE_DEFAULT: ProviderCapabilityProfile = ProviderCapabilityProfile {
    provider_id: "custom",
    provider_type: "openai",
    http_only: true,
    uses_keyring: true,
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

    if normalized_id == "opencode-go" || normalized_base_url.contains("opencode.ai") {
        return ProviderCapabilityProfile {
            provider_id: "opencode-go",
            provider_type: "openai",
            http_only: true,
            uses_keyring: true,
            uses_local_runtime: false,
            supports_model_scan: true,
        };
    }

    match normalized_type.as_str() {
        "copilot" => ProviderCapabilityProfile {
            provider_id: "copilot",
            provider_type: "copilot",
            http_only: false,
            uses_keyring: false,
            uses_local_runtime: true,
            supports_model_scan: true,
        },
        "chatgpt" => ProviderCapabilityProfile {
            provider_id: "chatgpt",
            provider_type: "chatgpt",
            http_only: false,
            uses_keyring: true,
            uses_local_runtime: false,
            supports_model_scan: true,
        },
        _ => OPENAI_COMPATIBLE_DEFAULT,
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
        assert!(capabilities.uses_keyring);
        assert_eq!(capabilities.provider_id, "opencode-go");
    }

    #[test]
    fn copilot_is_classified_as_local_runtime_provider() {
        let capabilities = resolve_provider_capabilities("copilot", "copilot", None);

        assert!(!capabilities.http_only);
        assert!(capabilities.uses_local_runtime);
        assert!(!capabilities.uses_keyring);
    }
}
