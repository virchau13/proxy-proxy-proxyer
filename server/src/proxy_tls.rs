use anyhow::{anyhow, bail, Context};
use tls_parser::{SNIType, TlsClientHelloContents, TlsExtension, TlsMessage, TlsMessageHandshake};
use tokio::{
    io::{self, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

type AResult<T> = anyhow::Result<T>;

fn dbg_err<D: std::fmt::Debug>(d: D) -> anyhow::Error {
    anyhow!(format!("{:?}", d))
}

// returns (sni, head) tuple
// this is inefficient but i can't figure out a better way to do it
async fn get_sni(sock: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), anyhow::Error> {
    const AT_A_TIME: usize = 1024;
    let mut packet_buf = Vec::new();
    let (_, packet) = loop {
        let len = packet_buf.len();
        packet_buf.resize(len + AT_A_TIME, 0u8);
        let n = sock
            .read(&mut packet_buf[len..])
            .await
            .context("sock.read(&packet)")?;
        packet_buf.truncate(len + n);
        match tls_parser::parse_tls_plaintext(&packet_buf) {
            Ok(parsed) => break parsed,
            Err(err) => match err {
                tls_parser::Err::Incomplete(_) => { 
                    tracing::debug!("tls parse incomplete, packet size > {}", packet_buf.len());
                }
                _ => return Err(anyhow!(dbg_err(err)).context("parse_tls_plaintext")),
            },
        }
        if n == 0 {
            // EOF, just stop here
            bail!("TLS parsing hit EOF before completion");
        }
    };
    tracing::debug!("tls record parse complete");
    let msg = packet
        .msg
        .first()
        .ok_or(anyhow!("no message in TLS packet"))?;
    match msg {
        TlsMessage::Handshake(TlsMessageHandshake::ClientHello(TlsClientHelloContents {
            ext: Some(ext_buf),
            ..
        })) => {
            let (_, exts) = tls_parser::parse_tls_client_hello_extensions(ext_buf)
                .map_err(dbg_err)
                .context("parse_tls_client_hello_extensions")?;
            let mut server_name: Option<Vec<u8>> = None;
            for ext in exts {
                if let TlsExtension::SNI(snis) = ext {
                    if let Some((SNIType::HostName, srv_name)) = snis.first() {
                        server_name = Some(srv_name.to_vec());
                    }
                }
            }
            if let Some(server_name) = server_name {
                Ok((server_name, packet_buf))
            } else {
                bail!("No SNI found")
            }
        }
        _ => bail!("TLS message was not a handshake/ClientHello"),
    }
}

async fn proxy_tls(sock: TcpStream) {
    if let Err(e) = real_proxy_tls(sock).await {
        tracing::debug!("proxy_tls: {:?}", e);
    }
}
async fn real_proxy_tls(mut sock: TcpStream) -> AResult<()> {
    tracing::info!("got connection");
    let mut authbuf = [0u8; crate::auth::HASH_LENGTH];
    sock.read_exact(&mut authbuf)
        .await
        .context("sock.read_exact")?;
    let auth = std::str::from_utf8(&authbuf).context("authbuf not valid UTF-8")?;
    tracing::debug!("got auth = {:?}", auth);
    let (server_name, head) = get_sni(&mut sock).await.context("get_sni")?;
    let mut server_name = String::from_utf8(server_name).context("non-utf8 server name")?;
    server_name += ":443";
    if !crate::auth::verify_auth(auth, &server_name) {
        bail!("bad auth");
    }
    tracing::debug!("good auth");
    let mut other_side = TcpStream::connect(&server_name)
        .await
        .with_context(|| format!("TcpStream::connect({server_name})"))?;
    other_side
        .write_all(&head)
        .await
        .context("other_side.write_all(&head)")?;
    tracing::debug!("calling copy_bidirectional");
    let (left ,right) = tokio::io::copy_bidirectional(&mut sock, &mut other_side)
        .await
        .context("copy_bidirectional")?;
    tracing::debug!("transferred to remote = {right} bytes, transferred to user = {left} bytes");
    Ok(())
}

pub async fn main() -> io::Result<()> {
    let listener = TcpListener::bind("0.0.0.0:443").await?;
    println!("TLS listener ready");

    loop {
        let (socket, _) = listener.accept().await?;
        tokio::task::spawn(proxy_tls(socket));
    }
}
