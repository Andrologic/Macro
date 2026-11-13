// SPDX-License-Identifier: Apache-2.0
//! Reader entry points for AgSDL 0.3. Rust translation of
//! `src/vendor/agsdl/v0.3/reader.mjs` (based on AgSDL v0.3.0
//! tooling/agsdl/validator.py, upstream commit
//! bd9f8a5b16923476fd20ac2650bd1729ee151917). Provenance and license:
//! `src/vendor/agsdl/NOTICE.md`, `src/vendor/agsdl/v0.3/LICENSE`.
//!
//! Inputs are explicit: document bytes or an exact value, and either the four
//! pinned modules or a caller [`ModuleMap`]. Every module is detached through
//! exact serialization and the 0.3 scanner before use, as `copyModule` does:
//! lexemes and member order survive, including array-index keys. A module that
//! declares support for a property qualifies no adapter; it only feeds the
//! static diagnostics.
use super::{
    exact::{
        scan::{parse_shared, parse_v030, Span},
        stringify, Value,
    },
    validate::{
        check_module, validate_document, Internal, ModuleError, ModuleMap, ReadError, Report,
    },
};
use std::sync::OnceLock;

/// The pinned harness modules, in the import order of `reader.mjs`.
pub(crate) const PINNED_MODULES: [(&str, &str); 4] = [
    (
        "claude-code",
        include_str!("../../assets/harnesses/claude-code/module.json"),
    ),
    (
        "codex",
        include_str!("../../assets/harnesses/codex/module.json"),
    ),
    (
        "opencode",
        include_str!("../../assets/harnesses/opencode/module.json"),
    ),
    ("pi", include_str!("../../assets/harnesses/pi/module.json")),
];

/// `options.modules`: omitted (the pinned four) or an explicit map, which
/// stays empty when it is empty.
#[derive(Clone, Copy)]
pub(crate) enum Modules<'m> {
    Pinned,
    Explicit(&'m ModuleMap),
}

/// `readWithSpans(bytes, options)`.
pub(crate) struct ReadOutput {
    pub(crate) report: Report,
    pub(crate) spans: Vec<Span>,
}

/// `loadHarnessModule(bytes)`.
pub(crate) fn load_harness_module(bytes: &[u8]) -> Result<Value, ReadError> {
    match parse_v030(bytes) {
        Err(error) => Err(ModuleError {
            message: error.message(),
        }
        .into()),
        Ok(parsed) => check_module(parsed.tree),
    }
}

/// `copyModule(module)`: exact text, rescanned and checked again. Any other
/// failure becomes a `ModuleError` with its message.
pub(crate) fn copy_module(module: &Value) -> Result<Value, ModuleError> {
    match load_harness_module(stringify(module).as_bytes()) {
        Ok(copy) => Ok(copy),
        Err(ReadError::Module(error)) => Err(error),
        Err(ReadError::Internal(error)) => Err(ModuleError {
            message: error.message,
        }),
    }
}

fn module_name(module: &Value) -> Result<&str, Internal> {
    match module.as_object().and_then(|object| object.get("name")) {
        Some(Value::String(name)) => Ok(name),
        _ => Err(Internal {
            message: "a checked module has no name".to_owned(),
        }),
    }
}

/// The detached pinned modules, computed once like the JS import.
fn defaults() -> Result<&'static [Value], ReadError> {
    static CELL: OnceLock<Result<Vec<Value>, ReadError>> = OnceLock::new();
    CELL.get_or_init(|| {
        PINNED_MODULES
            .iter()
            .map(|(name, text)| {
                // The JSON import is `JSON.parse`: ordinary JS member order.
                let tree = parse_shared(text.as_bytes()).map_err(|error| Internal {
                    message: format!(
                        "pinned module {name} is not exact JSON: {}",
                        error.message()
                    ),
                })?;
                copy_module(&tree.tree).map_err(ReadError::Module)
            })
            .collect()
    })
    .as_ref()
    .map(Vec::as_slice)
    .map_err(Clone::clone)
}

/// `registry(options)`: a detached copy of every module, keyed as given.
pub(crate) fn registry(modules: Modules<'_>) -> Result<ModuleMap, ReadError> {
    let source: Vec<(&str, &Value)> = match modules {
        Modules::Pinned => {
            let mut source = Vec::new();
            for module in defaults()? {
                source.push((module_name(module)?, module));
            }
            source
        }
        Modules::Explicit(map) => map
            .iter()
            .map(|(name, module)| (name.as_str(), module))
            .collect(),
    };
    let mut detached = ModuleMap::new();
    for (name, value) in source {
        let module = copy_module(value)?;
        let declared = module_name(&module)?;
        if name != declared {
            return Err(ModuleError {
                message: format!("module registry key '{name}' does not match name '{declared}'"),
            }
            .into());
        }
        detached.set(name.to_owned(), module);
    }
    Ok(detached)
}

fn parse_report(message: String) -> Report {
    let mut report = Report::new();
    report.error_at("PARSE", "", message);
    report
}

/// `readWithSpans(bytes, options)`. A parse failure never consults the
/// modules and carries no spans.
pub(crate) fn read_with_spans(bytes: &[u8], modules: Modules<'_>) -> Result<ReadOutput, ReadError> {
    match parse_v030(bytes) {
        Err(error) => Ok(ReadOutput {
            report: parse_report(error.message()),
            spans: Vec::new(),
        }),
        Ok(parsed) => {
            let registry = registry(modules)?;
            let report = validate_document(&parsed.tree, &registry)?;
            Ok(ReadOutput {
                report,
                spans: parsed.spans(),
            })
        }
    }
}

/// `read(bytes, options)`.
pub(crate) fn read(bytes: &[u8], modules: Modules<'_>) -> Result<Report, ReadError> {
    read_with_spans(bytes, modules).map(|output| output.report)
}

/// `validateExact(document, options)`: the registry first, then the exact
/// text of the document through the 0.3 scanner. The JS refusals of
/// `stringify` (unpaired surrogates, cycles, non-JSON values) have no `Value`
/// counterpart.
pub(crate) fn validate_exact(document: &Value, modules: Modules<'_>) -> Result<Report, ReadError> {
    let registry = registry(modules)?;
    let source = stringify(document);
    match parse_v030(source.as_bytes()) {
        Err(error) => Ok(parse_report(error.message())),
        Ok(parsed) => Ok(validate_document(&parsed.tree, &registry)?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_files_parse_identically_with_both_member_orders() {
        // JSON.parse (ordinary order) and the 0.3 scanner agree on these
        // bytes: no array-index key and no number lexeme in the modules.
        for (name, text) in PINNED_MODULES {
            let shared = stringify(&parse_shared(text.as_bytes()).unwrap().tree);
            let v030 = stringify(&parse_v030(text.as_bytes()).unwrap().tree);
            assert_eq!(shared, v030, "{name}");
            let tree = parse_v030(text.as_bytes()).unwrap().tree;
            let mut pending = vec![&tree];
            while let Some(node) = pending.pop() {
                match node {
                    Value::Number(token) => panic!("{name} has the number {}", token.raw()),
                    Value::Array(items) => pending.extend(items),
                    Value::Object(object) => {
                        for (key, item) in object.iter() {
                            assert!(
                                crate::argentic_core::exact::scan::array_index(key).is_none(),
                                "{name}: {key}"
                            );
                            pending.push(item);
                        }
                    }
                    _ => {}
                }
            }
        }
        let pinned = registry(Modules::Pinned).unwrap();
        let names: Vec<_> = pinned.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["claude-code", "codex", "opencode", "pi"]);
    }

    #[test]
    fn copies_keep_array_index_keys_in_insertion_order() {
        let text = r#"{"name":"custom","version":"1.0.0","contract":"agsdl-0.3.0","harnessVersions":"*","properties":{},"permissions":{},"settings":{"type":"object","properties":{"2":{"type":"string","enum":["x"]},"1":{"type":"array","maxItems":12345678901234567890123,"items":{"type":"integer","enum":[1e400]}}}}}"#;
        let module = load_harness_module(text.as_bytes()).unwrap();
        let copy = copy_module(&module).unwrap();
        let encoded = stringify(&copy);
        assert!(encoded.contains(r#""properties":{"2":"#), "{encoded}");
        assert!(encoded.contains("12345678901234567890123") && encoded.contains("1e400"));
    }

    #[test]
    fn explicit_maps_replace_in_place_and_check_names() {
        let mut map = ModuleMap::new();
        let broken = parse_v030(br#"{"name":"codex"}"#).unwrap().tree;
        map.set("codex".to_owned(), broken);
        let codex = load_harness_module(PINNED_MODULES[1].1.as_bytes()).unwrap();
        map.set("codex".to_owned(), codex);
        assert_eq!(registry(Modules::Explicit(&map)).unwrap().len(), 1);
        let mut renamed = ModuleMap::new();
        renamed.set(
            "other".to_owned(),
            load_harness_module(PINNED_MODULES[1].1.as_bytes()).unwrap(),
        );
        let Err(ReadError::Module(error)) = registry(Modules::Explicit(&renamed)) else {
            panic!("mismatch")
        };
        assert_eq!(
            error.message,
            "module registry key 'other' does not match name 'codex'"
        );
        let parse = read(b"{", Modules::Explicit(&renamed)).unwrap();
        assert_eq!(
            parse.to_json(),
            r#"{"contract":"agsdl-0.3.0","valid":false,"diagnostics":[{"severity":"error","code":"PARSE","path":"","message":"Invalid JSON at byte 1"}],"joins":{}}"#
        );
    }
}
