# Private Meme Sharing App — Build Plan

> Status: **Built.** All waves are merged. 331 unit and integration tests plus 28 two-device E2E tests pass, and the security review is in docs/SECURITY.md. See README.md for usage.
>
> Deviations from this draft: the pairing fallback is a typed code (`XXXX-XXXX-…`) rather than 12 words. The optional app-lock passcode (§5.1.5) is deferred. A wiped phone without a backup recovers only the partner's messages (§10).

## 1. Goals and constraints

| # | Requirement | How the design meets it |
|---|-------------|-------------------------|
| 1 | Private app for two people (you and your partner) | Devices are paired once with a QR code or pairing code. The relay lets only paired devices into a room. |
| 2 | Uses the Internet to fetch memes | Reddit meme subreddits and Imgflip templates are fetched live. |
| 3 | Chat features | Text chat, meme messages, reactions, replies, typing indicator, read receipts. |
| 4 | **Nothing stored in the cloud** | All messages, memes and settings live only in each device's IndexedDB. Traffic goes device to device over encrypted WebRTC. The relay is stateless: it holds data in memory only for the seconds a handshake takes and has no database or disk writes. |
| 5 | Runs on both of your phones | An installable web app (PWA): "Add to Home Screen" on iOS and Android, and it also works in desktop browsers. |

**Non-goals for v1:** group chats, more than two people, voice or video calls, and push notifications while the app is closed. Push would require a cloud push service, which breaks constraint 4.

## 2. Architecture

```
   Phone A (PWA)                                           Phone B (PWA)
 ┌──────────────────┐                                   ┌──────────────────┐
 │ UI (React)       │                                   │ UI (React)       │
 │ Meme sources ────┼──► Reddit / Imgflip (HTTPS GET)   │                  │
 │ Sync engine      │                                   │ Sync engine      │
 │ IndexedDB (Dexie)│◄═══ WebRTC DataChannel (DTLS) ═══►│ IndexedDB (Dexie)│
 └────────┬─────────┘     encrypted, device to device   └────────┬─────────┘
          │  WebSocket (signaling only:                          │
          │  SDP and ICE, signed with the pairing key)           │
          └──────────────►  Relay (Node, stateless)  ◄───────────┘
                            · in-memory rooms (max 2 peers)
                            · no DB, no logs of content
```

- **Static app hosting:** the PWA is plain HTML/JS/CSS. It can be served by the relay itself or by GitHub Pages. That host only serves the app's code, never your data.
- **STUN:** public STUN servers are used for NAT traversal and carry no data.
- **TURN (optional):** some mobile carriers use strict NATs that block direct connections. For those cases, the plan includes an optional self-hosted `coturn` config. TURN forwards the already-encrypted stream and stores nothing.

## 3. Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Monorepo | pnpm workspaces | Shared protocol types between app and relay |
| Web app | Vite + React + TypeScript | Fast, well-known, easy to test |
| PWA | `vite-plugin-pwa` (Workbox) | Install prompt and offline shell |
| Local DB | Dexie (IndexedDB) | Indexed queries, schema migrations, stores image blobs |
| P2P | Native `RTCPeerConnection` + DataChannel | No third-party SDK or cloud |
| Crypto | WebCrypto (HKDF, HMAC-SHA256, AES-GCM) | Built into browsers, no dependencies |
| Relay | Node 20 + `ws` | ~200 lines, easy to audit |
| QR | `qrcode` (generate) + `jsQR` (scan) | Fully offline pairing |
| Tests | Vitest, `fake-indexeddb`, Playwright | Unit, integration, and two-browser end-to-end tests |

## 4. Repository layout

```
meme_sharing_app/
├── packages/shared/        # protocol types, message schemas, crypto helpers
├── apps/relay/             # stateless signaling relay (+ Dockerfile)
├── apps/web/
│   └── src/
│       ├── p2p/            # WebRTC connection manager, signaling client, framing
│       ├── db/             # Dexie schema, repositories, outbox, backup
│       ├── sync/           # reconciliation protocol between the two devices
│       ├── memes/          # Reddit, Imgflip, meme maker, upload processing
│       ├── ui/             # screens and components
│       └── pwa/            # manifest, service worker config, icons
├── e2e/                    # Playwright two-device tests
├── deploy/                 # relay deploy guide, optional coturn config
└── PLAN.md
```

## 5. Core design

### 5.1 Pairing and security

1. Device A creates a 32-byte random **pairing secret** and shows it as a QR code (and a 12-word fallback code).
2. Device B scans the code. Both devices derive these keys with HKDF:
   - `roomId = HKDF(secret, "room")`: the opaque ID used at the relay. The relay never sees the secret.
   - `authKey = HKDF(secret, "auth")`: used to HMAC-sign every signaling message.
3. Each device checks the signature on every SDP offer or answer it receives. SDP includes the DTLS certificate fingerprint, so a malicious relay can't run a man-in-the-middle attack.
4. Once connected, all data flows over DTLS-encrypted DataChannels.
5. **Optional app lock:** a local passcode encrypts the IndexedDB contents with AES-GCM, using a key derived via PBKDF2.

### 5.2 Local data model (Dexie)

| Table | Key fields |
|-------|-----------|
| `profile` | deviceId, displayName, avatar, pairing secret (stays on the device) |
| `messages` | id (ULID), authorId, kind (`text`/`meme`/`reaction`), body, memeId?, replyTo?, createdAt, deliveredAt?, readAt? |
| `memes` | id (SHA-256 of content), blob, mime, width, height, source (`reddit`/`imgflip`/`upload`/`maker`), sourceUrl?, title?, savedAt |
| `favorites` | memeId, addedAt |
| `outbox` | messageId, attempts, lastTriedAt |
| `settings` | subreddits[], theme, relayUrl, lock options |

Memes are content-addressed: the same image is stored once, and a peer is never sent an image it already has.

### 5.3 Wire protocol (over the DataChannel)

These are JSON frames, defined in `packages/shared`:

- `hello { deviceId, lastSeenUlid }`: sent on every connect and starts sync.
- `msg { message }`, then `ack { id }`
- `meme-offer { memeId, mime, size }`, then `meme-want { memeId }` (only if missing), then the binary chunks: 16 KB frames with a header `{memeId, seq, total}`. The receiver verifies the SHA-256 when all chunks are in.
- `typing`, `read { upToId }`, `react { messageId, emoji }`

### 5.4 Offline and sync

- When your partner is offline, sent messages go to the `outbox` and show a "pending" state.
- On reconnect, each side sends `hello` with its latest ULID. The other side streams every message newer than that ULID. ULIDs sort by time, so the result is the same on both devices.
- The connection manager reconnects with exponential backoff and handles the PWA moving between background and foreground.

### 5.5 Meme sources

- **Reddit:** `https://www.reddit.com/r/<sub>/hot.json`. The default subs are r/memes, r/wholesomememes, r/me_irl and r/dankmemes, and you can edit the list. The feed filters out NSFW posts and non-image posts, and has infinite scroll.
  - *Risk:* Reddit may block browser (CORS) requests or rate-limit unauthenticated access. *Fallback:* the relay exposes a stateless `/proxy/reddit` passthrough with an allow-list and no caching.
- **Imgflip:** templates come from `https://api.imgflip.com/get_memes`. Captions are **drawn on the device with `<canvas>`**. Imgflip's caption API isn't used, because it would upload and host your meme on Imgflip's servers.
- **Uploads:** pick images or GIFs from the device. Still images are resized (max 1600 px) and re-encoded to WebP, and EXIF and location metadata is removed. GIFs are kept as-is up to 15 MB.
- **Sharing:** "Send to partner" saves the actual image bytes on your device and sends them over P2P, so memes don't disappear if Reddit deletes them.

### 5.6 Screens

1. **Onboarding and pairing:** set a name, then show or scan the QR code.
2. **Chat:** message list, meme bubbles, reactions, reply, typing and online indicators, pending and read status.
3. **Discover:** Reddit feed with sub tabs; long-press or tap to send or favorite.
4. **Meme Maker:** template picker, text boxes, live canvas preview, send.
5. **Gallery:** every meme you've exchanged, plus favorites, with search by title.
6. **Settings:** relay URL, subreddits, theme, app lock, **export/import a backup file**, re-pair, wipe device.

## 6. Hosting the relay

The relay is the one piece both phones must be able to reach. It stores nothing. Options, in recommended order:

1. **A free or cheap container host** (Fly.io, Render, or a $4 VPS) running the provided Dockerfile. It has no volume attached, so it physically can't persist data.
2. **A home computer or Raspberry Pi** exposed through Tailscale Funnel or Cloudflare Tunnel.
3. **For development:** `pnpm dev` runs the relay and the app on localhost.

`deploy/README.md` will cover each option step by step.

## 7. Testing strategy

| Level | What | Tool |
|-------|------|------|
| Unit | crypto derivation and HMAC, framing and chunking, sync reconciliation, Dexie repositories, Reddit parsing, image processing | Vitest + fake-indexeddb |
| Relay | room limit of 2, signature passthrough, rate limiting, no state left after disconnect | Vitest + `ws` client |
| E2E | Two browser contexts pair, chat, send a Reddit meme, send an upload, go offline and come back, and messages sync | Playwright + local relay |
| Privacy check | Automated test that the relay process writes no files, plus a network log check that message content never reaches the relay | Playwright + fs watch |

## 8. Agent work breakdown

Work runs in **waves**. Each agent owns specific directories so parallel agents don't conflict. Each works in its own git worktree, and I merge and review the results.

### Wave 0: Foundations (me, the lead agent)

- Scaffold the pnpm monorepo, TypeScript, ESLint, Vitest and the `pnpm dev` script.
- Write `packages/shared`: protocol types, frame schemas and crypto helpers. This is **the contract** every other agent codes against.
- Write the interface files every agent depends on: `P2PClient`, `MessageRepo`, `MemeRepo`, `MemeSource`.

### Wave 1: Parallel build (5 agents)

| Agent | Owns | Deliverables | Done when |
|-------|------|--------------|-----------|
| **A1 Relay** | `apps/relay/`, `deploy/` | WebSocket signaling, rooms, rate limits, optional Reddit proxy, Dockerfile, coturn sample | Relay tests pass; it writes no files |
| **A2 P2P** | `apps/web/src/p2p/` | Signaling client with HMAC, connection manager, reconnects, chunked binary transfer | Two connected peers in Node tests exchange frames and a 5 MB blob |
| **A3 Storage & Sync** | `apps/web/src/db/`, `apps/web/src/sync/` | Dexie schema, repositories, outbox, ULID sync, backup export/import, optional encryption at rest | Sync converges in randomized offline/online tests |
| **A4 Memes** | `apps/web/src/memes/` | Reddit client, Imgflip templates, canvas meme maker, upload resize/strip-EXIF | Parsers and image-pipeline tests pass |
| **A5 UI & PWA** | `apps/web/src/ui/`, `apps/web/src/pwa/` | All six screens built against mock services, plus manifest, icons and service worker | App builds, Lighthouse PWA "installable" check passes, mobile layouts look right |

### Wave 2: Integration (me plus A6)

- I connect the UI to the real P2P, DB and meme modules and fix interface mismatches.
- **A6 QA:** Playwright two-device E2E suite, privacy checks, and a security review of pairing and the relay.

### Wave 3: Polish and docs (1 agent)

- README with screenshots, an "install on your phone" guide, the relay deploy guide, and a troubleshooting section for NAT and TURN.

**Merge rule:** a wave's branch is merged only when `pnpm typecheck && pnpm test` passes. All work lands on the `claude/private-meme-app-local-cuhnlh` branch.

## 9. Milestones

| Milestone | Result you can try |
|-----------|-------------------|
| M1 (after Wave 1 and integration) | Two browser tabs on one computer pair and chat |
| M2 | Send Reddit memes and uploads between two phones over the Internet |
| M3 | Meme maker, gallery, favorites, offline sync |
| M4 | Installable PWA, app lock, backups, deploy guide |

## 10. Risks and open items

| Risk | Mitigation |
|------|-----------|
| Reddit blocks unauthenticated or CORS requests | Stateless relay proxy fallback. The feed source is pluggable, so others can be added later. |
| Strict mobile NAT blocks the direct connection | Optional self-hosted TURN (encrypted pass-through) |
| iOS may evict PWA storage | Call `navigator.storage.persist()`, show a reminder to install to the Home Screen, and offer regular backup exports |
| No notifications while the app is closed | Accepted for v1. Real push requires a cloud push service, which conflicts with the privacy goal. |
| Losing a phone means losing its history | The partner's device keeps a full copy, but only the partner's own messages re-sync after re-pairing (a wiped phone gets a new device id). Regular backup exports restore everything. |
