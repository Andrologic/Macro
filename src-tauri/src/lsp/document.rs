use super::error::LspError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use url::Url;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DocumentSnapshot {
    pub uri: String,
    pub language_id: String,
    pub version: i64,
    pub content: String,
    pub is_open: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DocumentEdit {
    pub start_byte: usize,
    pub end_byte: usize,
    pub text: String,
}

#[derive(Default)]
pub(crate) struct DocumentCache {
    documents: HashMap<String, DocumentSnapshot>,
}

impl DocumentCache {
    pub(crate) fn prepare_open(
        &self,
        uri: &str,
        language_id: String,
        version: i64,
        content: String,
    ) -> Result<DocumentSnapshot, LspError> {
        let uri = normalize_uri(uri)?;
        if language_id.trim().is_empty() {
            return Err(LspError::InvalidDocumentState {
                uri,
                message: "language id cannot be empty".to_string(),
            });
        }
        if let Some(current) = self.documents.get(&uri) {
            if current.is_open {
                return Err(LspError::InvalidDocumentState {
                    uri,
                    message: "document is already open".to_string(),
                });
            }
            ensure_newer_version(&uri, current.version, version)?;
        }
        Ok(DocumentSnapshot {
            uri,
            language_id,
            version,
            content,
            is_open: true,
        })
    }

    pub(crate) fn prepare_replace(
        &self,
        uri: &str,
        version: i64,
        content: String,
    ) -> Result<DocumentSnapshot, LspError> {
        let uri = normalize_uri(uri)?;
        let current = self.open_document(&uri)?;
        ensure_newer_version(&uri, current.version, version)?;
        Ok(DocumentSnapshot {
            uri,
            language_id: current.language_id.clone(),
            version,
            content,
            is_open: true,
        })
    }

    pub(crate) fn prepare_edits(
        &self,
        uri: &str,
        version: i64,
        edits: &[DocumentEdit],
    ) -> Result<DocumentSnapshot, LspError> {
        let uri = normalize_uri(uri)?;
        let current = self.open_document(&uri)?;
        ensure_newer_version(&uri, current.version, version)?;
        if edits.is_empty() {
            return Err(LspError::InvalidDocumentEdit {
                uri,
                message: "at least one edit is required".to_string(),
            });
        }
        let mut content = current.content.clone();
        for edit in edits {
            if edit.start_byte > edit.end_byte || edit.end_byte > content.len() {
                return Err(LspError::InvalidDocumentEdit {
                    uri,
                    message: format!(
                        "byte range {}..{} is outside content length {}",
                        edit.start_byte,
                        edit.end_byte,
                        content.len()
                    ),
                });
            }
            if !content.is_char_boundary(edit.start_byte)
                || !content.is_char_boundary(edit.end_byte)
            {
                return Err(LspError::InvalidDocumentEdit {
                    uri,
                    message: format!(
                        "byte range {}..{} splits a UTF-8 code point",
                        edit.start_byte, edit.end_byte
                    ),
                });
            }
            content.replace_range(edit.start_byte..edit.end_byte, &edit.text);
        }
        Ok(DocumentSnapshot {
            uri,
            language_id: current.language_id.clone(),
            version,
            content,
            is_open: true,
        })
    }

    pub(crate) fn prepare_close(&self, uri: &str) -> Result<DocumentSnapshot, LspError> {
        let uri = normalize_uri(uri)?;
        let current = self.open_document(&uri)?;
        let mut closed = current.clone();
        closed.is_open = false;
        Ok(closed)
    }

    pub(crate) fn commit(&mut self, document: DocumentSnapshot) {
        self.documents.insert(document.uri.clone(), document);
    }

    pub(crate) fn snapshot(&self, uri: &str) -> Result<Option<DocumentSnapshot>, LspError> {
        let uri = normalize_uri(uri)?;
        Ok(self.documents.get(&uri).cloned())
    }

    pub(crate) fn snapshots(&self) -> Vec<DocumentSnapshot> {
        let mut snapshots = self.documents.values().cloned().collect::<Vec<_>>();
        snapshots.sort_by(|left, right| left.uri.cmp(&right.uri));
        snapshots
    }

    fn open_document(&self, uri: &str) -> Result<&DocumentSnapshot, LspError> {
        match self.documents.get(uri) {
            Some(document) if document.is_open => Ok(document),
            Some(_) => Err(LspError::InvalidDocumentState {
                uri: uri.to_string(),
                message: "document is closed".to_string(),
            }),
            None => Err(LspError::InvalidDocumentState {
                uri: uri.to_string(),
                message: "document is not tracked".to_string(),
            }),
        }
    }
}

fn normalize_uri(uri: &str) -> Result<String, LspError> {
    let parsed = Url::parse(uri).map_err(|error| LspError::InvalidDocumentUri {
        uri: uri.to_string(),
        message: error.to_string(),
    })?;
    if parsed.cannot_be_a_base() {
        return Err(LspError::InvalidDocumentUri {
            uri: uri.to_string(),
            message: "URI must be hierarchical".to_string(),
        });
    }
    Ok(parsed.to_string())
}

fn ensure_newer_version(uri: &str, current: i64, received: i64) -> Result<(), LspError> {
    if received <= current {
        return Err(LspError::StaleDocumentVersion {
            uri: uri.to_string(),
            current,
            received,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{DocumentCache, DocumentEdit};
    use crate::lsp::LspError;

    #[test]
    fn transitions_are_atomic_and_versions_increase() {
        let mut cache = DocumentCache::default();
        let opened = cache
            .prepare_open(
                "file:///tmp/../tmp/example.rs",
                "rust".to_string(),
                1,
                "let café = 1;".to_string(),
            )
            .unwrap();
        cache.commit(opened.clone());
        assert_eq!(opened.uri, "file:///tmp/example.rs");

        let stale = cache.prepare_replace(&opened.uri, 1, "stale".to_string());
        assert!(matches!(stale, Err(LspError::StaleDocumentVersion { .. })));
        assert_eq!(
            cache.snapshot(&opened.uri).unwrap().unwrap().content,
            "let café = 1;"
        );

        let edited = cache
            .prepare_edits(
                &opened.uri,
                2,
                &[DocumentEdit {
                    start_byte: 4,
                    end_byte: 9,
                    text: "thé".to_string(),
                }],
            )
            .unwrap();
        cache.commit(edited);
        assert_eq!(
            cache.snapshot(&opened.uri).unwrap().unwrap().content,
            "let thé = 1;"
        );

        let closed = cache.prepare_close(&opened.uri).unwrap();
        cache.commit(closed);
        assert!(!cache.snapshot(&opened.uri).unwrap().unwrap().is_open);
    }
}
