# Self-Hosted Deployment

You can run your own relay server instead of using the hosted service at `relay.clawtab.cc`. This gives you full control over your data and removes the subscription requirement.

## Docker Compose (recommended)

The quickest way to get running. This starts the relay server, PostgreSQL, and optionally a frontend.

```bash
cd etc/
cp .env.example .env
# Edit .env with your settings
docker compose up -d
```

### .env file

Create an `.env` file in the `etc/` directory:

```bash
# Required
JWT_SECRET=your-secret-key-here

# Optional
POSTGRES_PASSWORD=clawtab
CORS_ORIGINS=http://localhost:3000
FRONTEND_IMAGE=clawtab-frontend
```

Generate a JWT secret:

```bash
openssl rand -base64 32
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| relay | 8080 | WebSocket relay + REST API |
| postgres | 5432 | PostgreSQL 17 |
| frontend | 3000 | Web frontend (optional) |

The relay runs with `SELF_HOSTED=true`, which disables subscription checks. All authenticated users can connect without a paid plan.

### Database migrations

Migrations run automatically on relay startup. The relay reads from the `migrations/` directory and applies any pending migrations.

## Manual setup

If you prefer to run the relay binary directly:

### 1. PostgreSQL

Set up a PostgreSQL database:

```bash
createdb clawtab
```

### 2. Build the relay

```bash
cd relay/
cargo build --release
```

The binary is at `relay/target/release/clawtab-relay`.

### 3. Configure environment

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | Secret for signing access tokens |
| `LISTEN_ADDR` | no | Bind address (default: `0.0.0.0:8080`) |
| `SELF_HOSTED` | no | Set to `true` to skip subscription checks |
| `RUST_LOG` | no | Log level (default: `clawtab_relay=info`) |
| `CORS_ORIGINS` | no | Comma-separated allowed origins |
| `GOOGLE_CLIENT_ID` | no | Enables Google OAuth sign-in |
| `GOOGLE_CLIENT_SECRET` | no | Enables Google OAuth sign-in |
| `MAX_CONNECTIONS_PER_USER` | no | Max concurrent WebSocket connections (default: 5) |

### 4. Run

```bash
DATABASE_URL=postgres://user:pass@localhost/clawtab \
JWT_SECRET=your-secret \
SELF_HOSTED=true \
./clawtab-relay
```

## Connecting the desktop app

In ClawTab's Remote panel, enter your relay URL (e.g., `https://relay.example.com`) during setup. Create an account on your relay, then pair your device as usual.

## Connecting the mobile app

Point the mobile app at your relay URL in the login screen. Sign in with the same account you created on your relay.

## Reverse proxy

The relay needs WebSocket support. Example nginx config:

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

## Updating

Pull the latest code and rebuild:

```bash
git pull
docker compose up -d --build
```

The relay applies pending database migrations on startup, so no manual migration step is needed.
