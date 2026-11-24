use super::*;
use crate::db::architect_library::storage_index::Artifact;
use crate::secrets::archive_mcp::LegacyArchiveMcpKey;
use sqlx::Row;

impl VersionInput {
    pub(super) fn legacy_secret_key(
        &self,
        server: &str,
        name: &str,
    ) -> Result<LegacyArchiveMcpKey> {
        let digest = Sha256::digest(serde_json::to_vec(&(
            &self.key.blueprint_id,
            &self.origin,
            server,
            name,
        ))?);
        Ok(LegacyArchiveMcpKey::from_digest(digest.into()))
    }
}

#[derive(PartialEq, Eq)]
enum Destination {
    Stdio([u8; 32]),
    Http(String, &'static str, String),
}

impl Destination {
    fn historical(archive: &VersionArchive, server: &McpServer, name: &str) -> Option<Self> {
        match &server.transport {
            McpTransport::Local { command } => {
                mcp::stdio_fingerprint(archive, command, &server.packaged_files).map(Self::Stdio)
            }
            McpTransport::Remote { url } => {
                let url = url::Url::parse(url).ok()?;
                if !matches!(url.scheme(), "http" | "https") {
                    return None;
                }
                let origin = url.origin().ascii_serialization();
                // This was the host's implicit delivery before explicit configuration.
                if name == "TOKEN" || name.ends_with("_TOKEN") {
                    Some(Self::Http(origin, "bearer", "authorization".into()))
                } else {
                    let header = reqwest::header::HeaderName::from_bytes(name.as_bytes()).ok()?;
                    Some(Self::Http(origin, "header", header.as_str().into()))
                }
            }
        }
    }

    fn matches_launch(&self, launch: &mcp::LaunchMcp, server: &str, name: &str) -> bool {
        match self {
            Self::Stdio(fingerprint) => launch.stdio.get(server) == Some(fingerprint),
            Self::Http(origin, mode, header) => launch
                .remote
                .get(server)
                .and_then(|grant| grant.credential_binding(name))
                .is_some_and(|(current_origin, current_mode, current_header)| {
                    current_origin == *origin && current_mode == *mode && current_header == *header
                }),
        }
    }
}

struct Candidate {
    row: usize,
    old: LegacyArchiveMcpKey,
    new: ArchiveMcpKey,
    destination: Destination,
}

async fn reconcile_history(
    pool: &SqlitePool,
    storage: &Storage,
    input: &VersionInput,
    requirements: &[SecretRequirement],
    candidates: &mut Vec<Candidate>,
) -> Option<()> {
    // The legacy key omitted version, transport and URL. A deleted or
    // unreadable version may have been where the value was entered.
    // The admitted input already holds the shared library lease.
    let versions = sqlx::query(
        "SELECT v.blueprint_id, v.number, v.artifact_id, v.storage_state,
                v.archive_sha256, b.last_number
         FROM architect_versions v
         JOIN architect_blueprints b ON b.id=v.blueprint_id
         WHERE v.blueprint_id=? ORDER BY v.number",
    )
    .bind(&input.key.blueprint_id)
    .fetch_all(pool)
    .await
    .ok()?;
    let last: i64 = versions.first()?.try_get("last_number").ok()?;
    if usize::try_from(last).ok()? != versions.len() {
        return None;
    }
    for (offset, version) in versions.iter().enumerate() {
        let number: i64 = version.try_get("number").ok()?;
        if usize::try_from(number).ok()? != offset + 1 {
            return None;
        }
        if number == input.key.number {
            continue;
        }
        let artifact = Artifact::from_row(version, "blueprint_id").ok()?;
        let archive = storage.open_archive(&artifact).ok()?;
        let preview =
            preview::inspect(archive.source(), ARCHIVE_FORMAT, artifact.sha256?, false).ok()?;
        candidates.retain(|candidate| {
            let requirement = &requirements[candidate.row];
            preview
                .mcp_servers
                .get(&requirement.server)
                .filter(|server| server.required_secrets.contains(&requirement.name))
                .is_none_or(|server| {
                    Destination::historical(&archive, server, &requirement.name).as_ref()
                        == Some(&candidate.destination)
                })
        });
        if candidates.is_empty() {
            break;
        }
    }
    Some(())
}

pub(super) async fn secret_requirements(
    pool: &SqlitePool,
    storage: &Storage,
    input: &VersionInput,
    launch_mcp: &mcp::LaunchMcp,
) -> Result<Vec<SecretRequirement>> {
    let mut requirements = Vec::new();
    let mut pending = Vec::new();
    for (server, names) in &launch_mcp.secrets {
        let remote = launch_mcp.remote.get(server);
        for name in names {
            let key = input.secret_id(server, name, launch_mcp)?;
            let stored = archive_mcp::get(&key)
                .map_err(|_| vault_error())?
                .is_some_and(|value| mcp::valid_secret(&value, remote.is_some()));
            let mut legacy_reset_required = false;
            if !stored {
                let old = input.legacy_secret_key(server, name)?;
                legacy_reset_required = archive_mcp::has_legacy(&old).map_err(|_| vault_error())?;
                if legacy_reset_required {
                    pending.push((requirements.len(), old, key));
                }
            }
            requirements.push(SecretRequirement {
                server: server.clone(),
                name: name.clone(),
                stored,
                legacy_reset_required,
            });
        }
    }
    if pending.is_empty() {
        return Ok(requirements);
    }

    let preview = input.preview()?;
    let mut candidates = pending
        .into_iter()
        .filter_map(|(row, old, new)| {
            let requirement = &requirements[row];
            let server = preview.mcp_servers.get(&requirement.server)?;
            let destination = Destination::historical(&input.archive, server, &requirement.name)?;
            destination
                .matches_launch(launch_mcp, &requirement.server, &requirement.name)
                .then_some(Candidate {
                    row,
                    old,
                    new,
                    destination,
                })
        })
        .collect::<Vec<_>>();
    if !candidates.is_empty()
        && reconcile_history(pool, storage, input, &requirements, &mut candidates)
            .await
            .is_some()
    {
        for candidate in candidates {
            let requirement = &mut requirements[candidate.row];
            let remote = launch_mcp.remote.contains_key(&requirement.server);
            requirement.stored =
                archive_mcp::reassociate_legacy(&candidate.old, &candidate.new, |value| {
                    mcp::valid_secret(value, remote)
                })
                .map_err(|_| vault_error())?;
            requirement.legacy_reset_required = !requirement.stored;
        }
    }
    Ok(requirements)
}
