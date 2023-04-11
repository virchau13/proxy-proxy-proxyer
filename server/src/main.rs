mod auth;
mod proxy_http;
mod proxy_tls;

use clap::Parser;
use once_cell::sync::Lazy;

#[derive(Debug, Clone, Parser)]
struct Opts {
    #[clap(short, long, required = true)]
    /// The password.
    /// Make sure this is the same as the password passed to the client.
    password: String,
}

// Password never changes, so make it global
pub static PROXY_PW: Lazy<&'static str> = Lazy::new(|| {
    let opts = Opts::parse();
    Box::leak(opts.password.into_boxed_str())
});

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env())
        .init();

    let (_res1, _res2) = tokio::join!(
        tokio::task::spawn(proxy_tls::main()),
        tokio::task::spawn(proxy_http::main())
    );
    Ok(())
}
