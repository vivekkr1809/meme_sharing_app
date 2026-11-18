# Deploying Meme Pals

Meme Pals has one server-side piece: the **relay**. It is a small Node process that:

- serves the built web app (optional: you can host the app elsewhere),
- introduces your two devices to each other over a WebSocket (`/ws`) so they can open a direct, encrypted WebRTC connection,
- offers a few stateless pass-through proxies (`/proxy/reddit`, `/proxy/imgflip`, `/proxy/image`) for when Reddit or Imgflip block direct browser requests,
- tells the app which STUN/TURN servers to use (`/config`).

Your messages and memes never go through the relay. They travel device to device over the WebRTC DataChannel.

## The relay stores nothing

- **No database and no disk writes.** Rooms exist only in RAM, keyed by an opaque room id derived from your pairing secret. The relay never sees the secret. A room disappears as soon as both sockets disconnect.
- **Content-blind.** Signaling messages are HMAC-signed by your devices and forwarded verbatim. The relay cannot forge them, and the SDP they carry pins the DTLS fingerprint, so a malicious relay cannot get between your devices.
- **No content logs.** The relay logs lifecycle counts only (`ws open rooms=1 sockets=2`). It never logs room ids, device ids, signaling payloads, URLs or IP addresses.
- **No caching.** Proxy responses are streamed through with `Cache-Control: no-store`. Upstream requests carry only a generic `User-Agent: MemePalsRelay/0.1`, never your cookies, IP address or referrer.
- **No volume.** The container is designed to run with a read-only root filesystem (`docker run --read-only`). `TSX_DISABLE_CACHE=1` is set in the image so the TypeScript loader doesn't write its transform cache either. If you run the relay outside Docker with `pnpm start`, set `TSX_DISABLE_CACHE=1` too.

Restarting the relay loses nothing. The devices just reconnect.

## HTTPS is mandatory

Phones only allow WebRTC, camera access (QR pairing) and service workers (installable PWA, offline shell) in a **secure context**, which means `https://` (or `http://localhost` during development). Every option below gives you a real TLS certificate. A plain `http://192.168.x.x:8787` URL will load in a browser, but pairing, chat and "Add to Home Screen" will not work on a phone.

## Run exactly one instance

Rooms live in the memory of one process, so both phones must reach the **same** relay process. Do not scale horizontally, enable HA, or deploy to several regions. A single tiny instance (256 MB) is plenty for two people.

## Build the image

From the repository root:

```sh
docker build -t meme-pals .
docker run --rm -p 8787:8787 --read-only meme-pals
# open http://localhost:8787
```

The image builds the web app, then runs the relay as the unprivileged `node` user with `STATIC_DIR=/app/apps/web/dist`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `STATIC_DIR` | `/app/apps/web/dist` in Docker, unset otherwise | Directory of the built web app. If unset, only the API is served. |
| `STUN_URLS` | `stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478` | Comma list advertised at `/config`. Use `none` to advertise no STUN. |
| `TURN_URLS` | unset | Comma list of `turn:`/`turns:` URLs (see [Optional: TURN](#optional-turn)) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | unset | TURN long-term credentials |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy (Fly, Render, Caddy, Cloudflare), so per-IP connection limits use the last `X-Forwarded-For` hop instead of the proxy's address |
| `CSP_CONNECT_SRC` | unset | Extra `connect-src` origins for the app's Content-Security-Policy, space or comma separated. Only needed if users point Settings at a *different* relay and you want its `/config` and `/proxy` to work too (its WebSocket is already allowed via `wss:`). See `docs/SECURITY.md` |

Check what the app will receive with `curl https://memes.example.com/config`.

## Option 1: Fly.io

A sample config is in [`deploy/fly.toml`](fly.toml).

```sh
fly auth login
fly launch --config deploy/fly.toml --no-deploy --copy-config   # choose a unique app name
fly deploy --config deploy/fly.toml --ha=false
fly scale count 1                                                # make sure there is ONE machine
# optional TURN:
fly secrets set TURN_URLS="turn:turn.example.com:3478" TURN_USERNAME=memepals TURN_CREDENTIAL=...
```

Run the commands from the repository root, which is the build context. Fly gives you `https://<app>.fly.dev` with TLS. You can add your own domain with `fly certs add`. There is no `[mounts]` section, so the machine has no persistent volume. With `auto_stop_machines`, the machine sleeps when nobody is connected and wakes on the next request, which takes a couple of seconds.

## Option 2: Render

1. Push the repository to GitHub and choose **New → Web Service** in Render.
2. Runtime: **Docker**. Dockerfile path: `./Dockerfile`. Leave the build context at the repo root.
3. Instance count: **1**. Do not add a disk.
4. Health check path: `/health`.
5. Environment: `TRUST_PROXY=1`, plus any `TURN_*` variables you need.

Render provides `https://<name>.onrender.com` and supports WebSockets. On the free plan the service sleeps after about 15 minutes of inactivity, and the first connection after that waits for a cold start, which can take up to a minute.

## Option 3: A small VPS with Caddy (automatic TLS)

Any $4–6/month VPS works. Point a DNS record (for example `memes.example.com`) at it, then:

```sh
# on the VPS
git clone <your fork> meme-pals && cd meme-pals
docker build -t meme-pals .
docker run -d --name meme-pals --restart unless-stopped --read-only \
  -p 127.0.0.1:8787:8787 -e TRUST_PROXY=1 meme-pals

sudo apt install caddy               # see caddyserver.com/docs/install
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname first
sudo systemctl reload caddy
```

Caddy gets and renews the certificate automatically and proxies WebSockets without extra configuration. The sample [`Caddyfile`](Caddyfile) does not enable access logs. Keep it that way. Only ports 80 and 443 need to be open. The relay itself listens on localhost only.

## Option 4: A home computer or Raspberry Pi

Run the container (or `TSX_DISABLE_CACHE=1 STATIC_DIR=../web/dist pnpm --filter @memes/relay start` after `pnpm --filter @memes/web build`) and expose it with one of these:

**Tailscale Funnel** (TLS terminates on your own machine):

```sh
docker run -d --name meme-pals --restart unless-stopped --read-only \
  -p 127.0.0.1:8787:8787 meme-pals
sudo tailscale funnel --bg 8787
# → https://<machine>.<tailnet>.ts.net
```

If both phones run the Tailscale app, use `tailscale serve --bg 8787` instead. The relay is then reachable only inside your tailnet, which is even more private.

**Cloudflare Tunnel:**

```sh
# Quick test (random https://*.trycloudflare.com URL that changes on every restart):
cloudflared tunnel --url http://localhost:8787

# Permanent: create a named tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels),
# route memes.example.com → http://localhost:8787, then run:
cloudflared tunnel run --token <token>
```

Set `TRUST_PROXY=1` when using Cloudflare Tunnel. Cloudflare terminates TLS, so it can see signaling metadata (SDP, which includes IP addresses) and any memes fetched through `/proxy/image`. It cannot see your chat, which is end-to-end DTLS between your devices. Tailscale Funnel does not have this limitation.

Your home machine has to be on whenever you want to connect. Devices that are already connected keep talking peer to peer even if the relay goes away, but they need the relay to reconnect.

## Hosting the app separately (optional)

The web app is static and can be hosted anywhere, for example on GitHub Pages. In the app's Settings, set **Relay URL** to your relay's `https://` URL. All relay API responses send `Access-Control-Allow-Origin: *`, so cross-origin use works.

## Optional: TURN

Most of the time the two phones connect directly, with STUN helping them discover their public addresses. Some mobile carriers and corporate networks use symmetric NAT, which blocks direct connections. In that case a **TURN** server relays the packets. They are already DTLS-encrypted, so TURN can't read them, and the sample config stores nothing.

TURN needs UDP ports, so run it on a VPS rather than Fly, Render or a tunnel.

1. Edit [`deploy/coturn/turnserver.conf`](coturn/turnserver.conf): set `realm`, `server-name`, `external-ip` (if the VM is behind 1:1 NAT, as most cloud VMs are) and a long random password in `user=`.
2. For `turns:` (TLS, which helps on networks that only allow TCP 443/5349), put `fullchain.pem` and `privkey.pem` for the TURN hostname in `deploy/coturn/certs/`. Without them, coturn logs a warning and serves plain `turn:` only.
3. Open the firewall: `3478/udp`, `3478/tcp`, `5349/tcp`, `49160-49200/udp`.
4. Start it:
   ```sh
   cd deploy/coturn && docker compose up -d
   ```
   The compose file runs coturn read-only, keeps its scratch directories in RAM (`tmpfs`) and discards its logs, which contain client IPs. Switch the logging driver to `json-file` temporarily if you need to debug.
5. Tell the relay about it, so `/config` advertises it to the app:
   ```sh
   TURN_URLS="turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp"
   TURN_USERNAME=memepals
   TURN_CREDENTIAL=<the password from turnserver.conf>
   ```
   For Docker: `docker run ... -e TURN_URLS=... -e TURN_USERNAME=... -e TURN_CREDENTIAL=...`. For Fly: `fly secrets set ...`. For Render: environment variables.
6. Check it: `curl https://memes.example.com/config` should list the TURN entry. You can also test the server with the "Trickle ICE" page from the WebRTC samples: you should see `relay` candidates.

**Heads-up:** `/config` is public, so anyone who knows your relay URL can read the TURN credentials. The sample config limits the damage: per-session bandwidth caps, user and total quotas, and no relaying into private networks. Rotate the password if you see abuse. Time-limited TURN credentials (coturn's `use-auth-secret`) would not help here, because the relay would hand them out to anyone who asks.

## Relay behavior reference

| Behavior | Details |
|---|---|
| Room size | At most 2 sockets. A third device gets `error room-full` and close code `4001`. |
| Same device re-joins | The old socket is closed with code `4000` ("replaced") and the other peer gets `peer-joined` again (no `peer-left`), so it re-offers. Clients should not auto-reconnect on `4000`, or two tabs of the same device will keep kicking each other out. |
| Peer disconnects | The remaining peer gets `peer-left`. Empty rooms are deleted immediately. |
| Frame limits | Frames over 64 KiB get `error too-large`. Frames over 256 KiB are closed by the WebSocket layer (`1009`). Binary frames and malformed JSON get `bad-request`. |
| Rate limits | 50 messages per 10 s per socket (token bucket), then `rate-limited`. 20 concurrent sockets per IP (HTTP 429 on upgrade). |
| Heartbeat | Answers `ping` with `pong`, sends WebSocket pings every 15 s, and drops sockets silent for 45 s. |
| Shutdown | On SIGTERM/SIGINT, closes sockets with `1001` and exits. |
