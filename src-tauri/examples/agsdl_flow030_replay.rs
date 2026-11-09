// Compile the production reader and reducer directly, like the portable flow
// tests. This does not expose native event constructors through the public lib.
#[allow(dead_code)]
#[path = "../src/db/agsdl_execution/v030/flow.rs"]
mod flow030;
#[path = "../src/db/agsdl_execution/v030/replay_verify030.rs"]
mod replay_verify030;

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        eprintln!("Usage: agsdl_flow030_replay DATABASE SYSTEM_ID INVOCATION_ID");
        std::process::exit(2);
    }
    let verdict = replay_verify030::verify_path030(
        std::path::Path::new(&args[0]),
        &args[1].to_string_lossy(),
        &args[2].to_string_lossy(),
    )
    .await;
    println!(
        "{}",
        serde_json::to_string(&verdict).expect("serializable verdict")
    );
    if !verdict.ok {
        std::process::exit(1);
    }
}
