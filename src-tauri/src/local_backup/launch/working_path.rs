use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use std::ffi::{OsStr, OsString};

#[derive(Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Encoding {
    UnixBytes,
    WindowsUtf16Le,
}

impl Encoding {
    pub(super) const NATIVE: Self = if cfg!(windows) {
        Self::WindowsUtf16Le
    } else {
        Self::UnixBytes
    };

    pub(super) fn encode(name: &OsStr) -> String {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            URL_SAFE_NO_PAD.encode(name.as_bytes())
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let bytes: Vec<_> = name.encode_wide().flat_map(u16::to_le_bytes).collect();
            URL_SAFE_NO_PAD.encode(bytes)
        }
    }

    fn bytes(self, encoded: &str) -> Result<Vec<u8>> {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Invalid native launch path encoding")?;
        if self == Self::WindowsUtf16Le && bytes.len() % 2 != 0 {
            return Err("Invalid UTF-16 launch path encoding".into());
        }
        Ok(bytes)
    }

    pub(super) fn component(self, encoded: &str) -> Result<Option<OsString>> {
        let bytes = self.bytes(encoded)?;
        match self {
            Self::UnixBytes => {
                if bytes.is_empty()
                    || matches!(bytes.as_slice(), b"." | b"..")
                    || bytes.iter().any(|&byte| matches!(byte, 0 | b'/'))
                {
                    return Err("Unsafe native launch path component".into());
                }
                #[cfg(all(unix, not(target_os = "macos")))]
                {
                    use std::os::unix::ffi::OsStringExt;
                    Ok(Some(OsString::from_vec(bytes)))
                }
                #[cfg(target_os = "macos")]
                {
                    Ok(String::from_utf8(bytes).ok().map(OsString::from))
                }
                #[cfg(windows)]
                Ok(String::from_utf8(bytes)
                    .ok()
                    .filter(|name| windows_name(name))
                    .map(OsString::from))
            }
            Self::WindowsUtf16Le => {
                let units = wide(&bytes);
                if units.is_empty()
                    || matches!(units.as_slice(), [46] | [46, 46])
                    || units.iter().any(|&unit| matches!(unit, 0 | 47 | 92 | 58))
                {
                    return Err("Unsafe native launch path component".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::ffi::OsStringExt;
                    Ok(Some(OsString::from_wide(&units)))
                }
                #[cfg(unix)]
                Ok(String::from_utf16(&units).ok().map(OsString::from))
            }
        }
    }

    pub(super) fn link(self, encoded: &str) -> Result<Option<PathBuf>> {
        self.link_path(encoded, false)
    }

    pub(super) fn link_suffix(self, encoded: &str) -> Result<Option<PathBuf>> {
        self.link_path(encoded, true)
    }

    fn link_path(self, encoded: &str, suffix: bool) -> Result<Option<PathBuf>> {
        let bytes = self.bytes(encoded)?;
        let text = match self {
            Self::UnixBytes => {
                if bytes.is_empty() || bytes.contains(&0) || suffix && !bytes.starts_with(b"/") {
                    return Err("Invalid native launch link target".into());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::ffi::OsStringExt;
                    return Ok(Some(OsString::from_vec(bytes).into()));
                }
                #[cfg(windows)]
                String::from_utf8(bytes)
                    .ok()
                    .filter(|path| {
                        path.starts_with('/') == suffix
                            && path
                                .split('/')
                                .all(|name| matches!(name, "" | "." | "..") || windows_name(name))
                    })
                    .map(|path| {
                        if suffix {
                            path.replace('/', "\\")
                        } else {
                            path
                        }
                    })
            }
            Self::WindowsUtf16Le => {
                let units = wide(&bytes);
                if units.is_empty() || units.contains(&0) || suffix && !matches!(units[0], 47 | 92)
                {
                    return Err("Invalid native launch link target".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::ffi::OsStringExt;
                    return Ok(Some(OsString::from_wide(&units).into()));
                }
                #[cfg(unix)]
                String::from_utf16(&units).ok().and_then(|path| {
                    let path = path.replace('\\', "/");
                    (path.starts_with('/') == suffix && !path.contains(':')).then_some(path)
                })
            }
        };
        Ok(text.map(PathBuf::from))
    }

    pub(super) fn describe(self, encoded: &str) -> String {
        let bytes = self.bytes(encoded).expect("validated launch path");
        let text = match self {
            Self::UnixBytes => String::from_utf8(bytes.clone()).ok(),
            Self::WindowsUtf16Le => String::from_utf16(&wide(&bytes)).ok(),
        };
        match text {
            Some(text) => format!("{text:?}"),
            None => format!("{bytes:02x?}"),
        }
    }
}

// Components help locate the run root. Slicing the original target preserves
// separators, dot components and trailing slashes after that root.
pub(super) fn raw_suffix<'a>(target: &'a Path, root: &Path) -> &'a OsStr {
    let root = root.components().as_path().as_os_str();
    let suffix = &target.as_os_str().as_encoded_bytes()[root.len()..];
    // SAFETY: root is an ancestor slice of target, ending either at the
    // end of target or immediately before an ASCII path separator.
    unsafe { OsStr::from_encoded_bytes_unchecked(suffix) }
}

pub(super) fn with_suffix(root: &Path, suffix: &OsStr) -> PathBuf {
    let mut path = root.as_os_str().to_owned();
    path.push(suffix);
    path.into()
}

pub(super) fn strip_root<'a>(path: &'a Path, root: &Path) -> Option<&'a Path> {
    #[cfg(unix)]
    return path.strip_prefix(root).ok();
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if let Ok(relative) = path.strip_prefix(root) {
            return Some(relative);
        }
        // A symlink target can omit the verbatim prefix returned by canonicalize.
        let mut path = path.components();
        let mut root = root.components();
        let (Some(Component::Prefix(path_prefix)), Some(Component::Prefix(root_prefix))) =
            (path.next(), root.next())
        else {
            return None;
        };
        match (path_prefix.kind(), root_prefix.kind()) {
            (
                Prefix::Disk(a) | Prefix::VerbatimDisk(a),
                Prefix::Disk(b) | Prefix::VerbatimDisk(b),
            ) if a == b => {}
            (
                Prefix::UNC(a, b) | Prefix::VerbatimUNC(a, b),
                Prefix::UNC(c, d) | Prefix::VerbatimUNC(c, d),
            ) if (a, b) == (c, d) => {}
            _ => return None,
        }
        root.all(|part| path.next() == Some(part))
            .then(|| path.as_path())
    }
}

fn wide(bytes: &[u8]) -> Vec<u16> {
    bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

#[cfg(any(windows, test))]
fn windows_name(name: &str) -> bool {
    if name.ends_with([' ', '.'])
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
        || name.encode_utf16().count() > 255
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|number| {
            matches!(
                number,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_components_reject_traversal_and_native_separators() {
        for (encoding, candidates) in [
            (
                Encoding::UnixBytes,
                &["", ".", "..", "/outside", "a/b", "a\0b"][..],
            ),
            (
                Encoding::WindowsUtf16Le,
                &["", ".", "..", "\\outside", "C:drive", "a/b", "a\0b"][..],
            ),
        ] {
            for candidate in candidates {
                let bytes = match encoding {
                    Encoding::UnixBytes => candidate.as_bytes().to_vec(),
                    Encoding::WindowsUtf16Le => candidate
                        .encode_utf16()
                        .flat_map(u16::to_le_bytes)
                        .collect(),
                };
                assert!(
                    encoding.component(&URL_SAFE_NO_PAD.encode(bytes)).is_err(),
                    "{candidate:?}"
                );
            }
        }
    }

    #[test]
    fn windows_import_rejects_nonrepresentable_unix_names() {
        for name in [
            "CON.txt",
            "COM¹.txt",
            "a\\b",
            "12:30",
            "a\nb",
            "trailing.",
            "trailing ",
        ] {
            assert!(!windows_name(name), "{name:?}");
        }
        for name in ["report-1230.txt", "a-long~1.md", ".env", "café.txt"] {
            assert!(windows_name(name), "{name:?}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_import_skips_non_utf8_unix_names() {
        assert_eq!(
            Encoding::UnixBytes
                .component(&URL_SAFE_NO_PAD.encode(b"non-utf8-\xff.txt"))
                .unwrap(),
            None
        );
        assert_eq!(
            Encoding::UnixBytes
                .component(&URL_SAFE_NO_PAD.encode("café.txt"))
                .unwrap(),
            Some(OsString::from("café.txt"))
        );
    }
}

#[cfg(all(windows, test))]
#[test]
fn match_windows_drive_symlink_target_under_verbatim_root() {
    let data = Path::new(r"\\?\C:\macro\data");
    let target = Path::new(r"C:\macro\data\file.txt");
    assert_eq!(strip_root(target, data), Some(Path::new("file.txt")));
}
