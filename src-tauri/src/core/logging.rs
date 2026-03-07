use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn init_logging() {
    // Default log level can be controlled via RUST_LOG environment variable
    // e.g., RUST_LOG=debug,sqlx=warn
    let env_filter = EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .init();
}
