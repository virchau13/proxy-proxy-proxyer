use std::convert::Infallible;
use std::net::SocketAddr;

use anyhow::Context;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Client, Request, Response, Server, StatusCode, Uri};

type HttpClient = Client<hyper::client::HttpConnector>;

pub async fn main() {
    let addr = SocketAddr::from(([0, 0, 0, 0], 80));

    let client = Client::builder()
        .http1_title_case_headers(true)
        .http1_preserve_header_case(true)
        .build_http();

    let make_service = make_service_fn(move |_| {
        let client = client.clone();
        async move { Ok::<_, Infallible>(service_fn(move |req| proxy(client.clone(), req))) }
    });

    let server = Server::bind(&addr)
        .http1_preserve_header_case(true)
        .http1_title_case_headers(true)
        .serve(make_service);

    println!("HTTP listener ready");

    if let Err(e) = server.await {
        eprintln!("server error: {}", e);
    }
}

fn bad_request() -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .body(Body::empty())
        .unwrap()
}

async fn proxy(client: HttpClient, mut req: Request<Body>) -> anyhow::Result<Response<Body>> {
    tracing::debug!("got HTTP request {:?}", req);
    let uri = req.headers()
        .get("X-Proxyer-Proxy-Dest")
        .and_then(|val| val.to_str().ok())
        .and_then(|val| val.parse::<Uri>().ok())
        .ok_or(anyhow::anyhow!("bad URI given"))?;
    if !do_auth(&req, &uri) {
        return Ok(bad_request());
    }
    *req.uri_mut() = uri.clone();
    req.headers_mut().remove("X-Proxyer-Proxy-Dest");
    req.headers_mut().remove("X-Proxyer-Proxy-Auth");
    let real_host = req.headers_mut().remove("X-Proxyer-Real-Host");
    if let Some(real_host) = real_host {
        req.headers_mut().insert("Host", real_host);
    } else {
        // try to guess
        req.headers_mut().insert("Host", uri.to_string().try_into().context("URI is not ASCII")?);
    }
    tracing::debug!("sending HTTP request {:?}", req);
    Ok(client.request(req).await?)
}

pub fn do_auth(req: &Request<Body>, uri: &Uri) -> bool {
    if let Some(auth) = req.headers().get("X-Proxyer-Proxy-Auth") {
        if let Ok(auth) = auth.to_str() {
            let uri_str = uri.to_string();
            tracing::debug!("uri: {}", uri_str);
            if crate::auth::verify_auth(auth, &format!("{}", uri_str)) {
                return true;
            }
        }
    }
    false
}

