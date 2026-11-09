#[cfg(debug_assertions)]
#[tokio::main]
async fn main() {
    macro_lib::run_agsdl_engine_isolation_qa().await;
    println!("{{\"ok\":true,\"checks\":[\"invalid-runtime-fallback\",\"default-inside-qa\",\"outside\",\"symlink-escape\",\"approved-workspace\",\"native-report-before-discovery\"]}}");
}

#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("Isolation QA requires a debug build.");
    std::process::exit(1);
}
