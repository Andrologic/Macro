use super::artifacts::{insert, verify_imports, Artifacts};
use std::any::{type_name, TypeId};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use ts_rs::{Config, TypeVisitor, TS};

struct Entry {
    origin: &'static str,
    path: String,
    families: BTreeSet<String>,
    contents: Vec<u8>,
}

pub struct Registry {
    config: Config,
    ipc: bool,
    entries: BTreeMap<String, Entry>,
    seen: HashSet<(TypeId, String)>,
    roots: Vec<String>,
}

impl Registry {
    pub fn new(ipc: bool) -> Self {
        // Do not read TS_RS_* environment variables. Output must be reproducible.
        let config = Config::default().with_out_dir("bindings");
        Self {
            ipc,
            config: if ipc {
                config.with_large_int("number")
            } else {
                config
            },
            entries: BTreeMap::new(),
            seen: HashSet::new(),
            roots: Vec::new(),
        }
    }

    pub fn add<T: TS + 'static>(&mut self, family: &str) -> Result<(), String> {
        if family.is_empty()
            || !family
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(format!("Invalid contract family: {family}"));
        }
        let name = T::ident(&self.config);
        if !self.roots.contains(&name) {
            self.roots.push(name);
        }
        self.collect::<T>(family)
    }

    fn collect<T: TS + ?Sized + 'static>(&mut self, family: &str) -> Result<(), String> {
        if T::output_path().is_none()
            || !self
                .seen
                .insert((TypeId::of::<T::WithoutGenerics>(), family.to_owned()))
        {
            return Ok(());
        }
        let name = T::ident(&self.config);
        let origin = type_name::<T::WithoutGenerics>();
        if name.eq_ignore_ascii_case("index")
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
            || name.is_empty()
        {
            return Err(format!("Unsupported type name {name} from {origin}"));
        }
        if let Some((previous_name, previous)) = self
            .entries
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(&name))
        {
            if previous.origin != origin || previous_name != &name {
                return Err(format!(
                    "Type collision {name}: {} versus {origin} (family {family})",
                    previous.origin
                ));
            }
        }
        let path = T::output_path().expect("exportable type");
        // Existing config derives include a legacy path relative to Cargo's bindings
        // directory. The shared generator owns the output root, as the old helper did.
        let path = if !self.ipc {
            path.strip_prefix("../../src/types/generated/config")
                .map(std::path::Path::to_path_buf)
                .unwrap_or(path)
        } else {
            path
        };
        if path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(format!("Non-portable export path for {name} from {origin}"));
        }
        let path = path
            .to_str()
            .ok_or("Non-UTF8 export path")?
            .replace('\\', "/");
        if !path.ends_with(&format!("{name}.ts")) || path.split('/').any(|part| part.contains(':'))
        {
            return Err(format!(
                "Unsupported export path {path} for {name} from {origin}"
            ));
        }
        if let Some(previous) = self
            .entries
            .values()
            .find(|entry| entry.path.eq_ignore_ascii_case(&path) && entry.origin != origin)
        {
            return Err(format!(
                "Output collision {path}: {} versus {origin}",
                previous.origin
            ));
        }
        let contents =
            T::export_to_string(&self.config).map_err(|error| format!("{origin}: {error}"))?;
        // Documented fields emitted by ts-rs can leave trailing spaces. Keep IPC
        // artifacts compatible with repository hooks, preserving config bytes.
        let contents = if self.ipc {
            contents
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            contents
        }
        .into_bytes();
        self.entries
            .entry(name)
            .or_insert_with(|| Entry {
                origin,
                path,
                families: BTreeSet::new(),
                contents,
            })
            .families
            .insert(family.to_owned());
        let mut visitor = Visitor {
            registry: self,
            family,
            error: None,
        };
        // ts-rs emits imports for WithoutGenerics, so visit the same graph.
        T::WithoutGenerics::visit_dependencies(&mut visitor);
        visitor.error.map_or(Ok(()), Err)
    }

    pub fn artifacts(&self, ipc: bool) -> Result<Artifacts, String> {
        let mut files = Artifacts::new();
        for entry in self.entries.values() {
            insert(&mut files, entry.path.clone(), entry.contents.clone());
        }
        verify_imports(&files)?;
        let names: Vec<_> = if ipc {
            self.entries.keys().collect()
        } else {
            // Preserve the historical configuration barrel byte for byte.
            self.roots
                .iter()
                .chain(
                    self.entries
                        .keys()
                        .filter(|name| !self.roots.contains(name)),
                )
                .collect()
        };
        let index = names
            .iter()
            .map(|name| {
                format!(
                    "export type {{ {name} }} from './{}';",
                    self.entries[*name].path.trim_end_matches(".ts")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        insert(&mut files, "index.ts".into(), index.into_bytes());
        if ipc {
            let families: BTreeSet<_> = self
                .entries
                .values()
                .flat_map(|entry| entry.families.iter())
                .collect();
            for family in families {
                let exports = self
                    .entries
                    .iter()
                    .filter(|(_, entry)| entry.families.contains(family))
                    .map(|(name, entry)| {
                        format!(
                            "export type {{ {name} }} from '../{}';",
                            entry.path.trim_end_matches(".ts")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let path = format!("{family}/index.ts");
                if files.contains_key(&path) {
                    return Err(format!(
                        "Domain barrel collides with a generated type: {path}"
                    ));
                }
                insert(&mut files, path, exports.into_bytes());
            }
            let types: Vec<_> = self.entries.iter().map(|(name, entry)| serde_json::json!({
                "name": name, "path": entry.path, "origin": entry.origin, "families": entry.families,
            })).collect();
            insert(
                &mut files,
                "manifest.json".into(),
                serde_json::to_vec_pretty(&serde_json::json!({"version": 1, "types": types}))
                    .map_err(|e| e.to_string())?,
            );
        }
        Ok(files)
    }
}

struct Visitor<'a> {
    registry: &'a mut Registry,
    family: &'a str,
    error: Option<String>,
}

impl TypeVisitor for Visitor<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if self.error.is_none() {
            self.error = self.registry.collect::<T>(self.family).err();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(TS)]
    struct Envelope {
        count: u64,
        value: serde_json::Value,
    }

    #[derive(TS)]
    struct Recursive {
        children: Vec<Recursive>,
    }

    mod left {
        #[derive(ts_rs::TS)]
        pub struct Duplicate;
    }

    mod right {
        #[derive(ts_rs::TS)]
        pub struct Duplicate;
    }

    #[test]
    fn recursive_json_and_nested_paths_are_closed_and_deterministic() {
        let mut forward = Registry::new(true);
        forward.add::<Envelope>("data").unwrap();
        forward.add::<Recursive>("tree").unwrap();
        let mut reverse = Registry::new(true);
        reverse.add::<Recursive>("tree").unwrap();
        reverse.add::<Envelope>("data").unwrap();
        let files = forward.artifacts(true).unwrap();
        assert_eq!(files, reverse.artifacts(true).unwrap());
        let envelope = std::str::from_utf8(&files["Envelope.ts"]).unwrap();
        assert!(envelope.contains("count: number"));
        assert!(envelope.contains("./serde_json/JsonValue"));
        let json = std::str::from_utf8(&files["serde_json/JsonValue.ts"]).unwrap();
        for variant in ["string", "number", "boolean", "Array<JsonValue>", "null"] {
            assert!(json.contains(variant), "Missing JSON variant {variant}");
        }
        assert!(!json.contains("unknown"));
        assert!(!json.contains("any"));
        assert!(std::str::from_utf8(&files["index.ts"])
            .unwrap()
            .contains("./serde_json/JsonValue"));
        assert!(std::str::from_utf8(&files["data/index.ts"])
            .unwrap()
            .contains("../Envelope"));
        assert!(!std::str::from_utf8(&files["data/index.ts"])
            .unwrap()
            .contains("Recursive"));
        let mut config = Registry::new(false);
        config.add::<Envelope>("config").unwrap();
        assert!(
            std::str::from_utf8(&config.artifacts(false).unwrap()["Envelope.ts"])
                .unwrap()
                .contains("count: bigint")
        );
    }

    #[test]
    fn legacy_configuration_export_path_stays_inside_the_selected_output() {
        #[derive(TS)]
        #[ts(export_to = "../../src/types/generated/config/")]
        struct HistoricalConfig {
            enabled: bool,
        }
        let mut registry = Registry::new(false);
        registry.add::<HistoricalConfig>("config").unwrap();
        let files = registry.artifacts(false).unwrap();
        assert!(files.contains_key("HistoricalConfig.ts"));
        assert!(files.keys().all(|path| !path.contains("..")));
    }

    #[test]
    fn collisions_report_both_rust_origins() {
        let mut registry = Registry::new(true);
        registry.add::<left::Duplicate>("left").unwrap();
        let error = registry.add::<right::Duplicate>("right").unwrap_err();
        assert!(error.contains("left::Duplicate"));
        assert!(error.contains("right::Duplicate"));
    }

    #[test]
    fn type_names_cannot_collide_with_the_barrel_on_case_insensitive_filesystems() {
        #[derive(TS)]
        struct Index;

        let mut registry = Registry::new(true);
        let error = registry.add::<Index>("data").unwrap_err();
        assert!(error.contains("Unsupported type name Index"));
        assert!(error.contains("::Index"));
    }

    #[test]
    fn documented_ipc_fields_do_not_emit_trailing_whitespace() {
        #[derive(TS)]
        struct Documented {
            /// Transported value.
            value: String,
        }

        let mut registry = Registry::new(true);
        registry.add::<Documented>("data").unwrap();
        let files = registry.artifacts(true).unwrap();
        let contents = std::str::from_utf8(&files["Documented.ts"]).unwrap();
        assert!(contents.contains("Transported value."));
        assert!(contents.lines().all(|line| line == line.trim_end()));
    }
}
