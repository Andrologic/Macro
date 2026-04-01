use tauri::LogicalPosition;

fn test_compiles(window: &tauri::WebviewWindow) {
    let _ = window.set_traffic_light_position(LogicalPosition::new(15.0, 30.0));
}
