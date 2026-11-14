# Argentic core

Pure AgSDL 0.3 calculations and flow types. This crate has no storage driver,
process execution, application or Tauri dependency. It embeds the descriptive
harness modules and preserves the integrated exact JSON codec.

`calculation::{compile, work, route}` take encoded JSON and return encoded results
or `calculation::Failure`. Their numeric conversion argument belongs to the
native boundary; authored number lexemes bypass that conversion. Native hosts
normally use `argentic-runtime::calculation`, which supplies the existing scalar
conversion, or `argentic-runtime::standalone::Host` for actual execution.
`durable_json` validates and compares retained JSON without rounding its numbers.
`flow` contains the shared pure state/reducer contracts. A calculated plan or a
module's descriptive capability is never permission to execute it.

```sh
cargo test --offline --locked --manifest-path argentic-core/Cargo.toml
cargo test --offline --locked --manifest-path argentic-core/Cargo.toml --doc
```

Prefix paths with `crates/` inside Macro. Keep this crate beside
`argentic-runtime` when testing the two extracted source directories. The default
Rust suites need no editor checkout or Bun. Editor oracle replay remains an
explicit development feature of the runtime. See the runtime's `README.md` and
`HOST.md` for operational use, platform limitations and native ownership.
