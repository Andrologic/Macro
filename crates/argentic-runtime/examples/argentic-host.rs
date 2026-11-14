//! Explicit JSON-lines operator for the standalone host. See ../HOST.md.
use argentic_runtime::{
    api::*,
    persistence::{self, dto::*, public030::*},
    standalone::Host,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    Preflight {
        entry: Option<EngineEntry>,
    },
    Start {
        request_id: String,
        entry: Option<EngineEntry>,
    },
    Runs,
    Inspect {
        query: RuntimeProjectionQuery030,
        continuation: Option<RuntimeProjectionContinuation030>,
    },
    Humans {
        scope: HumanScope030,
        continuation: Option<HumanContinuation030>,
    },
    Answer {
        input: HumanSubmission,
    },
    Deliver {
        input: DeliveryRequest030,
    },
    Stop {
        system_start_id: String,
        request_id: String,
    },
    Shutdown {
        approved: Vec<String>,
    },
    Quit {
        approved: Vec<String>,
    },
}
fn output(value: Value) -> bool {
    use std::io::Write;
    writeln!(std::io::stdout().lock(), "{value}").is_ok()
}
async fn retire(host: &Host, approved: &[String]) -> persistence::Result<()> {
    tokio::time::timeout(std::time::Duration::from_secs(10), host.shutdown(approved))
        .await
        .map_err(|_| {
            persistence::failure(
                "SHUTDOWN_PENDING",
                "host",
                "Retirement is incomplete. Inspect and retry the same shutdown.",
            )
        })?
}
async fn execute(host: &Host, command: Command, codex: bool) -> persistence::Result<(Value, bool)> {
    let result = match command {
        Command::Preflight { entry } => host.preflight(entry.as_ref(), codex).await?,
        Command::Start { request_id, entry } => {
            let run = host.start(request_id, entry, codex).await?;
            json!({"receipt":run.receipt,"source":run.capture.source})
        }
        Command::Runs => json!(host.runs().await?),
        Command::Inspect {
            query,
            continuation,
        } => serde_json::to_value(host.projection(query, continuation).await?)?,
        Command::Humans {
            scope,
            continuation,
        } => serde_json::to_value(host.humans(scope, continuation).await?)?,
        Command::Answer { input } => json!({"receipt":host.submit_person(input).await?}),
        Command::Deliver { input } => serde_json::to_value(host.deliver(input).await?)?,
        Command::Stop {
            system_start_id,
            request_id,
        } => {
            let stopped=tokio::time::timeout(std::time::Duration::from_secs(10),host.stop(EngineStopRequest {system_start_id,request_id,activation_id:None})).await
                .map_err(|_|persistence::failure("STOP_PENDING","host","Stop is committed or unresolved. Inspect and retry; no physical receipt is implied."))??;
            serde_json::to_value(stopped)?
        }
        Command::Shutdown { approved } => {
            retire(host, &approved).await?;
            json!({"drained":true})
        }
        Command::Quit { approved } => {
            retire(host, &approved).await?;
            host.close().await?;
            return Ok((json!({"drained":true}), true));
        }
    };
    Ok((result, false))
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args.iter().any(|a| a == "--help") {
        println!("argentic-host --data DIR --workspace DIR --source FILE --policy FILE --approve-policy SHA256 --stop-on-exit [--codex]\nJSON-lines commands: preflight, start, runs, inspect, humans, answer, deliver, stop, shutdown, quit.\nNo provider is observed or started unless --codex and preflight/start are both explicit.\n--stop-on-exit consents to native Stop/drain of this process's runs on EOF or Ctrl-C.");
        return Ok(());
    }
    let mut data = None;
    let mut workspace = None;
    let mut source = None;
    let mut policy = None;
    let mut approved = None;
    let mut codex = false;
    let mut stop_on_exit = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--codex" => codex = true,
            "--stop-on-exit" => stop_on_exit = true,
            name @ ("--data" | "--workspace" | "--source" | "--policy" | "--approve-policy") => {
                i += 1;
                let value = args.get(i).ok_or("Missing option value")?.clone();
                match name {
                    "--data" => data = Some(PathBuf::from(value)),
                    "--workspace" => workspace = Some(PathBuf::from(value)),
                    "--source" => source = Some(PathBuf::from(value)),
                    "--policy" => policy = Some(PathBuf::from(value)),
                    _ => approved = Some(value),
                }
            }
            _ => return Err(format!("Unknown option: {}", args[i]).into()),
        }
        i += 1;
    }
    if !stop_on_exit {
        return Err("Explicit --stop-on-exit consent is required".into());
    }
    let host = Host::open(
        &data.ok_or("Missing --data")?,
        &workspace.ok_or("Missing --workspace")?,
        &source.ok_or("Missing --source")?,
        &policy.ok_or("Missing --policy")?,
        &approved.ok_or("Missing --approve-policy")?,
    )
    .await
    .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let ready = output(
        json!({"ready":true,"source":host.source().await,"runs":host.runs().await.map_err(|e|e.code)?}),
    );
    let mut input = tokio::io::BufReader::new(tokio::io::stdin());
    let interrupt = tokio::signal::ctrl_c();
    tokio::pin!(interrupt);
    if ready {
        loop {
            let mut line = String::new();
            let mut bounded = (&mut input).take(8 * 1024 * 1024 + 1);
            let read = tokio::select! {read=bounded.read_line(&mut line)=>read,signal=&mut interrupt=>{if let Err(e)=signal {eprintln!("Signal listener failed: {e}");}break;}};
            match read {
                Ok(0) => break,
                Ok(_) => (),
                Err(e) => {
                    eprintln!("Input error: {e}");
                    break;
                }
            }
            if line.len() > 8 * 1024 * 1024 {
                output(
                    json!({"error":{"code":"INPUT_LIMIT","message":"Command exceeds 8 MiB; closing input and draining owned runs."}}),
                );
                break;
            }
            let command = serde_json::from_str::<Command>(&line).map_err(|e| e.to_string());
            let writable = match command {
                Err(e) => output(
                    json!({"error":{"code":"INVALID_COMMAND","message":e},"shutdownStarted":host.shutdown_started()}),
                ),
                Ok(command) => match execute(&host, command, codex).await {
                    Ok((value, quit)) => {
                        let writable = output(json!({"result":value}));
                        if quit {
                            return Ok(());
                        }
                        writable
                    }
                    Err(e) => output(json!({"error":e,"shutdownStarted":host.shutdown_started()})),
                },
            };
            if !writable {
                break;
            }
        }
    }
    // EOF/Ctrl-C/output loss never abandons physical owners. The explicit startup
    // consent covers these runs. Retry the same retirement until it is joined.
    loop {
        let result = async {
            let active = host.active_runs().await?;
            host.shutdown(&active).await?;
            host.close().await
        }
        .await;
        match result {
            Ok(()) => {
                output(json!({"drained":true}));
                return Ok(());
            }
            Err(e) => {
                output(
                    json!({"error":e,"shutdownStarted":host.shutdown_started(),"retryingDrain":true}),
                );
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}
fn main() {
    match argentic_runtime::content_io::file_helper::initialize() {
        Ok(Some(code)) => std::process::exit(code),
        Ok(None) => (),
        Err(e) => {
            eprintln!("Content reader initialization failed: {e}");
            std::process::exit(1);
        }
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Tokio runtime");
    if let Err(e) = runtime.block_on(run()) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
