//! Dedicated harness entry point; it uses the same dispatch as the app.
fn main() {
    match macro_lib::initialize_agsdl_content_helper() {
        Ok(Some(code)) => std::process::exit(code),
        Ok(None) => {}
        Err(_) => std::process::exit(1),
    }
    #[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
    {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        if args.len() == 2 && args[0] == "--run-agsdl-content-cases" {
            let Some(selection) = args[1].to_str() else {
                std::process::exit(1);
            };
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            match runtime {
                Ok(runtime) => {
                    match runtime.block_on(macro_lib::run_agsdl_content_cases(selection)) {
                        Ok(report) => {
                            println!("{report}");
                            return;
                        }
                        Err(error) => eprintln!("Content QA cases failed: {error}"),
                    }
                }
                Err(error) => eprintln!("Content QA runtime failed: {error}"),
            }
            std::process::exit(1);
        }
        if args.len() != 2 || args[0] != "--run-agsdl-content-qa" {
            std::process::exit(1);
        }
        let root = std::path::PathBuf::from(&args[1]);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        match runtime {
            Ok(runtime) => match runtime.block_on(macro_lib::run_agsdl_content_qa(&root)) {
                Ok(()) => return,
                Err(error) => eprintln!("Content QA failed: {error}"),
            },
            Err(error) => eprintln!("Content QA runtime failed: {error}"),
        }
    }
    std::process::exit(1);
}
