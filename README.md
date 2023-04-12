# proxy-proxy-proxyer

A proxyer that proxies HTTP as a proxy request to another proxy through a proxy, which is itself a proxy.

The only use case I actually know of for this is to bypass restrictive proxies on networks.

## Why did you make this?

Let's say that one day you want to hack on something with a friend, and you decide to try
coding together at one of those new trendy coworking spaces. You bring yourself and your laptop,
amble into the siloed rows of partitioned desks, and sit down at the most convenient one
furthest from the door. You relax back in your chair, take a good gander at the amazing view of
three panels of white drywall, and decide to get cracking before your friend shows up. A charging
cable and wireless connection later, you're staring at a network sign-in screen, telling you to
change your browser proxy settings to 10.10.60.33 port 4438.

This is maybe about the point at which any sane programmer would get up and leave, but this place was reviewed
as 4.8 stars and it already took you an hour to get here, so surely it can't be that bad, right? I mean,
sure, the proxy is probably monitoring all of your network traffic, but your ISP was doing that anyway,
and that's what HTTPS is for, isn't it? So you decide, well whatever, set your proxy to 10.10.60.33 port 4438, restart your browser,
and open your favourite new tab page. Nothing appears too different, so you open your laptop to GitHub to take a look at the
latest PRs to your hot new open-source project. Rather than GitHub, however, you are presented with an error banner that looks like it was
lifted directly from the Silverlight days:

```
Permission Denied

This webpage (github.com) cannot be displayed due to an error: PERMISSION_DENIED.
Category: Malware Distribution is denied by default.

Please contact your system administrator for further information.
```

The lingering smell of `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" ...>` aside, you stare in disbelief at the message. Who would block _GitHub?_ For _malware distribution?_ Who even works here? Are all the 5 star reviews from finance people or something?

But you really don't want to pack your bag; I mean, you've just settled down, and the chair is quite comfortable, true, and the world-class snacks do encourage you to please stay the cause,
maybe you can figure out a way to get around this?

Option #1: Force HTTPS. Now you just get an insecure error page.

Option #2: Change the preset DNS. This does absolutely nothing. A couple of tries later, you figure out that _all_ outbound UDP on port 53 is blocked, and you just don't have a DNS server; HTTP proxies resolve the hostname for you.

Option #3: Don't use the proxy. This does not work either. Turns out that nevermind, it's not just outbound DNS, _all_ outbound traffic is blocked, and you have to go through the proxy to access any page. Oh, and the proxy also only allows connections to external servers on port 80 or 443. Fun.

Option #4: Direct IP address through the proxy. This does not work; the proxy is not badly implemented.

This is starting to get annoying. So you've got this proxy, it works perfectly for every site except GitHub, but you really need to access GitHub. If only you could somehow go through the proxy to a _different_ server, that sends you the actual webpage, while also hiding your traffic like HTTPS does, then you could access any site without the proxy knowing. Hmm, the outside server would be a proxy also, no? So that would make this solution a proxy-proxy. Not a bad name, you think.

Some investigation later, it turns out that for some reason no browser supports proxy-proxying by default. This is sad. Perhaps you could write your own solution? Hmm... well you don't want to modify the browser code, since that's too complicated. What if you made a proxy that runs locally, that then proxies the request to the outside proxy through the network proxy? Then you could just use it as a regular HTTP browser proxy. Hmm... that would be a proxy-proxy-proxy. Maybe a proxy-proxy-proxy<i>er</i>, in fact, since it has to do custom proxying to circumvent the middle proxy. That name's a bit more contrived, but it's fun to say, so whatever, you think.

And then it also turns out that nobody has coded that before. Why don't people write weird triple nested proxying engines? You really can't imagine why. Oh well, that means it just falls back down to you again. I mean, your friend cancelled last minute on you, so why not do something fun?

### How am I going to build this?

#### Remembering your basics of HTTP proxies

HTTP proxies have two methods of operation:
1. HTTP requests (i.e. the insecure method). By this method, in order to send a GET request via HTTP to `http://example.com/some/path` through the `evil-proxy.com` proxy, you send a GET request to `evil-proxy.com` that looks like this:  
```http
GET http://example.com/some/path HTTP/1.1
Host: http://example.com/some/path
# ...more headers...
```
Yes, your eyes aren't deceiving you. It turns out that's it's perfectly A-OK by the HTTP specification to send a full URI in your request, instead of `GET /some/path HTTP/1.1`. To be fair, most (sane) HTTP server libraries will automatically 400 reject these requests, but when you're implementing a server using very low-level libraries (for example, Rust's `hyper` or Node.js's `http` inbuilt module), you cannot always trust that your GET path will start with a `/`. Be careful out there!  
And for other HTTP verbs, like `POST`, `PUT`, whatever, you send the same request to the `evil-proxy.com` server but change the verb. To put it succinctly, in order to send a request to `{location}/{path}` through a proxy, you will send the exact same request to `evil-proxy.com`, except you will rewrite the path parameter from just `/{path}` to be `{location}/{path}` verbatim.

2. HTTPS requests. By this method, in order to send _any_ HTTPS request to URL `{location}/{path}` through `evil-proxy.com`, you will send the following HTTP request to `evil-proxy.com`:  
```http
CONNECT {location}:443 HTTP/1.1
Host: {location}:443
```
The proxy will respond with this if it likes you:  
```http
HTTP/1.1 202 Accepted
```
And after that you can treat your connection as a direct TCP connection to your target. Go do your TLS ClientHello or whatever. The proxy has essentially turned into a TCP relay proxy.
This is nice because it means that your HTTPS connection is still private _and_ you're still using the proxy.

Now, if you're smarter than me, you've probably already formed an idea of how you would achieve something like this. Every time the browser wanted to send a HTTP request, the program would send a CONNECT request to `friendly-proxy.net:443`, then send the actual proxy request through the tunnel. This is perfect, you think! So then you would then burn 2 hours implementing a server and client in Node.js, and only then you would discover that while this works to bypass whatever custom proxy server you can find online, this doesn't work with the real proxy you're trying to bypass. What's going on???

#### Some further investigation

Hmm... let's spin up the old netcat and try doing the request manually (`>` marks inputted lines, `<` marks responses from the server):
```
$ cat | sed 's/^> //; s/$/\r/' | nc evil-proxy.com 4438 | sed 's/^/< /'
> CONNECT friendly-proxy.net:443 HTTP/1.1
> Host: friendly-proxy.net:443
>
< HTTP/1.1 202 Accepted
<
> GET http://example.com/ HTTP/1.1
> Host: example.com
>
[connection terminated]
```

Huh? What's with the sudden termination??
Direct HTTPS connections to `friendly-proxy.net:443` work, so you're not exactly sure what's... wait, what if this is just DPI?

#### The Scourge of Deep Packet Inspection (DPI)
I mean, you've _heard_ of DPI. You've read those couple of national security infosec articles that talk about "using DPI" to detect hostile content. But it's always been an ethereal _thing_, somewhere in the latent space of all possible MITM techniques, something that only nations can afford and will pay for. But this might be the very real first time you've encountered DPI in your day-to-day life. Something about this is super unsettling. Your fragile Internet traffic, being pored over and examined, twisted and prod from every angle, just so that the people whose identity and intentions you do not know can deduce faint trails of the data you might be accessing, like expert hunters poring over your tracks in the wilderness, expert hunters which are out to get _you_ in particular.

Actually it's probably not any of that. It's probably just something like they record the hostname that your browser wants from the TLS server, so that at the end of every month Mr. Bossman can take a look at the graph labeled "aggregated internet traffic of every domain, by percentage" and ask the IT guys pointed questions. Yeah, probably something like that. Probably.

Well, there's no point in speculating. Probably best to test the hypothesis first.
You first gather the test data by executing the following on your phone (remember, you still don't have proper internet on your laptop):
```
$ touch sent-by-server
$ tail -f sent-by-server | nc -l 4444 | tee sent-by-client | nc example.com 443 > sent-by-server &
$ curl --connect-to 'example.com:443':'localhost:4444' https://example.com
```

You use Bluetooth file transfer to transfer the `sent-by-{client,server}` files to your laptop, which takes _forever_ for some reason, and now you have a snapshot of valid TLS traffic. You use this to set up a test of the proxy:
```
# on `friendly-proxy.net` (you set the PS1 awhile ago and although you find it more tacky than funny now you also don't feel like changing it):
USER root AT friendly-proxy DIR ~ $ cat sent-by-server | nc -l 443 -v

# on your laptop:
$ cat | sed 's/$/\r/' > pre-request << EOF
> CONNECT friendly-proxy.net:443 HTTP/1.1
> Host: friendly-proxy.net:443
>
> EOF
$ cat pre-request sent-by-client | nc evil-proxy.net 4438 -v > output-file
$ diff output-file sent-by-server
# no output, so the files do not differ
$
```
No early request cutoff! So there's definitely at least one thing that the proxy is doing that allows TLS through but not plaintext HTTP. No matter! You can work with this!

The first packet of the TLS handshake, as you know from... well, you're not actually sure, but somewhere in that deeply wise brain of yours you know this fact, probably sourced from a blogpost or news article which got garbage collected later but the information it gave you was judged valuable enough to keep, leaving behind knowledge that you can't find a source of... anyway, the first packet of the TLS handshake from the client to the server contains a field known as the _Server Name Indication_ (SNI), which specifies which domain the browser is requesting. This is to enable... oh yeah, maybe you got the information from a CDN blogpost or something... anyway, this is to enable servers which host multiple domains to choose the correct respondent for the domain without compromising the security of TLS. The great thing about SNI is that you can use it for this proxying task!

We just saw before that the evil proxy allowed through the TLS handshake, _despite_ the fact that the `CONNECT` request was for `friendly-proxy.net:443`, and the SNI in the first TLS packet was definitely `example.com` (since that's where the data was captured from!) So therefore the friendly proxy can just parse the browser's SNI packet, look at the SNI, and proxy the HTTPS connection to that SNI port 443! This way, we have traffic that is both (a) TLS-shaped (since it is literally TLS) and (b) proxyable!

You then proceed to burn another 2 hours implementing this in Node.js.

#### RIIR

Finally, everything works! Well, until you notice the latency and decide to change `friendly-proxy.net` for a closer server. You rent the cheapest possible cloud VM you can find that's also in a datacenter near your desk, wow only 250MB of RAM? and then you stick your Node.js server process on it. This works great! You're happy, and so happy in fact that you spin up your favourite intensive full multiplayer web game to cool off after that monumental achievement of 300 lines of code, before noticing that your proxy doesn't work anymore. Huh? You check the server, and see that the proxy server process has been killed because it took too much memory.

Well then.

This is probably because you wrote it really inefficiently. But rewriting it to be more efficient so that it won't take up so much memory will involve a full rewrite anyway, so you decide to take the risk and rewrite it in Rust instead, because then surely it will work, right? It does, after another 2 hours of pain. You decide to call it a day here. Who knows, maybe you'll come back to this place tomorrow? The snacks were really good, after all...

## Usage
 
Please don't actually use this. I wrote this as a proof-of-concept over the course of about six hours. To be specific, here's exactly why you should not use this:
* There is no proper authentication; anyone who is smart enough and also knows your proxy's domain and has found this GitHub repository can abuse your cloud VM as a free proxy. (I mean, there _is_ authentication so that random people can't just take advantage of your free proxy, but it's not very good. I'm not going to talk about how I implemented it, because to be honest I don't want to type it up, and it's pretty easy to break anyway. I don't really have any plans for making this more secure, but feel free to contribute some code if you come across this repository and feel a deep sense of kinship.),
* You can't connect to HTTPS other than on port 443, because SNI does not specify the port. (Or at least, if it does, I haven't implemented it.)
* If you're actually trying to bypass a proxy server, there are probably better solutions you can use. (The reason why I didn't use any of them is that I didn't have any of them installed on my laptop, and I didn't want to waste my minimal mobile data plan on GBs of packages, and also because I wanted to have some fun writing something. I won't list them here but they're naught but a quick search away.)

But if you really insist, here's how you use this:
1. Set up a cloud VM that has a public IP that you can listen on. Leave both ports 80 and 443 open.
2. Run the Rust server binary on the VM: `cd server/; cargo run --release -- --password PUT_A_COMMON_PASSWORD_HERE` (please do not use any actual important password, it just has to be common between the client and server)
3. Run Node on the client: `cd client/; yarn; yarn build; node ./built/index.js --realProxy REAL_PROXY --proxyPw PUT_A_COMMON_PASSWORD_HERE --thisProxy FRIENDLY_PROXY -p 5000`, where `REAL_PROXY` is the address of the proxy you're trying to bypass (in `{host}:{port}` form), and `FRIENDLY_PROXY` is the address of the friendly proxy out on the wider Internet.
4. Configure your browser's proxy settings to use `localhost` port 5000 as your proxy.
5. Rejoice!
