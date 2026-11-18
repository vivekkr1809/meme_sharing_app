# Meme Pals security and privacy

## 1. In plain words (for the two of you)

**What Meme Pals promises**

- Your chats, memes, names and settings are stored **only on your two phones**. There is no account and no cloud database.
- Messages and memes travel **directly between your phones**, encrypted (WebRTC/DTLS). The relay server only helps your phones find each other. It cannot read your chats or swap itself in between you, because every "here is how to reach me" note your phones exchange is signed with a key only your two phones have.
- The pairing code (the QR code) **is** that key. It never leaves your phone except when you show it or copy it yourself.

**What it does not promise**

- **Anyone who gets your pairing code can pose as your partner** whenever your partner is offline. Show it only to your partner, don't post screenshots of it, and if it leaks, use *Re-pair* on both phones. (Copying the code puts it on the clipboard, which some phones sync to other devices.)
- **Anyone who can unlock your phone can read the chat.** The app has no passcode lock yet, and the pairing key is stored on the phone unencrypted.
- **A backup is only as safe as its password.** Backup files are encrypted with a password you choose (they contain your whole history and every meme, never the pairing key). Someone who copies the file can try passwords offline as long as they like, so use a long one: a few random words. If you forget it, nobody can open the backup, including us.
- **Some companies see your IP address, but not your messages:**
  - Whoever runs the relay sees the IP addresses of both phones, when you are online, and an anonymous ID for your pair.
  - Google and Cloudflare run the "STUN" servers. Each phone asks them "what is my public address?" when it connects.
  - Reddit, Imgflip and the image hosts see an ordinary anonymous request when you browse memes. They don't learn your name or who you send memes to, and the app never tells them which page you came from.
- **Your partner is trusted.** They can screenshot, export or keep anything you send. Deleting a meme on your phone doesn't delete it on theirs, and *Wipe this device* only wipes your phone.

## 2. System and trust boundaries

```
 phone A (PWA, IndexedDB) ──── WebRTC DataChannel (DTLS, P2P or via TURN) ──── phone B
        │  signed SDP/ICE                                          signed SDP/ICE │
        └──────────── WebSocket ──── relay (stateless, in RAM) ──── WebSocket ────┘
                                       │ /proxy/reddit, /proxy/imgflip, /proxy/image
                                       └──► www.reddit.com, api.imgflip.com, image CDNs
```

- **Pairing:** 20 random bytes (160 bits), shown as a QR code or a 32-character code. HKDF-SHA256 turns it into:
  - `roomId`, the only thing the relay sees;
  - an HMAC-SHA256 `authKey` that signs every signaling envelope (`packages/shared/src/crypto.ts`).
  `PLAN.md` says 32 bytes. 160 bits is plenty for this use; only the plan's text differs from the code.
- **Signaling:** each envelope is `{payload, mac}`. The payload holds the sender's device id, a random nonce, a timestamp (within ±5 min) and the SDP or ICE data. The receiver verifies all of it before anything reaches `RTCPeerConnection`. The SDP carries the DTLS certificate fingerprint, so a relay that rewrites it fails the MAC check.
- **Data:** the peer sends JSON control frames, which `parseControlFrame` validates, and chunked binary memes. A meme is accepted only if its SHA-256 equals its id, it fits the size and type limits, and the receiver asked for it.
- **Storage:** Dexie/IndexedDB on each device (`apps/web/src/db/schema.ts`). The service worker precaches only the app shell. It has no runtime caching of API or proxy responses.

### Threat model

| Adversary | Can | Cannot |
|---|---|---|
| Malicious or compromised relay (or its host, TLS-terminating CDN) | See room id, device ids, IPs, timing, and SDP contents (ICE candidates, fingerprints, signed but not encrypted). Drop, delay or replay envelopes within the 5-minute window. Refuse service. Advertise its own TURN server via `/config`. | Read messages or memes. Forge or alter SDP/ICE (HMAC). MITM DTLS. Learn the pairing secret. |
| Malicious partner, or a bug on the partner's device | Send any well-formed frame, spam messages, fill your storage, keep everything you send. | Overwrite your messages, post as you, get non-raster files or bytes with a wrong hash stored, exhaust memory with chunk headers or want floods, pin your sync watermarks with far-future ids. |
| Malicious web content (Reddit, Imgflip, image hosts) | Supply titles, URLs and image bytes. | Run script (React escapes all text; there is no `dangerouslySetInnerHTML`; strict CSP; raster-only memes). Get links pointed off Reddit. Load images from non-allow-listed hosts. |
| Anyone on the Internet, against the relay | Open sockets, call `/proxy/*`. | Use it as an open proxy (fixed path and host allow-list, https only, redirects re-checked, 20 MB cap), exceed the connection, message and proxy concurrency limits, or read files outside `STATIC_DIR`. |
| Someone with your unlocked phone, or a malicious browser extension | Everything: data and the secret are in plaintext IndexedDB. | n/a. See R-02. |

## 3. Findings

Severity reflects impact given the threat model above. All fixes have tests in `*.security.test.ts` files.

| ID | Severity | Status | Location | Description |
|---|---|---|---|---|
| S-01 | **High** | Fixed `4ca2f95` | `packages/shared/src/validate.ts:48`, `apps/web/src/db/library.ts:25,176,206`, `packages/shared/src/protocol.ts` (`MEME_MIME_TYPES`) | **SVG memes could run script on the app origin.** Peer metadata, received blobs and backup imports all accepted any `image/*`, including `image/svg+xml`. The bytes were turned into a `blob:` URL of that type on the app's origin. "Open image in new tab" would then run the SVG's script with full access to IndexedDB (secret and history). Now only jpeg/png/gif/webp/avif are accepted everywhere. `getUrl()` never creates a document-typed blob URL, even for legacy rows. The new CSP is a second layer. |
| S-02 | Medium | Fixed `1a2ebe9` | `apps/relay/src/static.ts:57,79` | **No CSP or hardening headers on the served PWA.** Added a strict `Content-Security-Policy` (`script-src 'self'`, allow-listed `img-src`, `object-src`/`base-uri`/`frame-ancestors 'none'`), plus `X-Frame-Options: DENY`, `Permissions-Policy` (camera for self only), `Referrer-Policy: no-referrer`, `nosniff`, COOP and CORP. Verified with Playwright against the built app through the relay: onboarding, QR pairing, a WebRTC message between two browsers, every tab and SW registration all worked with 0 violations. Inline script and off-list images are blocked. |
| S-03 | Medium | Fixed `4ca2f95` | `apps/web/src/sync/engine.ts:487` | **`meme-want` flood caused memory exhaustion.** Every want loaded a full copy of the meme (up to 15 MB) and queued a transfer, so 1,000 wants needed about 15 GB. Now there is one in-flight transfer per meme. |
| S-04 | Medium | Fixed `4ca2f95` (tolerance is the lead's call) | `apps/web/src/sync/engine.ts:437,480` | **Far-future ULIDs broke sync and read state permanently.** One partner message with a far-future id (bug, bad clock or malice) pinned `lastReceivedId`. It also stuck the message at the bottom of the chat, and via `markRead` it froze unread counts and read receipts forever. A `read` marker like that marked all of your future messages as read. Messages or markers more than 24 h ahead are now ignored and not acked, so an honest partner's outbox retries them later. **Decision:** 24 h is generous; a partner whose clock is days off would see delayed delivery. |
| S-05 | Medium | Fixed `8e602ff` | `apps/relay/src/relay.ts:81` | **The proxy could be used as a bandwidth amplifier.** `/proxy/*` (CORS `*`) had no rate or concurrency limit, so any website could make the relay pull 20 MB images without bound. Now limited to 8 concurrent requests per IP and 64 in total (429 + `Retry-After`). |
| S-06 | Low | Fixed `c7804df` | `apps/web/src/memes/reddit.ts:34,228`, `apps/web/src/ui/format.ts` | **Reddit permalinks could point off Reddit.** The permalink was string-concatenated, so `"@evil.example/x"` became `https://www.reddit.com@evil.example/x`: a "View on Reddit" link to another host. Absolute non-Reddit URLs were also kept. It is now parsed as a URL and must be https on a Reddit host. |
| S-07 | Low | Fixed `c7804df` | `apps/web/src/memes/reddit.ts:222`, `apps/web/src/memes/imgflip.ts:35` | **Images from arbitrary hosts leaked the IP.** Feed tiles and Imgflip templates rendered images from any host the JSON named, which leaks the viewer's IP and the fact that they browse. Only the allow-listed CDNs are now used (upgraded to https), matching the CSP and the proxy allow-list. |
| S-08 | Low | Fixed `4ca2f95` | `packages/shared/src/validate.ts:61` and others | **Peer frames were unbounded.** Titles, URLs, emoji, names and ack lists had no length limits. Firefox accepts ~1 GB DataChannel messages, so a single text frame could exhaust memory. `upToId`, `lastReceivedId` and `replyTo` were not checked as ULIDs. Frames are now capped at 256 K characters, strings are capped and ids validated. |
| R-01 | Low | Recommended | `apps/web/src/p2p/transport.ts:96,258,276` | **A replayed or delayed offer can tear down an open channel.** Replay nonces live in memory only, so after a reload the relay can replay the partner's genuine pre-reload offer within the 5-minute window. A relay can also hold back a genuine offer and deliver it later. Accepting an offer replaces the session, so this tears down a working DataChannel. Confidentiality is unaffected (the fingerprint is the partner's), but this is the one way the relay can break an *open* channel. Options: (a) when the channel is open, probe it before accepting an offer, as is already done for `peer-joined`; (b) drop offers older than the newest accepted offer from that device (persisted); (c) keep recent nonces in `sessionStorage`. |
| R-02 | Medium | Recommended (product) | `apps/web/src/db/schema.ts:28`, `apps/web/src/sync/engine.ts:641` | **Pairing secret in plaintext IndexedDB, no app lock** (PLAN §5.1.5 is not implemented). It is exposed to device-level access, dev tools, malicious extensions, and any future XSS (now mitigated by S-01/S-02). The code never expires and can't be rotated except by re-pairing. Options: (a) app lock (PBKDF2 → AES-GCM over the secret and DB); (b) a "rotate pairing" flow (the old room signs over a new secret); (c) store the derived keys as non-extractable `CryptoKey`s and show the code only right after pairing. |
| R-03 | Low | Fixed | `apps/web/src/db/backup.ts:190`, `apps/web/src/sync/engine.ts:185` | **A backup can silently switch the relay.** Importing a backup applies its `relayUrl`, so a crafted backup moves signaling to an attacker's relay. That exposes metadata only (see the relay row above), not content. Don't import `relayUrl`, or ask for confirmation. |
| R-04 | Low | Fixed | `apps/web/src/db/backupCrypto.ts`, `apps/web/src/db/backup.ts` | **Backups were unencrypted JSON** with the full history, memes, names and device ids. Now the UI always encrypts: `{format: 'meme-pals-backup-encrypted', v: 1, kdf, box}`, where the key is PBKDF2-SHA256 (600,000 iterations, fresh 16-byte salt per export) → AES-GCM-256 with a fresh 12-byte IV and AAD `meme-pals-backup-v1`, and the plaintext is the old plain JSON. Passwords are at least 8 characters (UI) and NFKC-normalized. Import auto-detects the format: legacy plain files still import; `password-required`, `wrong-password` (also any tampering, which AES-GCM detects), `invalid-backup` (malformed, or KDF params outside 100k–5M iterations, so a crafted file can't hang the app). The pairing secret is still excluded (tested). **Residual:** offline guessing is limited only by the password and PBKDF2 cost; the KDF params, sizes and timestamps of the file are not hidden. **Limits:** files over 1 GiB are refused before reading. The plain JSON must fit in one JS string (about 512 MiB in Chromium) or export fails with `backup-too-large`. AES-GCM in WebCrypto is one-shot, so export and import need roughly 3–5× the plain backup size in free memory; the ciphertext is base64-encoded and decoded in 1–4 MiB chunks to avoid extra copies. |
| R-05 | Low | Fixed | `apps/web/src/sync/engine.ts:487` | **`meme-want` serves any meme in the library**, not only memes shared in the chat. A partner who knows a public meme's hash can check whether you saved it privately, and fetch it. Serve only memes referenced by a message. |
| R-06 | Low | Fixed | `apps/web/src/sync/engine.ts:433` | **`authorId` isn't tied to the partner.** It is only checked to be "not me"; the partner can author messages under arbitrary ids, and the UI shows them as the partner's. Reject `authorId !== partnerDeviceId` once it is known. |
| R-07 | Info | Recommended | `packages/shared/src/protocol.ts`, `apps/relay/src/signaling.ts` | **Relay metadata.** `roomId` and `deviceId` are stable, so the relay can link every session of the pair over time and across IPs. SDP and ICE are signed but not encrypted, so the relay sees ICE candidates. Options: derive an `enc` key with HKDF and AES-GCM-encrypt payloads; use a per-pairing device tag instead of the global deviceId. |
| R-08 | Info | Accepted | `apps/web/src/services/createAppServices.ts` (`fetchIceServers`) | **A malicious relay can push its own TURN server** via `/config`. TURN only forwards DTLS ciphertext, so it learns IPs and timing, not content. |
| R-09 | Info | Accepted (configurable) | `apps/relay/src/config.ts:8`, `apps/web/src/services/createAppServices.ts:9` | **Default STUN is Google and Cloudflare**, which see each phone's public IP and port at connect time. Operators can set `STUN_URLS=none` or run their own coturn. Without STUN, connections across different NATs need TURN. |
| R-10 | Low | Fixed | `apps/relay/src/signaling.ts:103-104` | **Signaling DoS knobs.** Sockets that never `join` are kept as long as they answer pings. The default cap is 2,000 sockets globally and 20 per IP, which is large for a 256 MB VM. Add a join deadline (e.g. 10 s) and size the caps for the deployment. Room squatting needs the room id, which only the relay knows. |
| R-11 | Info | Accepted | `apps/relay/src/proxy.ts:231` | **The image proxy passes any `image/*` type except SVG.** Responses carry `CSP: default-src 'none'; sandbox` and `nosniff`, so they are inert even if rendered as a document. The client sniffs bytes anyway. Could be tightened to the raster list. |
| R-12 | Info | Recommended | `Dockerfile:39,56` | **Container hardening.** Already done: non-root `node` user, root-owned code, `--read-only` documented. Also recommended: pin the base image by digest, run with `--cap-drop ALL --security-opt no-new-privileges`, precompile instead of using `tsx` at runtime. |
| R-13 | Info | Recommended | `deploy/coturn/turnserver.conf:30` | **Static TURN credentials are public** (sent via `/config`). Quotas and denied-peer ranges are in place. Prefer `use-auth-secret` with short-lived REST credentials minted by the relay. |
| R-14 | Info | Accepted | `apps/web/src/sync/engine.ts:652`, `apps/web/src/pwa/install.ts:58`, `apps/web/src/ui/screens/Pairing.tsx:151` | **Wipe leaves a few non-personal traces.** Wipe deletes the database and revokes object URLs. It leaves the install-hint flag in `localStorage` and the app-shell cache (no personal data). It does not affect the partner's device. Copying the code leaves it on the clipboard. |
| R-15 | Info | Accepted | `apps/relay/src/static.ts` | **`style-src 'unsafe-inline'`** is needed for the critical-paint `<style>` in `index.html`. It could be replaced by a hash computed at build time. Scripts are strict. |
| R-16 | Info | Accepted | `apps/relay/src/static.ts` (`connect-src`) | **`connect-src` allows any `wss:` relay** so that a relay chosen in Settings still works. Its `/config` and `/proxy` need `CSP_CONNECT_SRC`; without it the app falls back to default STUN and direct fetches. |

**Checked and found sound (no finding):**

- HMAC verification happens at a single entry point (`transport.ts:247-262`) before any offer, answer or ICE candidate reaches the peer connection. That covers glare handling, restarts, the watchdog and buffered candidates, which all run downstream of it.
- Answers are bound to their offer by a signed session tag. Buffered remote ICE is capped at 100 candidates.
- Chunk reassembly is bounded: 2 concurrent transfers of at most 15 MB, ordered, with size, total and length consistency checks, followed by hash verification.
- Prototype pollution: `JSON.parse` plus copying named fields only (tested).
- Static file serving: path traversal (encoded, backslash, symlink) and dotfiles are refused.
- Proxy allow-list: userinfo, ports, IDN look-alikes, IP literals, trailing dots and redirects are all re-checked (tested).
- No `dangerouslySetInnerHTML`. Outbound links use `noopener noreferrer`.
- `Referrer-Policy: no-referrer` is set three ways: the `<meta>` tag, the fetch init, and `<img referrerPolicy>`. Fetches use `credentials: 'omit'`.
- The service worker has no runtime caching.
- The relay logs only counts. There is no console logging of message content.
- The secret is never sent anywhere; only the `roomId` reaches the relay.

## 4. Operator guidance (running the relay)

1. **Serve over HTTPS** (Caddy, Fly or another TLS terminator). Plain `http://`/`ws://` works for LAN testing only; signatures still protect the handshake, but the proxies and the app shell would be open to tampering.
2. **Set `TRUST_PROXY=1` only behind exactly one reverse proxy** that appends the client IP to `X-Forwarded-For`. Per-IP limits use the last hop. Behind a chain (e.g. Cloudflare → Caddy), the last hop is the CDN, so all users share one budget.
3. **Run exactly one instance.** Rooms live in one process's memory.
4. **Keep it stateless:**
   - Run the container `--read-only`, as the non-root user it ships with. Consider `--cap-drop ALL --security-opt no-new-privileges`.
   - Mount no volumes.
   - Don't enable access logs in the reverse proxy: they would record IPs and timing. The relay itself logs only socket and room counts.
5. **Headers** come from the relay: CSP, `X-Frame-Options`, `Permissions-Policy`, `Referrer-Policy`, `nosniff`, COOP and CORP. Add HSTS at the TLS terminator (the Caddyfile does). Don't strip or override CSP in the proxy. If your users point Settings at another relay, add its origin with `CSP_CONNECT_SRC="https://other-relay.example"`.
6. **STUN and TURN:**
   - The defaults reveal users' IPs to Google and Cloudflare. For maximum privacy, set `STUN_URLS=none` and run your own coturn (`deploy/coturn`).
   - TURN credentials in `TURN_*` are handed to every client by `/config`. Treat them as public and rely on coturn's quotas. Prefer rotating them, or ephemeral credentials.
7. **Capacity and abuse:**
   - Defaults: 20 sockets per IP, 2,000 sockets in total, 50 messages per 10 s per socket, 64 KB frames.
   - Proxies: 8 concurrent requests per IP, 64 in total, 10 s upstream timeout, 20 MB images, 5 MB JSON.
   - On small VMs, lower them with the `createRelay` options (`maxConnectionsPerIp`, `rateLimit`, `proxyConcurrency`). The 2,000-socket global cap is in `apps/relay/src/signaling.ts`.
   - Anyone can use `/proxy/*` (CORS `*`, by design for split hosting). If you host the app and relay together, you may restrict `Access-Control-Allow-Origin` in `apps/relay/src/http-util.ts`.
8. **What you can see as an operator** (and could be compelled to log): IPs, timing, room ids, device ids and SDP metadata. You cannot see content. Tell your users this; section 1 does.
