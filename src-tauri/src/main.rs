// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    match macro_lib::initialize_agsdl_content_helper() {
        Ok(Some(code)) => std::process::exit(code),
        Ok(None) => {}
        Err(_) => std::process::exit(1),
    }
    macro_lib::run()
}
