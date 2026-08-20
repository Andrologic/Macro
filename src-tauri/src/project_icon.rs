use crate::core::error::{BackendError, Result};
use crate::project_path::{run_wsl_shell, ProjectPathKind, WslProjectPath};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

const MAX_ICON_BYTES: u64 = 1_048_576;
const MAX_SOURCE_BYTES: u64 = 524_288;
const WSL_READ_TIMEOUT: Duration = Duration::from_secs(5);

const ICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    ".idea/icon.svg",
];

const SOURCE_CANDIDATES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

static LINK_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<link\b[^>]*>").expect("valid link tag regex"));
static ATTRIBUTE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\b(rel|href)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'=<>`]+))"#)
        .expect("valid link attribute regex")
});
static OBJECT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\{[^{}]{0,2048}\}").expect("valid metadata object regex"));
static REL_PROPERTY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\brel\s*:\s*[\"']icon[\"']"#).expect("valid rel property regex")
});
static HREF_PROPERTY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\bhref\s*:\s*[\"']([^\"']+)[\"']"#).expect("valid href property regex")
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIconDto {
    pub data_url: String,
    pub source_path: String,
    pub revision: String,
}

enum IconProjectRoot {
    Windows(PathBuf),
    Wsl(WslProjectPath),
}

impl IconProjectRoot {
    async fn from_project_path(path: ProjectPathKind) -> Result<Option<Self>> {
        match path {
            ProjectPathKind::Windows(root) => match tokio::fs::canonicalize(&root).await {
                Ok(root) => Ok(Some(Self::Windows(root))),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
                Err(error) => Err(BackendError::Filesystem {
                    message: format!(
                        "Failed to resolve project root '{}': {}",
                        root.display(),
                        error
                    ),
                }),
            },
            ProjectPathKind::Wsl(root) => Ok(Some(Self::Wsl(root))),
        }
    }

    async fn read_relative(&self, relative_path: &str, max_bytes: u64) -> Result<Option<Vec<u8>>> {
        match self {
            Self::Windows(root) => read_windows_file(root, relative_path, max_bytes).await,
            Self::Wsl(root) => read_wsl_file(root, relative_path, max_bytes).await,
        }
    }
}

pub async fn resolve_project_icon(path: ProjectPathKind) -> Result<Option<ProjectIconDto>> {
    let Some(root) = IconProjectRoot::from_project_path(path).await? else {
        return Ok(None);
    };

    for candidate in ICON_CANDIDATES {
        if let Some(icon) = read_icon_candidate(&root, candidate).await? {
            return Ok(Some(icon));
        }
    }

    for source_path in SOURCE_CANDIDATES {
        let Some(source) = root.read_relative(source_path, MAX_SOURCE_BYTES).await? else {
            continue;
        };
        let source = String::from_utf8_lossy(&source);
        for href in extract_icon_hrefs(&source) {
            let Some(relative_path) = normalize_relative_icon_path(&href) else {
                continue;
            };
            for candidate in href_candidates(&relative_path) {
                if let Some(icon) = read_icon_candidate(&root, &candidate).await? {
                    return Ok(Some(icon));
                }
            }
        }
    }

    Ok(None)
}

async fn read_icon_candidate(
    root: &IconProjectRoot,
    relative_path: &str,
) -> Result<Option<ProjectIconDto>> {
    let Some(mime_type) = icon_mime_type(relative_path) else {
        return Ok(None);
    };
    let Some(bytes) = root.read_relative(relative_path, MAX_ICON_BYTES).await? else {
        return Ok(None);
    };
    if bytes.is_empty() {
        return Ok(None);
    }

    let revision = format!("{:x}", Sha256::digest(&bytes));
    Ok(Some(ProjectIconDto {
        data_url: format!(
            "data:{};base64,{}",
            mime_type,
            BASE64_STANDARD.encode(bytes)
        ),
        source_path: relative_path.replace('\\', "/"),
        revision,
    }))
}

async fn read_windows_file(
    root: &Path,
    relative_path: &str,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>> {
    let candidate = root.join(relative_path);
    let canonical = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) => path,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::PermissionDenied
            ) =>
        {
            return Ok(None)
        }
        Err(error) => {
            return Err(BackendError::Filesystem {
                message: format!("Failed to resolve '{}': {}", candidate.display(), error),
            })
        }
    };
    if !canonical.starts_with(root) {
        return Ok(None);
    }

    let metadata = match tokio::fs::metadata(&canonical).await {
        Ok(metadata) => metadata,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::PermissionDenied
            ) =>
        {
            return Ok(None)
        }
        Err(error) => {
            return Err(BackendError::Filesystem {
                message: format!("Failed to inspect '{}': {}", canonical.display(), error),
            })
        }
    };
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Ok(None);
    }

    tokio::fs::read(&canonical)
        .await
        .map(Some)
        .map_err(|error| BackendError::Filesystem {
            message: format!("Failed to read '{}': {}", canonical.display(), error),
        })
}

async fn read_wsl_file(
    root: &WslProjectPath,
    relative_path: &str,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>> {
    let candidate = format!(
        "{}/{}",
        root.linux_path.trim_end_matches('/'),
        relative_path.replace('\\', "/")
    );
    let script = r#"
root=$(realpath -e -- "$1" 2>/dev/null) || { printf '0'; exit 0; }
candidate=$(realpath -e -- "$2" 2>/dev/null) || { printf '0'; exit 0; }
if [ "$root" != "/" ]; then
  case "$candidate" in "$root"/*) ;; *) printf '0'; exit 0 ;; esac
fi
[ -f "$candidate" ] || { printf '0'; exit 0; }
size=$(wc -c < "$candidate") || exit 1
[ "$size" -le "$3" ] || { printf '0'; exit 0; }
printf '1'
cat -- "$candidate"
"#;
    let output = run_wsl_shell(
        root,
        script,
        &[root.linux_path.clone(), candidate, max_bytes.to_string()],
        WSL_READ_TIMEOUT,
    )
    .await?;

    match output.stdout.split_first() {
        Some((b'1', bytes)) => Ok(Some(bytes.to_vec())),
        _ => Ok(None),
    }
}

fn extract_icon_hrefs(source: &str) -> Vec<String> {
    let mut hrefs = Vec::new();

    for link_match in LINK_TAG_RE.find_iter(source) {
        let mut rel = None;
        let mut href = None;
        for captures in ATTRIBUTE_RE.captures_iter(link_match.as_str()) {
            let name = captures.get(1).map(|value| value.as_str());
            let value = captures
                .get(2)
                .or_else(|| captures.get(3))
                .or_else(|| captures.get(4))
                .map(|value| value.as_str().to_string());
            match (name, value) {
                (Some(name), Some(value)) if name.eq_ignore_ascii_case("rel") => rel = Some(value),
                (Some(name), Some(value)) if name.eq_ignore_ascii_case("href") => {
                    href = Some(value)
                }
                _ => {}
            }
        }
        if rel.as_deref().is_some_and(|value| {
            value
                .split_whitespace()
                .any(|part| part.eq_ignore_ascii_case("icon"))
        }) {
            if let Some(href) = href {
                hrefs.push(href);
            }
        }
    }

    for object_match in OBJECT_RE.find_iter(source) {
        let object = object_match.as_str();
        if REL_PROPERTY_RE.is_match(object) {
            if let Some(href) = HREF_PROPERTY_RE
                .captures(object)
                .and_then(|captures| captures.get(1))
            {
                hrefs.push(href.as_str().to_string());
            }
        }
    }

    hrefs
}

fn normalize_relative_icon_path(value: &str) -> Option<String> {
    let without_fragment = value.split(['?', '#']).next()?.trim();
    if without_fragment.is_empty()
        || without_fragment.starts_with("//")
        || without_fragment.contains(':')
        || without_fragment.contains('\0')
    {
        return None;
    }

    let normalized = without_fragment.trim_start_matches('/').replace('\\', "/");
    let path = Path::new(&normalized);
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }

    let cleaned = normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    (!cleaned.is_empty()).then_some(cleaned)
}

fn href_candidates(relative_path: &str) -> Vec<String> {
    if relative_path.starts_with("public/") {
        vec![relative_path.to_string()]
    } else {
        vec![
            format!("public/{}", relative_path),
            relative_path.to_string(),
        ]
    }
}

fn icon_mime_type(path: &str) -> Option<&'static str> {
    let extension = Path::new(path)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase();
    match extension.as_str() {
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "ico" => Some("image/x-icon"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn prefers_root_favicon_over_public_candidate() {
        let root = tempdir().expect("temp directory");
        tokio::fs::create_dir(root.path().join("public"))
            .await
            .expect("public directory");
        tokio::fs::write(root.path().join("favicon.svg"), b"root")
            .await
            .expect("root favicon");
        tokio::fs::write(root.path().join("public/favicon.svg"), b"public")
            .await
            .expect("public favicon");

        let icon = resolve_project_icon(ProjectPathKind::Windows(root.path().to_path_buf()))
            .await
            .expect("resolve icon")
            .expect("icon");

        assert_eq!(icon.source_path, "favicon.svg");
        assert!(icon.data_url.ends_with("cm9vdA=="));
    }

    #[tokio::test]
    async fn resolves_icon_declared_in_source_file() {
        let root = tempdir().expect("temp directory");
        tokio::fs::create_dir_all(root.path().join("public/brand"))
            .await
            .expect("brand directory");
        tokio::fs::write(
            root.path().join("index.html"),
            br#"<link rel="shortcut icon" href="/brand/mark.svg?v=2">"#,
        )
        .await
        .expect("source file");
        tokio::fs::write(root.path().join("public/brand/mark.svg"), b"mark")
            .await
            .expect("declared icon");

        let icon = resolve_project_icon(ProjectPathKind::Windows(root.path().to_path_buf()))
            .await
            .expect("resolve icon")
            .expect("icon");

        assert_eq!(icon.source_path, "public/brand/mark.svg");
    }

    #[tokio::test]
    async fn ignores_remote_and_parent_icon_paths() {
        let root = tempdir().expect("temp directory");
        tokio::fs::write(
            root.path().join("index.html"),
            br#"<link rel="icon" href="https://example.com/icon.svg"><link rel="icon" href="../icon.svg">"#,
        )
        .await
        .expect("source file");

        let icon = resolve_project_icon(ProjectPathKind::Windows(root.path().to_path_buf()))
            .await
            .expect("resolve icon");

        assert!(icon.is_none());
    }
}
