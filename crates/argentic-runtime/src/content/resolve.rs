use super::*;
use base64::Engine;
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::sync::Mutex;
use url::Url;

pub(super) struct SkillRoot {
    pub uri: Url,
    pub file_identity: Option<String>,
}

fn uri_text(value: &str) -> ContentResult<()> {
    if value.bytes().any(|b| b <= b' ' || b >= 127 || b == b'\\') {
        return Err(error("CONTENT_URI", "Invalid URI characters."));
    }
    let bytes = value.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'%'
            && (i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit())
        {
            return Err(error("CONTENT_URI", "Invalid URI percent encoding."));
        }
    }
    Ok(())
}

pub(super) fn absolute_uri(value: &str) -> ContentResult<Url> {
    uri_text(value)?;
    Url::parse(value).map_err(|e| error("CONTENT_URI", e))
}

pub(super) fn resolved_uri(context: &ContentContext, value: &str) -> ContentResult<Url> {
    uri_text(value)?;
    match Url::parse(value) {
        Ok(url) => Ok(url),
        Err(url::ParseError::RelativeUrlWithoutBase) => context
            .document_location
            .as_ref()
            .ok_or_else(|| {
                error(
                    "CONTENT_ORIGIN",
                    "Relative URI requires a captured document location.",
                )
            })?
            .join(value)
            .map_err(|e| error("CONTENT_URI", e)),
        Err(e) => Err(error("CONTENT_URI", e)),
    }
}

fn raw_object(json: &str) -> ContentResult<BTreeMap<String, Box<RawValue>>> {
    argentic_core::durable_json::validate(json).map_err(|e| error("PARSE", e))?;
    serde_json::from_str(json).map_err(|e| error("INVALID_SOURCE", e))
}

fn field_string(value: Option<&Box<RawValue>>) -> ContentResult<Option<String>> {
    value
        .map(|raw| serde_json::from_str(raw.get()).map_err(|e| error("INVALID_SOURCE", e)))
        .transpose()
}

fn is_json(media: &str) -> bool {
    let mime = media
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    mime == "application/json" || mime.ends_with("+json")
}
fn is_text(media: &str) -> bool {
    media
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .starts_with("text/")
}

fn payload(bytes: &[u8], media: &str) -> ContentResult<ContentPayload> {
    if is_json(media) {
        let json = std::str::from_utf8(bytes).map_err(|e| error("CONTENT_ENCODING", e))?;
        argentic_core::durable_json::validate(json).map_err(|e| error("CONTENT_JSON", e))?;
        Ok(ContentPayload::Json { json: json.into() })
    } else if is_text(media) {
        let text = std::str::from_utf8(bytes).map_err(|e| error("CONTENT_ENCODING", e))?;
        Ok(ContentPayload::Text { text: text.into() })
    } else {
        Ok(ContentPayload::Media {
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }
}

fn file_read_error(
    cancelled: bool,
    error_value: crate::content_io::admitted::ReadError,
) -> ContentError {
    if matches!(&error_value, crate::content_io::admitted::ReadError::Io { source, .. } if source.kind() == std::io::ErrorKind::TimedOut)
    {
        error("CONTENT_TERMINATION_UNCERTAIN", error_value)
    } else if cancelled {
        error("CANCELLED", "Content read cancelled.")
    } else {
        error("CONTENT_UNAVAILABLE", error_value)
    }
}

#[cfg(test)]
mod termination_tests {
    use super::*;
    #[test]
    fn cancellation_does_not_hide_uncertain_termination() {
        let source = std::io::Error::new(std::io::ErrorKind::TimedOut, "not reaped");
        let error_value = crate::content_io::admitted::io_error_to_backend_error(
            source,
            std::path::Path::new("/synthetic/data"),
        );
        assert_eq!(
            file_read_error(true, error_value).code,
            "CONTENT_TERMINATION_UNCERTAIN"
        );
    }

    #[test]
    fn confirmed_cancellation_stays_distinct_from_read_failure() {
        let failure = || crate::content_io::admitted::ReadError::Filesystem {
            message: "synthetic failure".into(),
        };
        assert_eq!(file_read_error(true, failure()).code, "CANCELLED");
        assert_eq!(
            file_read_error(false, failure()).code,
            "CONTENT_UNAVAILABLE"
        );
    }
}

pub async fn resolve_content(
    context: &ContentContext,
    usage: ContentUse,
) -> ContentResult<ResolvedContentReceipt> {
    let pointer = usage.pointer.clone();
    resolve_content_in_root(context, usage, None)
        .await
        .map_err(|mut error| {
            if error.pointer.is_empty() {
                error.pointer = pointer;
            }
            error
        })
}

pub(super) async fn resolve_content_in_root(
    context: &ContentContext,
    usage: ContentUse,
    root: Option<&SkillRoot>,
) -> ContentResult<ResolvedContentReceipt> {
    context.active()?;
    let source_digest = digest(usage.source_json.as_bytes());
    let mut source = raw_object(&usage.source_json)?;
    if source.contains_key("ref") {
        if source.len() != 1 {
            return Err(error("INVALID_SOURCE", "A ref cannot have other fields."));
        }
        let name = field_string(source.get("ref"))?
            .ok_or_else(|| error("INVALID_SOURCE", "Missing ref."))?;
        let entry =
            argentic_core::durable_json::at_path(&context.document_json, &["content", &name])
                .map_err(|e| error("PARSE", e))?
                .ok_or_else(|| error("INVALID_SOURCE", "Unknown content ref."))?;
        source = raw_object(entry.get())?;
        if source.contains_key("ref") {
            return Err(error(
                "INVALID_SOURCE",
                "A content entry cannot contain ref.",
            ));
        }
    }
    if source
        .keys()
        .any(|k| !matches!(k.as_str(), "uri" | "value" | "mediaType"))
        || source.contains_key("uri") == source.contains_key("value")
    {
        return Err(error(
            "INVALID_SOURCE",
            "Expected exactly one value or URI.",
        ));
    }
    let declared = field_string(source.get("mediaType"))?;
    let (bytes, payload, requested, final_uri, observed, media, file_parent_identity) =
        if let Some(value) = source.get("value") {
            let raw = value.get();
            let inline_text = serde_json::from_str::<String>(raw).ok();
            let media = declared.clone().unwrap_or_else(|| {
                if inline_text.is_some() {
                    "text/plain".into()
                } else {
                    "application/json".into()
                }
            });
            if let Some(text) = inline_text {
                (
                    text.as_bytes().to_vec(),
                    ContentPayload::Text { text },
                    None,
                    None,
                    None,
                    media,
                    None,
                )
            } else {
                (
                    raw.as_bytes().to_vec(),
                    ContentPayload::Json { json: raw.into() },
                    None,
                    None,
                    None,
                    media,
                    None,
                )
            }
        } else {
            let requested = field_string(source.get("uri"))?
                .ok_or_else(|| error("INVALID_SOURCE", "Missing URI."))?;
            let uri = resolved_uri(context, &requested)?;
            let (bytes, final_uri, observed, file_parent_identity) =
                read_uri(context, &uri, root, &usage, &source_digest).await?;
            let media = declared
                .clone()
                .or_else(|| observed.clone())
                .unwrap_or_else(|| {
                    if std::str::from_utf8(&bytes).is_ok() && !bytes.contains(&0) {
                        "text/plain".into()
                    } else {
                        "application/octet-stream".into()
                    }
                });
            let data = payload(&bytes, &media)?;
            (
                bytes,
                data,
                Some(requested),
                Some(final_uri),
                observed,
                media,
                file_parent_identity,
            )
        };
    context.active()?;
    Ok(ResolvedContentReceipt {
        payload,
        provenance: ContentProvenance {
            capture_id: context.capture_id.clone(),
            source_digest: context.source_digest.clone(),
            agent: context.agent.clone(),
            usage: usage.usage,
            pointer: usage.pointer,
            source_json_digest: source_digest,
            requested_uri: requested,
            final_uri,
            file_parent_identity,
            declared_media_type: declared,
            observed_media_type: observed,
            media_type: media,
            size_bytes: bytes.len().to_string(),
            sha256: digest(&bytes),
            policy_digest: context.policy.fingerprint(),
        },
    })
}

fn within_root(uri: &Url, root: &Url) -> bool {
    let path = uri.path().to_ascii_lowercase();
    (uri.scheme() == "file" && root.scheme() == "file" && uri.host_str() == root.host_str()
        || uri.scheme() != "file" && uri.origin() == root.origin())
        && uri.scheme() == root.scheme()
        && uri.path().starts_with(root.path())
        && !path.contains("%2f")
        && !path.contains("%5c")
}

async fn read_uri(
    context: &ContentContext,
    uri: &Url,
    root: Option<&SkillRoot>,
    usage: &ContentUse,
    source_json_digest: &str,
) -> ContentResult<(Vec<u8>, String, Option<String>, Option<String>)> {
    if !uri.username().is_empty() || uri.password().is_some() {
        return Err(error("CONTENT_URI", "URI credentials are not accepted."));
    }
    if root.is_some_and(|root| !within_root(uri, &root.uri)) {
        return Err(error("PERMISSION", "Skill resource is outside its root."));
    }
    let base_effect = ContentEffect {
        usage: usage.usage,
        pointer: usage.pointer.clone(),
        source_json_digest: source_json_digest.into(),
        target_uri: uri.to_string(),
        phase: ContentEffectPhase::FileRead,
    };
    match uri.scheme() {
        "file" => {
            let path = uri.to_file_path().map_err(|_| {
                error(
                    "CONTENT_URI",
                    "File URI cannot be converted to a local path.",
                )
            })?;
            let logical = path
                .to_str()
                .ok_or_else(|| error("CONTENT_URI", "Non-UTF-8 file path."))?
                .to_owned();
            let root_path = root
                .map(|r| {
                    r.uri
                        .to_file_path()
                        .map_err(|_| error("CONTENT_URI", "Invalid skill root."))
                        .and_then(|p| {
                            p.canonicalize()
                                .map_err(|e| error("CONTENT_UNAVAILABLE", e))
                        })
                })
                .transpose()?;
            let root_identity = root_path
                .as_deref()
                .map(crate::content_io::admitted::workspace_root_identity)
                .transpose()
                .map_err(|e| error("CONTENT_UNAVAILABLE", e))?;
            if let Some(root) = root {
                let canonical_uri = root_path
                    .as_ref()
                    .and_then(|p| Url::from_directory_path(p).ok());
                if canonical_uri.as_ref() != Some(&root.uri)
                    || root_identity.and_then(|i| i.observation_key()).as_ref()
                        != root.file_identity.as_ref()
                    || root.file_identity.is_none()
                {
                    return Err(error("CORRELATION", "Activated skill root was replaced."));
                }
            }
            // Keep the activated ancestor as well as the helper's immediate
            // parent: that same parent can be moved below a replaced root.
            let root_after_read = root_path.clone();
            let denial = Arc::new(Mutex::new(None));
            let admission_error = Arc::clone(&denial);
            let read = crate::content_io::admitted::read_file_bytes_with_admission(
                &path,
                &context.cancel,
                context.resource_owner.clone(),
                move |resolved| async move {
                    if let Some(root_path) = &root_path {
                        if !resolved.starts_with(root_path)
                            || crate::content_io::admitted::workspace_root_identity(root_path).ok()
                                != root_identity
                        {
                            *admission_error.lock().unwrap() = Some(error(
                                "PERMISSION",
                                "Skill resource escapes or changes its root.",
                            ));
                            return Err(
                                crate::content_io::admitted::ReadError::FilesystemInvalidPath {
                                    message: "Invalid skill resource root.".into(),
                                },
                            );
                        }
                    }
                    match context
                        .admit(ActionRequest::Read { path: logical }, base_effect)
                        .await
                    {
                        Ok(decision)
                            if decision.resolved_path.as_deref() == resolved.to_str()
                                && root_path
                                    .as_deref()
                                    .map(crate::content_io::admitted::workspace_root_identity)
                                    .transpose()
                                    .ok()
                                    .flatten()
                                    == root_identity =>
                        {
                            Ok(())
                        }
                        Ok(_) => {
                            *admission_error.lock().unwrap() = Some(error(
                                "CORRELATION",
                                "File target changed after policy resolution.",
                            ));
                            Err(
                                crate::content_io::admitted::ReadError::FilesystemInvalidPath {
                                    message: "Content target changed.".into(),
                                },
                            )
                        }
                        Err(e) => {
                            *admission_error.lock().unwrap() = Some(e);
                            Err(
                                crate::content_io::admitted::ReadError::FilesystemInvalidPath {
                                    message: "Content access denied.".into(),
                                },
                            )
                        }
                    }
                },
            )
            .await;
            let (bytes, resolved, parent_identity) = read.map_err(|e| {
                denial
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap_or_else(|| file_read_error(context.cancel.is_cancelled(), e))
            })?;
            if let Some(root) = root_after_read {
                if crate::content_io::admitted::workspace_root_identity(&root).ok() != root_identity
                {
                    return Err(error(
                        "CORRELATION",
                        "Activated skill root changed during resource read.",
                    ));
                }
            }
            let final_uri = Url::from_file_path(resolved)
                .map_err(|_| error("CONTENT_URI", "Cannot form file URI."))?
                .to_string();
            Ok((bytes, final_uri, None, parent_identity.observation_key()))
        }
        "http" | "https" => {
            let denial = Arc::new(Mutex::new(None));
            let admission_error = Arc::clone(&denial);
            let result = context
                .network
                .fetch(uri.clone(), &context.cancel, &mut |target, ip| {
                    let admission_error = Arc::clone(&admission_error);
                    let mut effect = base_effect.clone();
                    effect.target_uri = target.to_string();
                    effect.phase = if ip.is_some() {
                        ContentEffectPhase::NetworkConnect
                    } else {
                        ContentEffectPhase::NetworkDns
                    };
                    Box::pin(async move {
                        if root.is_some_and(|root| !within_root(&target, &root.uri)) {
                            *admission_error.lock().unwrap() =
                                Some(error("PERMISSION", "Skill redirect leaves its root."));
                            return Err("Skill redirect leaves its root.".to_owned());
                        }
                        let host = ip
                            .map(|v| v.to_string())
                            .or_else(|| target.host_str().map(str::to_owned))
                            .unwrap_or_default();
                        context
                            .admit(ActionRequest::Network { host }, effect)
                            .await
                            .map(|_| ())
                            .map_err(|e| {
                                *admission_error.lock().unwrap() = Some(e);
                                "Content network access denied.".to_owned()
                            })
                    })
                })
                .await;
            let response = result.map_err(|e| {
                denial
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap_or_else(|| error("CONTENT_UNAVAILABLE", e))
            })?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(response.body_base64)
                .map_err(|e| error("CONTENT_ENCODING", e))?;
            Ok((bytes, response.url, response.content_type, None))
        }
        _ => Err(error(
            "CONTENT_SCHEME",
            format!("Unsupported URI scheme: {}", uri.scheme()),
        )),
    }
}

pub async fn capture_result_file(
    context: &ContentContext,
    result_name: &str,
    uri: &str,
    media_type: &str,
) -> ContentResult<ResolvedContentReceipt> {
    absolute_uri(uri)?;
    if is_json(media_type) || is_text(media_type) || media_type.is_empty() {
        return Err(error(
            "CONTENT_FORMAT",
            "File result requires a non-text, non-JSON media type.",
        ));
    }
    let source_json = serde_json::json!({ "uri": uri, "mediaType": media_type }).to_string();
    resolve_content(
        context,
        ContentUse {
            source_json,
            usage: ContentUsage::Result,
            pointer: format!(
                "/results/{}",
                result_name.replace('~', "~0").replace('/', "~1")
            ),
        },
    )
    .await
}
