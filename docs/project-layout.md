# Project Layout

The ClawTab repository is organized as a monorepo with four main components.

```
desktop/         Tauri desktop app (macOS)
mobile/          React Native mobile app (iOS/Android)
relay/           Relay server (Rust, Axum, PostgreSQL)
protocol/        Shared message types (Rust crate)
etc/             Deployment configs (Docker, Dockerfiles)
```

## desktop

The macOS desktop app built with Tauri 2, React 19, and Rust. This is the core of ClawTab - it runs jobs in tmux, manages secrets, and connects to the relay for remote access.

Key paths:

| Path | Description |
|------|-------------|
| `src/` | React frontend (settings UI, job editor, panels) |
| `src-tauri/src/` | Rust backend (scheduler, executor, relay client, IPC) |
| `src-tauri/src/bin/ctl.rs` | `cwtctl` CLI |
| `src-tauri/src/bin/tui.rs` | `cwttui` terminal UI |
| `docs/` | Documentation |

## relay

The relay server bridges the desktop and mobile apps over WebSocket. It handles user authentication, device pairing, and message routing.

Key paths:

| Path | Description |
|------|-------------|
| `src/main.rs` | Server entry point |
| `src/ws/` | WebSocket hub and session management |
| `src/routes/` | HTTP routes (auth, devices, billing) |
| `src/auth/` | JWT, password hashing, Google OAuth |
| `migrations/` | PostgreSQL schema migrations |

The relay is stateless aside from PostgreSQL. Multiple instances can run behind a load balancer.

## protocol

A shared Rust crate defining the message types exchanged between desktop and mobile over the relay. Both `desktop/src-tauri` and `relay` depend on this crate.

```
protocol/src/
  lib.rs           Re-exports
  messages.rs      WebSocket message enums (commands, updates, server messages)
  job.rs           Job and status types
```

Keeping the protocol in its own crate ensures the desktop and relay always agree on message format at compile time.

## mobile

React Native (Expo) app for iOS and Android. Connects to the relay server to control your desktop's jobs remotely.

Key paths:

| Path | Description |
|------|-------------|
| `app/` | Expo Router screens (tabs, job detail, auth) |
| `src/store/` | Zustand stores (auth, jobs, WebSocket) |
| `src/hooks/` | WebSocket connection, log streaming |
| `src/components/` | Shared UI components |

## etc

Deployment configurations for self-hosting.

| Path | Description |
|------|-------------|
| `docker-compose.yaml` | Full stack: relay + PostgreSQL + frontend |
| `Dockerfile.relay` | Multi-stage relay build |
