# clawtab-relay

Real-time WebSocket relay that routes messages between desktop and mobile clients for the [ClawTab](https://clawtab.com) AI agent scheduler. Written in Rust on `axum` + `tokio`.

This server runs in production with paying users; the code below ships from `main`.

## What it does

A desktop process running on a developer's laptop pushes events (terminal output, agent questions, pane state) to the relay. Mobile and web clients subscribe over WebSocket and receive those events in real time. Mobile clients send back answers and commands which the relay forwards to the right desktop.

```
desktop (laptop)  --WS-->  relay (this)  --WS-->  mobile / web
                  <--WS--             <--WS--
```

The relay is the only stateful hop. It holds the connection hub in memory, persists auth and notifications to Postgres, and pushes APNs notifications when the mobile app is backgrounded.

## Architecture

```
src/
  main.rs                axum app, graceful shutdown, sqlx pool, hub state
  ws/
    session.rs           per-connection handler: auth, heartbeats, fanout, framing
    hub.rs               in-memory routing table: user -> desktops / mobiles
  routes/                REST: auth, billing, device registration, share links
  auth/                  JWT, Apple/Google OAuth, password hashing (argon2)
  billing/               Apple IAP subscription validation
  apns.rs                push notification dispatch
  push_limiter.rs        per-user rate limiter (governor)
```

### Hub

`ws/hub.rs` keeps a `HashMap<UserId, Vec<DesktopConnection>>` and the same for mobile clients. Each connection owns an `mpsc::UnboundedSender<String>` so the hub can fan out a message without blocking on slow sockets. Workspace sharing lets one user's mobile receive events from another user's desktop; the hub resolves the target on every routed message.

To avoid the cold-start problem on mobile reconnect, the hub caches the last `claude_questions` and `auto_yes_panes` payload per user and replays them to newly connecting clients.

### Session loop

`ws/session.rs` runs one `tokio::select!` loop per connection. Three concurrent sources:

1. `rx.recv()` - outbound messages from the hub, written to the WS sink
2. `ws_stream.next()` - inbound frames from the client (text, pong, close)
3. `heartbeat.tick()` - 30s ping interval, 90s timeout

Pong timestamps are tracked per connection; a missed heartbeat closes the socket. Mobile and desktop have separate handlers because they have different message vocabularies and different replay rules.

### Backpressure and isolation

- Outbound queues are per-connection `mpsc` channels, so a slow mobile cannot stall the desktop or other mobiles.
- The hub uses a single `RwLock` for the routing table. Read-heavy paths (every forwarded message) take the read lock; only connect/disconnect take the write lock.
- DB writes for answered questions are spawned with `tokio::spawn` so the WS hot path never waits on Postgres.

### Persistence

Postgres via `sqlx`. Schema in `migrations/`:

- `001_initial.sql` users, devices, sessions
- `002_google_auth.sql`, `007_apple_auth.sql` OAuth identities
- `003_billing.sql` Apple IAP subscriptions
- `004_push_notifications.sql` APNs tokens and notification history
- `005_workspace_shares.sql`, `006_share_allowed_groups.sql` cross-user sharing

Redis is used for transient state (push rate-limiter buckets, notification dedup).

## Production posture

- `cargo` lints set `unwrap_used`, `expect_used`, `panic` to `deny`; warnings deny in CI.
- Release profile: `lto = true`, `codegen-units = 1`, `panic = "abort"`.
- `tracing` with `EnvFilter` for structured logs; every connection lifecycle event is logged with `user_id` and `connection_id`.
- Graceful shutdown on `SIGTERM`: stop accepting new connections, drain the hub, close DB pool.
- Rate limiting on push endpoints via `tower_governor`.

## Stack

`axum 0.8` `tokio` `sqlx` (Postgres) `redis` `jsonwebtoken` `argon2` `a2` (APNs) `governor` `tracing`

## Related

- [`../desktop`](../desktop) Tauri desktop client (Rust)
- [`../remote`](../remote) Web client (TypeScript, React)
- [`../protocol`](../protocol) shared message types
