use std::net::IpAddr;

/// Validate an endpoint before a provider key or user content can be sent to it.
pub fn validate_provider_endpoint(base_url: &str, is_local: bool) -> Result<(), &'static str> {
    let url = reqwest::Url::parse(base_url.trim())
        .map_err(|_| "Provider base URL must be a valid URL.")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Provider base URL must use HTTP or HTTPS.");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Provider base URL must not contain credentials.");
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Provider base URL must not contain a query or fragment.");
    }
    if url.scheme() == "http" {
        let loopback = url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
        if !is_local || !loopback {
            return Err("HTTP provider base URLs require a local provider on a loopback host.");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_provider_endpoint;

    #[test]
    fn http_requires_local_flag_and_loopback_host() {
        for url in [
            "http://example.test/v1",
            "http://192.168.1.5/v1",
            "http://localhost.example.test/v1",
        ] {
            assert!(validate_provider_endpoint(url, true).is_err(), "{url}");
        }
        assert!(validate_provider_endpoint("http://localhost:11434/v1", false).is_err());
        for url in [
            "http://127.0.0.1:11434/v1",
            "http://[::1]:11434/v1",
            "http://localhost:11434/v1",
        ] {
            assert!(validate_provider_endpoint(url, true).is_ok(), "{url}");
        }
        assert!(validate_provider_endpoint("https://example.test/v1", false).is_ok());
    }
}
