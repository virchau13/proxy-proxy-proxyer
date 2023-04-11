import { HeaderObject, HTTPParser } from "http-parser-js";
import * as net from "net";
import * as http from "http";
import { parseArgs } from "util";
import { createHash } from "crypto";

function panic(msg: string): never {
    throw new Error("panic: " + msg);
}

function sha256(s: string): string {
    const hash = createHash("sha256");
    hash.update(s);
    return hash.digest("hex");
}

// parseResponse {{{

// Taken and modified from https://github.com/creationix/http-parser-js/blob/master/standalone-example.js.
// Full credit to them for this.
// This is just a slightly modified version of the original parser so we can save the head chunk.
type Response = {
    shouldKeepAlive: boolean;
    upgrade: boolean;
    statusCode: number;
    statusMessage: string;
    versionMajor: number;
    versionMinor: number;
    headers: HeaderObject;
    body: Buffer;
    trailers: string[];
};
export function parseResponse(
    input: net.Socket,
    cb: (err: any, response: Response, head: Buffer) => void
) {
    // The last chunk sent by the input. Think of this as the "extra" data sent directly after the HTTP request.
    // This will clearly contain useful data, so we must pass it on to the callback.
    let lastChunk = Buffer.alloc(0),
        lastLen = 0;

    const parser = new HTTPParser(HTTPParser.RESPONSE);
    let shouldKeepAlive: boolean;
    let upgrade: boolean;
    let statusCode: number;
    let statusMessage: string;
    let versionMajor: number;
    let versionMinor: number;
    let headers: HeaderObject = [];
    let trailers: string[] = [];
    let bodyChunks: Buffer[] = [];

    const onComplete = () => {
        console.log("http Response completed parsing");
        input.removeListener("data", listener);
        parser.finish();
        let body = Buffer.concat(bodyChunks);
        const ret = {
            shouldKeepAlive,
            upgrade,
            statusCode,
            statusMessage,
            versionMajor,
            versionMinor,
            headers,
            body,
            trailers,
        };
        // no error , ret, the head chunk
        cb(undefined, ret, lastChunk.subarray(0, lastLen));
    };

    parser[HTTPParser.kOnHeadersComplete] = function (res) {
        shouldKeepAlive = res.shouldKeepAlive;
        upgrade = res.upgrade;
        statusCode = res.statusCode;
        statusMessage = res.statusMessage;
        versionMajor = res.versionMajor;
        versionMinor = res.versionMinor;
        headers = res.headers;
        // we don't care about the body, just do the complete here
        onComplete();
    };

    // Doesn't parse the body; `parser[HTTPParser.kOnBody]` not set.
    // (If we get a response body, that means either we made an invalid request, or the proxy is broken.)

    // Doesn't parse trailers; `parser[HTTPParser.kOnHeaders]` (yes, that is in fact the event for trailers) is not set.
    // We don't need this, because again, we don't need the body.

    // We don't listen for the completion event (`parser[HTTPParser.kOnMessageComplete]`).
    // It's instead triggered after header-complete.

    const listener = (chunk: Buffer) => {
        let lenOrError;
        if (typeof (lenOrError = parser.execute(chunk)) !== "number") {
            // We got an error, report it
            cb(lenOrError, null as any, null as any);
            input.removeListener("data", listener);
            return;
        }
        lastLen = lenOrError;
        lastChunk = chunk;
    };
    input.on("data", listener);
}
// }}}

// argument parsing {{{
const {
    values: { realProxyUri, thisProxyUri, proxyPw, port: listenPort },
} = parseArgs({
    options: {
        realProxyUri: {
            type: "string",
            short: "r",
        },
        thisProxyUri: {
            type: "string",
            short: "t",
        },
        proxyPw: {
            type: "string",
            short: "w",
        },
        port: {
            type: "string",
            short: "p",
            default: "5000",
        },
    },
});

try {
    // validate args
    if (!realProxyUri) throw "need realProxyUri";
    if (!thisProxyUri) throw "need thisProxyUri";
    if (!proxyPw) throw "need proxyPw (proxy password)";
} catch (e) {
    console.error(e);
    console.error(`
Usage: -r REAL_PROXY -t THIS_PROXY -w PROXY_PW [-p PORT]

-r, --realProxyUri: Specifies the location (\`{host}:{port}\` form) of the "real proxy" that you are trying to get around.
-t, --thisProxyUri: Specifies the location (just \`{host}\` form with no port, the port will always be 80 or 443) of the Rust server proxy running on the real internet.
-w, --proxyPw: Specifies the proxy password. This should have the same value on both the server and client.
-p: Specifies the port to listen on. Defaults to 5000.
`);
    process.exit(1);
}

const extractHost = (uri: string) => ({
    host: uri.split(":")[0],
    port: parseInt(uri.split(":")[1]),
});

const REAL_PROXY = extractHost(realProxyUri || ":");
const THIS_PROXY = thisProxyUri;

const PROXY_PW = proxyPw;
// }}}

const server = http.createServer((req, userRes) => {
    const [_error, ifError] = mkError(() => {
        try {
            userRes.writeHead(502, []);
            userRes.end();
        } catch (_) {}
    });
    // basic HTTP proxy
    // just rewrite url and remake the request
    try {
        let url = req.url ?? "";
        console.log("basic HTTP proxy:", url);
        req.headers["x-proxyer-proxy-dest"] = url;
        req.headers["x-proxyer-proxy-auth"] = makeAuth(url);
        // The proxy will probably rewrite the Host header,
        // so preserve the original here.
        req.headers["x-proxyer-real-host"] = req.headers["host"];
        let common = {
            method: req.method,
            headers: req.headers,
        };
        let options;
        let dontCache = Date.now().toString();
        options = {
            ...common,
            hostname: REAL_PROXY.host,
            port: REAL_PROXY.port,
            path: "http://" + THIS_PROXY + "/" + dontCache,
        };
        console.log("sending request with options", options);
        req.on(
            "error",
            ifError("(user) req", () => {})
        );
        let toProxy = http.request(options, (proxyRes) => {
            userRes.writeHead(
                proxyRes.statusCode ?? 500,
                proxyRes.statusMessage,
                proxyRes.headers
            );
            proxyRes.pipe(userRes);
            userRes.on(
                "error",
                ifError("userRes", () => {})
            );
            proxyRes.on(
                "error",
                ifError("proxyRes", () => {})
            );
        });
        toProxy.on(
            "error",
            ifError("toProxy", () => {})
        );
        req.pipe(toProxy);
    } catch (e) {
        console.error("Error in basic proxy handler:");
        console.error(e);
    }
});

// mk{,If}Error, {,If}ErrorF {{{

type ErrorF = (msg: string) => (e: any) => void;
type IfErrorF<Rest extends unknown[]> = (
    msg: string,
    cb?: (...rest: Rest) => void
) => (err: any, ...rest: Rest) => void;

const mkError = <Rest extends unknown[]>(
    action: () => void
): [ErrorF, IfErrorF<Rest>] => {
    const error = (msg: string) => (e: any) => {
        console.error("error:", msg + ":", e);
        action();
    };
    const ifError = mkIfError(error);
    return [error, ifError];
};

const mkIfError =
    (error: ErrorF) =>
    <Rest extends unknown[]>(msg: string, cb?: (...rest: Rest) => void) =>
    (err: any, ...rest: Rest) => {
        if (err) {
            error(msg)(err);
        } else {
            if (cb) cb(...rest);
        }
    };
// }}}

type HostPort = { host: string; port: number };

function connectThroughProxy(
    error: ErrorF,
    { host, port }: HostPort,
    proxySock: net.Socket,
    cb: (head: Buffer) => void,
    sendAuth?: boolean
) {
    const ifError = mkIfError(error);
    proxySock.write(
        `CONNECT ${host}:${port} HTTP/1.1\r
Host: ${host}:${port}\r
${sendAuth ? `${AUTH_HEADER_NAME}: ${makeAuth(host + ":" + port)}\r\n` : ""}\r
`,
        ifError("proxy CONNECT write failure", () => {
            console.log("wrote CONNECT to proxy");
        })
    );
    parseResponse(
        proxySock,
        ifError("Proxy HTTP CONNECT response parse error", (resp, head) => {
            if (resp.statusCode !== 200) {
                // lol ded
                error("proxy request failed with")(resp);
            } else {
                // lets go
                console.log("received OK from proxy, connection established");
                cb(head);
            }
        })
    );
}

// If you're having trouble getting to this to work on your locked-down real proxy,
// this function will be helpful to debug.
function debugSock(sock: { on(ev: string, cb: (a: any) => any): void }) {
    sock.on("data", (buf) => console.log(buf.toString("utf-8")));
}

function connectToThisProxy(
    error: ErrorF,
    cb: (head: Buffer) => void
): net.Socket {
    const ifError = mkIfError(error);

    const proxySock = new net.Socket();
    proxySock.on(
        "error",
        ifError("proxySock", () => {})
    );
    proxySock.connect(REAL_PROXY, () => {
        console.log("connected to real proxy");
        connectThroughProxy(
            error,
            { host: THIS_PROXY ?? "", port: 443 },
            proxySock,
            (head1) => {
                console.log("connected through proxy to this proxy");
                // we can pipe the direct TLS connection through here,
                // no need to be special about it
                cb(head1);
            }
        );
    });
    return proxySock;
}

// auth {{{

function makeAuth(uri: string): string {
    let hour = new Date().getUTCHours();
    return makeAuthWithHour(uri, hour);
}

function makeAuthWithHour(uri: string, hour: number): string {
    return sha256(hour + "#" + PROXY_PW + "#" + uri);
}

// }}}

const AUTH_HEADER_NAME = "x-proxyer-proxy-auth";

server.on("connect", (req, userSock, connHead) => {
    const [error, ifError] = mkError(() =>
        userSock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
    );
    userSock.on("error", ifError("userSock"));
    try {
        // just pipe it!
        const hostport = (req.url ?? "").split(":");
        console.log("received CONNECT request for: " + req.url);
        const host = hostport[0] ?? panic("no host found in url");
        let port = parseInt(hostport[1] ?? panic("no port found in url"));
        // add auth just before the TLS request
        connHead = Buffer.concat([
            Buffer.from(makeAuth(host + ":" + port), "ascii"),
            connHead,
        ]);
        // This is callback hell but there's not much I can do about it, so whatever.
        // At least it's only in one place.
        const serverSock = connectToThisProxy(error, (thisProxyHead) => {
            serverSock.write(
                connHead,
                ifError("serverSock.write(head)", () => {
                    userSock.write(
                        "HTTP/1.1 200 OK\r\n\r\n",
                        ifError("writing OK response failed", () => {
                            userSock.write(
                                thisProxyHead,
                                ifError("writing remote head failed", () => {
                                    serverSock.pipe(userSock);
                                    userSock.pipe(serverSock);
                                })
                            );
                        })
                    );
                })
            );
        });
    } catch (e) {
        error("CONNECT handler")(e);
    }
});

server.listen(parseInt(listenPort || process.env.PORT || "5000"));
