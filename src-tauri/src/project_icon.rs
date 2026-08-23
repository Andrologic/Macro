use crate::core::error::{BackendError, Result};
use crate::project_path::{run_wsl_shell, ProjectPathKind, WslProjectPath};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::io::AsyncReadExt;

const MAX_ICON_BYTES: u64 = 262_144;
const MAX_SOURCE_BYTES: u64 = 524_288;
const MAX_ICON_PATH_BYTES: usize = 512;
const MAX_DISCOVERED_ICON_CANDIDATES: usize = 32;
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIconResolutionDto {
    pub project_id: String,
    pub icon: Option<ProjectIconDto>,
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

    async fn read_candidates(
        &self,
        relative_paths: &[String],
        max_bytes: u64,
        stop_after_first: bool,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        match self {
            Self::Windows(root) => {
                let mut files = Vec::new();
                for relative_path in relative_paths {
                    if let Some(bytes) = read_windows_file(root, relative_path, max_bytes).await? {
                        files.push((relative_path.clone(), bytes));
                        if stop_after_first {
                            break;
                        }
                    }
                }
                Ok(files)
            }
            Self::Wsl(root) => {
                read_wsl_files(root, relative_paths, max_bytes, stop_after_first).await
            }
        }
    }
}

pub async fn resolve_project_icon(path: ProjectPathKind) -> Result<Option<ProjectIconDto>> {
    let Some(root) = IconProjectRoot::from_project_path(path).await? else {
        return Ok(None);
    };

    let fixed_candidates = ICON_CANDIDATES
        .iter()
        .map(|candidate| (*candidate).to_string())
        .collect::<Vec<_>>();
    if let Some((source_path, bytes)) = root
        .read_candidates(&fixed_candidates, MAX_ICON_BYTES, true)
        .await?
        .into_iter()
        .next()
    {
        return Ok(project_icon_from_bytes(&source_path, bytes));
    }

    let source_candidates = SOURCE_CANDIDATES
        .iter()
        .map(|candidate| (*candidate).to_string())
        .collect::<Vec<_>>();
    let sources = root
        .read_candidates(&source_candidates, MAX_SOURCE_BYTES, false)
        .await?;
    let mut discovered_candidates = Vec::new();
    let mut seen_candidates = HashSet::new();
    'sources: for (_, source) in sources {
        let source = String::from_utf8_lossy(&source);
        for href in extract_icon_hrefs(&source) {
            let Some(relative_path) = normalize_relative_icon_path(&href) else {
                continue;
            };
            for candidate in href_candidates(&relative_path) {
                if icon_mime_type(&candidate).is_some() && seen_candidates.insert(candidate.clone())
                {
                    discovered_candidates.push(candidate);
                    if discovered_candidates.len() >= MAX_DISCOVERED_ICON_CANDIDATES {
                        break 'sources;
                    }
                }
            }
        }
    }

    if let Some((source_path, bytes)) = root
        .read_candidates(&discovered_candidates, MAX_ICON_BYTES, true)
        .await?
        .into_iter()
        .next()
    {
        return Ok(project_icon_from_bytes(&source_path, bytes));
    }

    Ok(None)
}

fn project_icon_from_bytes(relative_path: &str, bytes: Vec<u8>) -> Option<ProjectIconDto> {
    let Some(mime_type) = icon_mime_type(relative_path) else {
        return None;
    };
    if bytes.is_empty() {
        return None;
    }

    let revision = format!("{:x}", Sha256::digest(&bytes));
    Some(ProjectIconDto {
        data_url: format!(
            "data:{};base64,{}",
            mime_type,
            BASE64_STANDARD.encode(bytes)
        ),
        source_path: relative_path.replace('\\', "/"),
        revision,
    })
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

    let file = match tokio::fs::File::open(&canonical).await {
        Ok(file) => file,
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
                message: format!("Failed to open '{}': {}", canonical.display(), error),
            })
        }
    };
    let metadata = match file.metadata().await {
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

    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| BackendError::Filesystem {
            message: format!("Failed to read '{}': {}", canonical.display(), error),
        })?;
    if bytes.len() as u64 > max_bytes {
        return Ok(None);
    }
    let canonical_after_read = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if canonical_after_read != canonical || !canonical_after_read.starts_with(root) {
        return Ok(None);
    }
    Ok(Some(bytes))
}

async fn read_wsl_files(
    root: &WslProjectPath,
    relative_paths: &[String],
    max_bytes: u64,
    stop_after_first: bool,
) -> Result<Vec<(String, Vec<u8>)>> {
    if relative_paths.is_empty() {
        return Ok(Vec::new());
    }
    let script = r#"
root=$(realpath -e -- "$1" 2>/dev/null) || exit 0
max=$2
stop_after_first=$3
shift 3
tmp=$(mktemp) || exit 1
trap 'rm -f -- "$tmp"' EXIT
limit=$((max + 1))
for relative in "$@"; do
  candidate="$root/$relative"
  exec 3<"$candidate" 2>/dev/null || continue
  opened=$(readlink -f "/proc/$$/fd/3" 2>/dev/null) || { exec 3<&-; continue; }
  if [ "$root" != "/" ]; then
    case "$opened" in "$root"/*) ;; *) exec 3<&-; continue ;; esac
  fi
  [ -f "/proc/$$/fd/3" ] || { exec 3<&-; continue; }
  : > "$tmp"
  head -c "$limit" <&3 > "$tmp" || { exec 3<&-; exit 1; }
  exec 3<&-
  size=$(wc -c < "$tmp") || exit 1
  [ "$size" -le "$max" ] || continue
  printf '%s\0%s\0' "$relative" "$size"
  cat -- "$tmp" || exit 1
  [ "$stop_after_first" = "1" ] && exit 0
done
"#;
    let mut args = vec![
        root.linux_path.clone(),
        max_bytes.to_string(),
        if stop_after_first { "1" } else { "0" }.to_string(),
    ];
    args.extend(relative_paths.iter().cloned());
    let output = run_wsl_shell(root, script, &args, WSL_READ_TIMEOUT).await?;
    parse_wsl_file_records(&output.stdout, max_bytes)
}

fn parse_wsl_file_records(output: &[u8], max_bytes: u64) -> Result<Vec<(String, Vec<u8>)>> {
    let mut cursor = 0usize;
    let mut files = Vec::new();
    while cursor < output.len() {
        let path_end = output[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| BackendError::Filesystem {
                message: "Invalid WSL project icon response path frame.".to_string(),
            })?;
        let relative_path = String::from_utf8_lossy(&output[cursor..path_end]).to_string();
        cursor = path_end + 1;
        let size_end = output[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| BackendError::Filesystem {
                message: "Invalid WSL project icon response size frame.".to_string(),
            })?;
        let size = String::from_utf8_lossy(&output[cursor..size_end])
            .parse::<usize>()
            .map_err(|_| BackendError::Filesystem {
                message: "Invalid WSL project icon response size.".to_string(),
            })?;
        cursor = size_end + 1;
        if size as u64 > max_bytes || output.len().saturating_sub(cursor) < size {
            return Err(BackendError::Filesystem {
                message: "Invalid WSL project icon response payload.".to_string(),
            });
        }
        files.push((relative_path, output[cursor..cursor + size].to_vec()));
        cursor += size;
    }
    Ok(files)
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
        || without_fragment.len() > MAX_ICON_PATH_BYTES
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

    #[tokio::test]
    async fn resolves_icon_declared_in_metadata_object() {
        let root = tempdir().expect("temp directory");
        tokio::fs::create_dir_all(root.path().join("public/brand"))
            .await
            .expect("brand directory");
        tokio::fs::create_dir(root.path().join("app"))
            .await
            .expect("app directory");
        tokio::fs::write(
            root.path().join("app/root.tsx"),
            br#"export const links = () => [{ rel: "icon", href: "/brand/icon.webp" }];"#,
        )
        .await
        .expect("metadata source");
        tokio::fs::write(root.path().join("public/brand/icon.webp"), b"webp")
            .await
            .expect("metadata icon");

        let icon = resolve_project_icon(ProjectPathKind::Windows(root.path().to_path_buf()))
            .await
            .expect("resolve icon")
            .expect("icon");

        assert_eq!(icon.source_path, "public/brand/icon.webp");
        assert!(icon.data_url.starts_with("data:image/webp;base64,"));
    }

    #[tokio::test]
    async fn rejects_oversized_icon_files() {
        let root = tempdir().expect("temp directory");
        tokio::fs::write(
            root.path().join("favicon.png"),
            vec![0_u8; MAX_ICON_BYTES as usize + 1],
        )
        .await
        .expect("oversized favicon");

        let icon = resolve_project_icon(ProjectPathKind::Windows(root.path().to_path_buf()))
            .await
            .expect("resolve icon");

        assert!(icon.is_none());
    }

    #[test]
    fn parses_multiple_wsl_file_records_with_binary_payloads() {
        let mut output = b"favicon.ico\0".to_vec();
        output.extend_from_slice(b"3\0");
        output.extend_from_slice(&[0, 1, 2]);
        output.extend_from_slice(b"public/icon.png\0");
        output.extend_from_slice(b"4\0data");

        let files = parse_wsl_file_records(&output, 16).expect("parse records");

        assert_eq!(
            files,
            vec![
                ("favicon.ico".to_string(), vec![0, 1, 2]),
                ("public/icon.png".to_string(), b"data".to_vec()),
            ]
        );
    }

    #[test]
    fn rejects_invalid_wsl_file_record_payloads() {
        let oversized = b"favicon.png\0"
            .iter()
            .copied()
            .chain(b"5\0abcde".iter().copied())
            .collect::<Vec<_>>();
        let truncated = b"favicon.png\0"
            .iter()
            .copied()
            .chain(b"5\0abc".iter().copied())
            .collect::<Vec<_>>();

        assert!(parse_wsl_file_records(&oversized, 4).is_err());
        assert!(parse_wsl_file_records(&truncated, 16).is_err());
    }

    #[test]
    fn rejects_icon_paths_that_are_too_long_for_safe_batching() {
        let path = format!("{}.png", "a".repeat(MAX_ICON_PATH_BYTES));

        assert!(normalize_relative_icon_path(&path).is_none());
    }
}
