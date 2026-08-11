use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[derive(Clone)]
pub struct BearerTokenDigest([u8; 32]);

impl BearerTokenDigest {
    pub fn new(token: &str) -> Self {
        Self(Sha256::digest(token.as_bytes()).into())
    }

    pub fn authorizes(&self, authorization_header: Option<&str>) -> bool {
        let Some(provided) = authorization_header
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.is_empty())
        else {
            return false;
        };

        let provided_digest: [u8; 32] = Sha256::digest(provided.as_bytes()).into();
        bool::from(provided_digest.ct_eq(&self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::BearerTokenDigest;

    #[test]
    fn bearer_auth_requires_the_exact_scheme_and_token() {
        let token = BearerTokenDigest::new("expected-secret");

        assert!(token.authorizes(Some("Bearer expected-secret")));
        assert!(!token.authorizes(None));
        assert!(!token.authorizes(Some("Basic expected-secret")));
        assert!(!token.authorizes(Some("bearer expected-secret")));
        assert!(!token.authorizes(Some("Bearer ")));
        assert!(!token.authorizes(Some("Bearer wrong-secret")));
        assert!(!token.authorizes(Some("Bearer expected-secret ")));
    }
}
