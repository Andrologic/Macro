use super::{project, Error, Result};
use crate::db::architect_library::{upgrade_draft, Document};
use argentic_runtime::source::OpenedSource;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use unicase::UniCase;
use unicode_general_category::{get_general_category, GeneralCategory};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MacroSettings {
    schema_version: u32,
    pub(super) hidden_agent_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) entry_message_hint: Option<String>,
    working_folder_mode: WorkingFolderMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_fields: Option<Value>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum WorkingFolderMode {
    #[default]
    PerExecution,
    AtLaunch,
}

impl Default for MacroSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            hidden_agent_ids: Vec::new(),
            entry_message_hint: None,
            working_folder_mode: WorkingFolderMode::PerExecution,
            launch_fields: None,
        }
    }
}

impl MacroSettings {
    pub(crate) fn check_schema(&self) -> Result<()> {
        if self.schema_version == 1 {
            Ok(())
        } else {
            Err(Error::Storage("Unsupported Macro settings schema".into()))
        }
    }

    fn from_authoring(metadata: &mut BTreeMap<String, Value>) -> Self {
        fn take<T: serde::de::DeserializeOwned>(
            metadata: &mut BTreeMap<String, Value>,
            key: &str,
        ) -> Option<T> {
            let value = serde_json::from_value(metadata.get(key)?.clone()).ok()?;
            metadata.remove(key);
            Some(value)
        }
        Self {
            hidden_agent_ids: take(metadata, "hiddenAgentIds").unwrap_or_default(),
            entry_message_hint: take(metadata, "entryMessageHint"),
            working_folder_mode: take(metadata, "workingFolderMode").unwrap_or_default(),
            launch_fields: metadata.remove("launchFields"),
            ..Self::default()
        }
    }

    fn for_editor(&self, metadata: &mut BTreeMap<String, Value>) {
        if !self.hidden_agent_ids.is_empty() {
            metadata.insert("hiddenAgentIds".into(), json!(self.hidden_agent_ids));
        }
        if let Some(hint) = &self.entry_message_hint {
            metadata.insert("entryMessageHint".into(), json!(hint));
        }
        if self.working_folder_mode != WorkingFolderMode::PerExecution {
            metadata.insert("workingFolderMode".into(), json!(self.working_folder_mode));
        }
        if let Some(fields) = &self.launch_fields {
            metadata.insert("launchFields".into(), fields.clone());
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(super) struct Authoring {
    metadata: BTreeMap<String, Value>,
    annex_paths: BTreeMap<String, String>,
    // The current editor still needs opaque annex keys. They never enter the package.
    private_annexes: BTreeMap<String, String>,
    // A version carries unselected files here so local adaptation can recover them.
    unselected_files: BTreeMap<String, String>,
    fallback_source: Option<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub(super) executable_paths: BTreeSet<String>,
    pub(super) diagnostics: Vec<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub(super) unresolved_resources: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub(super) unresolved_skill_files: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    repair_candidates: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    restored_skill_files: BTreeMap<String, String>,
}

impl Authoring {
    pub(super) fn forget_file(&mut self, path: &str) {
        self.annex_paths.retain(|_, annex_path| annex_path != path);
        self.executable_paths.remove(path);
        self.repair_candidates.remove(path);
        self.restored_skill_files.retain(|missing, replacement| {
            if replacement != path {
                return true;
            }
            self.unresolved_skill_files.insert(missing.clone());
            self.diagnostics
                .push(format!("Missing declared skill resource {missing}"));
            false
        });
    }

    pub(super) fn merge_diagnostics(&mut self, diagnostics: &[String]) {
        for entry in diagnostics {
            if !self.diagnostics.contains(entry) {
                self.diagnostics.push(entry.clone());
            }
        }
    }

    pub(super) fn clear_fallback(&mut self) {
        self.fallback_source = None;
    }

    pub(super) fn has_fallback(&self) -> bool {
        self.fallback_source.is_some()
    }

    pub(super) fn restore_migration_guards(&mut self) {
        for diagnostic in &self.diagnostics {
            if let Some(path) = diagnostic.strip_prefix("Missing declared resource ") {
                self.unresolved_resources.insert(path.into());
            }
            if let Some(path) = diagnostic.strip_prefix("Missing declared skill resource ") {
                self.unresolved_skill_files.insert(path.into());
            }
        }
    }

    pub(super) fn has_unresolved_resources(&self) -> bool {
        !self.unresolved_resources.is_empty() || !self.unresolved_skill_files.is_empty()
    }

    pub(super) fn resolve_resource(&mut self, path: &str) -> bool {
        let resolved =
            self.unresolved_resources.remove(path) | self.unresolved_skill_files.remove(path);
        if resolved {
            self.diagnostics.retain(|message| {
                message.strip_prefix("Missing declared resource ") != Some(path)
                    && message.strip_prefix("Missing declared skill resource ") != Some(path)
            });
        }
        resolved
    }

    pub(super) fn record_repair_candidates(&mut self, added_paths: BTreeSet<String>) {
        if self.has_unresolved_resources() {
            self.repair_candidates.extend(added_paths);
        } else {
            self.repair_candidates.clear();
        }
    }

    pub(super) fn accept_restored_files(&mut self, source: &OpenedSource) -> Result<()> {
        if self.repair_candidates.is_empty() {
            return Ok(());
        }
        for member in project::members(source)? {
            if !self.repair_candidates.contains(member.path) {
                continue;
            }
            if self.unresolved_resources.contains(member.path) {
                self.resolve_resource(member.path);
                self.repair_candidates.remove(member.path);
                continue;
            }
            let Some((directory, _)) = member.path.rsplit_once('/') else {
                continue;
            };
            let restored = self
                .unresolved_skill_files
                .iter()
                .find(|path| {
                    path.rsplit_once('/').is_some_and(|(old_directory, _)| {
                        path_key(directory) == path_key(old_directory)
                            && self
                                .private_annexes
                                .get(*path)
                                .is_some_and(|text| text.as_bytes() == member.bytes)
                    })
                })
                .cloned();
            // A new file can replace only one missing member.
            if let Some(path) = restored {
                self.resolve_resource(&path);
                self.repair_candidates.remove(member.path);
                self.restored_skill_files
                    .insert(path, member.path.to_owned());
            }
        }
        if !self.has_unresolved_resources() {
            self.repair_candidates.clear();
        }
        Ok(())
    }

    pub(super) fn project_diagnostics(&self) -> impl Iterator<Item = super::Diagnostic> + '_ {
        self.diagnostics.iter().map(|message| {
            let mut diagnostic = super::Diagnostic::migration(message.clone());
            let file = message
                .strip_prefix("Missing declared resource ")
                .filter(|path| self.unresolved_resources.contains(*path))
                .or_else(|| {
                    message
                        .strip_prefix("Missing declared skill resource ")
                        .filter(|path| self.unresolved_skill_files.contains(*path))
                });
            if let Some(path) = file {
                diagnostic.code = "MIGRATION_RESOURCE".into();
                diagnostic.file = Some(path.into());
            }
            diagnostic
        })
    }

    pub(super) fn set_fallback(&mut self, source: String) {
        self.fallback_source = Some(source);
    }

    pub(super) fn project_document(
        &self,
        settings: &MacroSettings,
        root: &Path,
        source: Option<&OpenedSource>,
    ) -> Result<Document> {
        let mut annexes = self.private_annexes.clone();
        for (key, path) in &self.annex_paths {
            if !portable_path(path) {
                return Err(Error::Storage("Invalid stored annex path".into()));
            }
            let target = root.join(path);
            super::storage::require_dir(root, target.parent().ok_or(Error::InvalidDestination)?)?;
            let bytes = super::storage::read_file(&target)?;
            annexes.insert(
                key.clone(),
                String::from_utf8(bytes).map_err(std::io::Error::other)?,
            );
        }
        self.document(settings, annexes, source)
    }

    pub(super) fn archive_document(
        &self,
        settings: &MacroSettings,
        source: &OpenedSource,
    ) -> Result<Document> {
        let members: BTreeMap<_, _> = project::members(source)?
            .map(|file| (file.path, file.bytes))
            .collect();
        let mut annexes = self.private_annexes.clone();
        for (key, path) in &self.annex_paths {
            let text = if let Some(text) = self.unselected_files.get(path) {
                text.clone()
            } else {
                let bytes = members.get(path.as_str()).ok_or_else(|| {
                    Error::Storage(format!("Stored archive is missing annex {path}"))
                })?;
                std::str::from_utf8(bytes)
                    .map_err(std::io::Error::other)?
                    .to_owned()
            };
            annexes.insert(key.clone(), text);
        }
        self.document(settings, annexes, Some(source))
    }

    fn document(
        &self,
        settings: &MacroSettings,
        annexes: BTreeMap<String, String>,
        source: Option<&OpenedSource>,
    ) -> Result<Document> {
        let mut metadata = self.metadata.clone();
        settings.for_editor(&mut metadata);
        let source = if let Some(source) = source {
            source.authored_json().to_owned()
        } else {
            self.fallback_source
                .clone()
                .ok_or_else(|| Error::Storage("Incomplete project has no editor source".into()))?
        };
        Ok(Document {
            source,
            annexes,
            metadata,
        })
    }

    pub(super) fn for_version(&self, root: &Path, source: &OpenedSource) -> Result<Self> {
        let selected: BTreeSet<_> = project::members(source)?.map(|file| file.path).collect();
        let mut authoring = self.clone();
        authoring.executable_paths = project::members(source)?
            .filter(|file| file.executable || self.executable_paths.contains(file.path))
            .map(|file| file.path.to_owned())
            .collect();
        authoring.fallback_source = None;
        authoring.restored_skill_files.clear();
        for path in self.annex_paths.values() {
            if !selected.contains(path.as_str()) {
                let target = root.join(path);
                super::storage::require_dir(
                    root,
                    target.parent().ok_or(Error::InvalidDestination)?,
                )?;
                let bytes = super::storage::read_file(&target)?;
                authoring.unselected_files.insert(
                    path.clone(),
                    String::from_utf8(bytes).map_err(std::io::Error::other)?,
                );
            }
        }
        Ok(authoring)
    }

    pub(super) fn restore_unselected(mut self, root: &Path) -> Result<Self> {
        for (path, text) in std::mem::take(&mut self.unselected_files) {
            if !portable_path(&path) {
                return Err(Error::Storage("Invalid stored annex path".into()));
            }
            super::storage::write_project_file(root, &path, text.as_bytes())?;
        }
        Ok(self)
    }
}

pub(super) struct Split {
    pub settings: MacroSettings,
    pub authoring: Authoring,
    pub files: BTreeMap<String, Vec<u8>>,
    pub normalized: Value,
    pub resources_complete: bool,
    pub upgraded: bool,
    pub source: String,
}

impl Split {
    pub(super) fn paths(&self) -> impl Iterator<Item = &String> {
        self.files
            .keys()
            .chain(self.authoring.unresolved_resources.iter())
    }

    pub(super) fn inherit_executables(&mut self, paths: BTreeSet<String>) {
        self.authoring.executable_paths = paths
            .into_iter()
            .filter(|path| self.files.contains_key(path))
            .collect();
    }
}

const SECTIONS: &[(&str, &str)] = &[
    ("agents", "agents"),
    ("compositions", "compositions"),
    ("content", "content"),
    ("skills", "skills"),
    ("mcpServers", "mcp"),
];

pub(super) fn split(mut document: Document) -> std::result::Result<Split, String> {
    let upgraded = upgrade_draft(document.clone()).map_err(|e| e.to_string())?;
    let upgraded_source = upgraded.is_some();
    if let Some(upgraded) = upgraded {
        document = upgraded;
    }
    let mut normalized =
        argentic_core::durable_json::value(&document.source).map_err(|error| error.to_string())?;
    let manifest = normalized
        .as_object_mut()
        .ok_or("Expected an AgSDL object")?;
    if manifest.get("contract").and_then(Value::as_str) != Some(argentic_core::AGSDL_040)
        || ["projectFormat", "settingsFiles", "secrets", "mcpFiles"]
            .iter()
            .any(|key| manifest.contains_key(*key))
    {
        return Err("Expected an AgSDL 0.4 document".into());
    }

    let mut declared = BTreeSet::new();
    let mut diagnostics = Vec::new();
    visit_resources(manifest, |uri| {
        if let Some((path, suffix)) = local_uri(uri) {
            declared.insert(path.clone());
            *uri = json!(format!("{}{suffix}", encoded_path(&path)));
        } else if uri.as_str().is_some_and(is_local_uri) {
            diagnostics.push(format!("Invalid relative resource URI {}", uri));
        }
    });

    let skill_dirs: BTreeSet<_> = manifest
        .get("skills")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|skills| skills.values())
        .filter_map(|skill| local_uri(skill.get("uri")?))
        .filter_map(|(path, _)| path.rsplit_once('/').map(|(dir, _)| path_key(dir)))
        .collect();
    let mut authoring = Authoring {
        metadata: document.metadata,
        diagnostics,
        ..Authoring::default()
    };
    let settings = MacroSettings::from_authoring(&mut authoring.metadata);
    let authored_roots: BTreeSet<_> = document
        .annexes
        .keys()
        .chain(declared.iter())
        .filter(|path| portable_path(path))
        .map(|path| path_key(path.split('/').next().unwrap()))
        .collect();
    let mut registry = Paths::default();
    registry.reserve(project::MANIFEST);
    let mut files = BTreeMap::new();
    let mut annexes: Vec<_> = document.annexes.into_iter().collect();
    annexes.sort_by_key(|(name, _)| !declared.contains(name));
    let mut resources_complete = true;
    for (name, text) in annexes {
        if portable_path(&name) && registry.reserve(&name) {
            files.insert(name.clone(), text.into_bytes());
            authoring.annex_paths.insert(name.clone(), name);
        } else {
            if name
                .match_indices('/')
                .any(|(end, _)| skill_dirs.contains(&path_key(&name[..end])))
            {
                resources_complete = false;
                authoring.unresolved_skill_files.insert(name.clone());
                authoring
                    .diagnostics
                    .push(format!("Missing declared skill resource {name}"));
            } else {
                authoring
                    .diagnostics
                    .push(format!("Annex kept privately: {name}"));
            }
            authoring.private_annexes.insert(name, text);
        }
    }

    for missing in declared
        .iter()
        .filter(|path| !authoring.annex_paths.contains_key(*path))
    {
        authoring.unresolved_resources.insert(missing.clone());
        authoring
            .diagnostics
            .push(format!("Missing declared resource {missing}"));
        resources_complete = false;
    }

    let mut manifest = manifest.clone();
    manifest.insert("projectFormat".into(), json!(project::PROJECT_FORMAT));
    let mut settings_files = Map::new();
    for &(key, folder) in SECTIONS {
        if let Some(components) = manifest.get_mut(key).and_then(Value::as_object_mut) {
            for (name, component) in components {
                if !component.is_object() {
                    continue;
                }
                if key == "agents"
                    && component
                        .get("harnessSettings")
                        .is_some_and(Value::is_object)
                {
                    let settings = component
                        .as_object_mut()
                        .unwrap()
                        .remove("harnessSettings")
                        .unwrap();
                    let file = add_component(
                        &mut registry,
                        &mut files,
                        &authored_roots,
                        "settings",
                        name,
                        &settings,
                    )?;
                    settings_files.insert(name.clone(), json!(file));
                }
                rebase_component(key, component, &mut rebase);
                let file = add_component(
                    &mut registry,
                    &mut files,
                    &authored_roots,
                    folder,
                    name,
                    component,
                )?;
                *component = json!({ "file": file });
            }
        }
    }
    if !settings_files.is_empty() {
        manifest.insert("settingsFiles".into(), json!(settings_files));
    }
    if let Some(flow) = manifest.get_mut("flow").filter(|flow| flow.is_object()) {
        rebase_component("flow", flow, &mut rebase);
        let file = add_component(
            &mut registry,
            &mut files,
            &authored_roots,
            "flows",
            "flow",
            flow,
        )?;
        *flow = json!({ "file": file });
    }
    files.insert(
        project::MANIFEST.into(),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    );
    // Argentic keeps the schema hint on disk but omits it from the assembled document.
    normalized
        .as_object_mut()
        .expect("object checked above")
        .remove("$schema");
    Ok(Split {
        settings,
        authoring,
        files,
        normalized,
        resources_complete,
        upgraded: upgraded_source,
        source: document.source,
    })
}

fn add_component(
    registry: &mut Paths,
    files: &mut BTreeMap<String, Vec<u8>>,
    authored_roots: &BTreeSet<String>,
    directory: &str,
    name: &str,
    value: &Value,
) -> std::result::Result<String, String> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(name.as_bytes());
    let file = (0..)
        .map(|n| {
            if n == 0 {
                format!("{directory}/{digest:x}.json")
            } else {
                format!("{directory}-{n}/{digest:x}.json")
            }
        })
        .find(|file| {
            let root = file.split('/').next().unwrap();
            !authored_roots.contains(root) && registry.reserve(file)
        })
        .expect("finite authored paths");
    files.insert(
        file.clone(),
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    );
    Ok(file)
}

fn visit_resources(manifest: &mut Map<String, Value>, visit: impl FnMut(&mut Value)) {
    let mut visit = visit;
    for &(key, _) in SECTIONS {
        if let Some(components) = manifest.get_mut(key).and_then(Value::as_object_mut) {
            for component in components.values_mut() {
                rebase_component(key, component, &mut visit);
            }
        }
    }
    if let Some(flow) = manifest.get_mut("flow") {
        rebase_component("flow", flow, &mut visit);
    }
}

fn rebase_component(kind: &str, component: &mut Value, visit: &mut impl FnMut(&mut Value)) {
    match kind {
        "content" | "skills" => visit_uri(component, visit),
        "agents" => visit_message(component, "instructions", visit),
        "flow" | "compositions" => {
            visit_step(component, visit);
            if let Some(steps) = component.get_mut("steps").and_then(Value::as_object_mut) {
                for step in steps.values_mut() {
                    visit_step(step, visit);
                }
            }
        }
        _ => {}
    }
}

fn visit_uri(source: &mut Value, visit: &mut impl FnMut(&mut Value)) {
    if let Some(uri) = source.get_mut("uri").filter(|uri| uri.is_string()) {
        visit(uri);
    }
}

fn visit_message(message: &mut Value, key: &str, visit: &mut impl FnMut(&mut Value)) {
    if let Some(sources) = message.get_mut(key).and_then(Value::as_array_mut) {
        for source in sources {
            visit_uri(source, visit);
        }
    }
    if let Some(resources) = message.get_mut("resources").and_then(Value::as_object_mut) {
        for source in resources.values_mut() {
            visit_uri(source, visit);
        }
    }
}

fn visit_step(step: &mut Value, visit: &mut impl FnMut(&mut Value)) {
    fn route(value: &mut Value, visit: &mut impl FnMut(&mut Value)) {
        let mut target = |target: &mut Value| {
            if let Some(message) = target.get_mut("message") {
                visit_message(message, "prompt", visit);
            }
        };
        if let Some(items) = value.as_array_mut() {
            items.iter_mut().for_each(target);
        } else {
            target(value);
        }
    }
    visit_message(step, "prompt", visit);
    if let Some(next) = step.get_mut("next") {
        if next.is_object() && next.get("step").is_none() && next.get("output").is_none() {
            for branch in next.as_object_mut().unwrap().values_mut() {
                route(branch, visit);
            }
        } else {
            route(next, visit);
        }
    }
    if let Some(on_error) = step.get_mut("onError") {
        route(on_error, visit);
    }
}

fn is_local_uri(uri: &str) -> bool {
    !uri.split_once(':').is_some_and(|(scheme, _)| {
        scheme.starts_with(|ch: char| ch.is_ascii_alphabetic())
            && scheme
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b))
    })
}

fn local_uri(uri: &Value) -> Option<(String, &str)> {
    let uri = uri.as_str().filter(|uri| is_local_uri(uri))?;
    let split = uri.find(['?', '#']).unwrap_or(uri.len());
    let decoded = percent_decode_str(&uri[..split]).decode_utf8().ok()?;
    if decoded.is_empty()
        || decoded.starts_with('/')
        || decoded.len() > 4096
        || decoded.split('/').count() > 64
    {
        return None;
    }
    let mut normalized = Vec::new();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                normalized.pop()?;
            }
            part if portable_path(part) => normalized.push(part),
            _ => return None,
        }
    }
    let path = normalized.join("/");
    portable_path(&path).then_some((path, &uri[split..]))
}

fn encoded_path(path: &str) -> String {
    const PATH: percent_encoding::AsciiSet = NON_ALPHANUMERIC
        .remove(b'/')
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~');
    utf8_percent_encode(path, &PATH).to_string()
}

fn rebase(uri: &mut Value) {
    if let Some((path, suffix)) = local_uri(uri) {
        *uri = json!(format!("../{}{suffix}", encoded_path(&path)));
    }
}

pub(crate) fn path_key(path: &str) -> String {
    UniCase::new(path).to_folded_case().nfc().collect()
}

// Mirrors the member-name restrictions in Argentic's source/archive.rs
// (AGPL-3.0-or-later). Argentic independently verifies selected members.
pub(crate) fn portable_path(path: &str) -> bool {
    path.len() <= 4096
        && path.split('/').count() <= 64
        && path.split('/').all(|part| {
            let folded = UniCase::new(part).to_folded_case();
            let stem: String = part
                .split('.')
                .next()
                .unwrap_or("")
                .trim_end_matches(' ')
                .chars()
                .map(|c| match c {
                    '\u{130}' | '\u{131}' => 'i',
                    c => c.to_ascii_lowercase(),
                })
                .collect();
            let reserved = matches!(
                stem.as_str(),
                "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
            ) || stem
                .strip_prefix("com")
                .or_else(|| stem.strip_prefix("lpt"))
                .is_some_and(|number| {
                    matches!(
                        number,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                });
            !part.is_empty()
                && part.len() <= 255
                && !part.ends_with([' ', '.'])
                && !reserved
                && !matches!(folded.as_str(), ".git" | ".env" | ".agsdl-history.bundle")
                && !folded.starts_with(".env.")
                && !part.chars().any(|c| {
                    "<>:\"\\|?*".contains(c)
                        || matches!(
                            get_general_category(c),
                            GeneralCategory::Control
                                | GeneralCategory::Format
                                | GeneralCategory::PrivateUse
                                | GeneralCategory::Surrogate
                                | GeneralCategory::Unassigned
                        )
                })
        })
}

#[derive(Default)]
pub(crate) struct Paths(BTreeMap<String, (String, bool)>);

impl Paths {
    /// Record files and all parent directory spellings. Even directory aliases
    /// need to be resolved consistently on a case-insensitive filesystem.
    pub(crate) fn reserve(&mut self, filename: &str) -> bool {
        let entries: Vec<_> = filename
            .match_indices('/')
            .map(|(end, _)| (&filename[..end], false))
            .chain(std::iter::once((filename, true)))
            .map(|(name, file)| (path_key(name), name, file))
            .collect();
        if entries.iter().any(|(key, name, file)| {
            self.0
                .get(key)
                .is_some_and(|(existing, is_file)| existing != name || *is_file || *file)
        }) {
            return false;
        }
        self.0.extend(
            entries
                .into_iter()
                .map(|(key, name, file)| (key, (name.into(), file))),
        );
        true
    }
}
