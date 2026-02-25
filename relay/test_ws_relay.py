#!/usr/bin/env python3
"""
Test the WebSocket relay: simulates a desktop app and a mobile client
communicating through the relay server.

Flow:
  1. Register user, pair a device
  2. Connect desktop via device_token
  3. Connect mobile via JWT
  4. Mobile sends list_jobs -> relay -> desktop
  5. Desktop responds with jobs_list -> relay -> mobile
  6. Desktop pushes status_update -> relay -> mobile
  7. Mobile sends run_job -> desktop offline error (after desktop disconnects)
"""

import asyncio
import json
import sys
import urllib.request

API = "http://127.0.0.1:8090"
WS  = "ws://127.0.0.1:8090/ws"

def api(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode(), "status": e.code}

def ok(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    suffix = f" - {detail}" if detail else ""
    print(f"  [{status}] {label}{suffix}")
    if not condition:
        sys.exit(1)

async def main():
    import websockets

    print("--- Setup: register user + pair device ---")
    reg = api("POST", "/auth/register", {"email": "ws-test@example.com", "password": "testpass123"})
    ok("register", "user_id" in reg, reg.get("user_id", ""))
    access_token = reg["access_token"]

    pair = api("POST", "/devices/pair", {"device_name": "Test MacBook"}, token=access_token)
    ok("pair device", "device_token" in pair, pair.get("device_id", ""))
    device_token = pair["device_token"]

    print("\n--- Connect desktop via device_token ---")
    desktop = await websockets.connect(f"{WS}?device_token={device_token}")
    welcome_d = json.loads(await desktop.recv())
    ok("desktop welcome", welcome_d["type"] == "welcome", f"conn={welcome_d['connection_id']}")

    print("\n--- Connect mobile via JWT ---")
    mobile = await websockets.connect(f"{WS}?token={access_token}")
    welcome_m = json.loads(await mobile.recv())
    ok("mobile welcome", welcome_m["type"] == "welcome", f"conn={welcome_m['connection_id']}")

    # Mobile should also receive desktop_status (online) since desktop was already connected
    # Actually it won't because the desktop connected before mobile registered in hub.
    # The desktop_status is only sent when desktop connects/disconnects while mobile is listening.

    print("\n--- Mobile -> list_jobs -> Desktop ---")
    await mobile.send(json.dumps({"type": "list_jobs", "id": "req-1"}))

    # Desktop should receive the forwarded message
    msg = json.loads(await asyncio.wait_for(desktop.recv(), timeout=3))
    ok("desktop receives list_jobs", msg["type"] == "list_jobs" and msg["id"] == "req-1")

    # Desktop responds with jobs_list
    fake_jobs = [
        {"name": "deploy-api", "job_type": "claude", "enabled": True,
         "cron": "0 */6 * * *", "group": "deploy", "slug": "deploy-api"}
    ]
    await desktop.send(json.dumps({
        "type": "jobs_list",
        "id": "req-1",
        "jobs": fake_jobs,
        "statuses": {"deploy-api": {"state": "idle"}}
    }))

    # Mobile receives the response
    msg = json.loads(await asyncio.wait_for(mobile.recv(), timeout=3))
    ok("mobile receives jobs_list",
       msg["type"] == "jobs_list" and msg["id"] == "req-1" and len(msg["jobs"]) == 1,
       f"got {len(msg.get('jobs', []))} jobs")

    print("\n--- Mobile -> run_job -> Desktop ---")
    await mobile.send(json.dumps({"type": "run_job", "id": "req-2", "name": "deploy-api"}))
    msg = json.loads(await asyncio.wait_for(desktop.recv(), timeout=3))
    ok("desktop receives run_job", msg["type"] == "run_job" and msg["name"] == "deploy-api")

    # Desktop acks
    await desktop.send(json.dumps({"type": "run_job_ack", "id": "req-2", "success": True}))
    msg = json.loads(await asyncio.wait_for(mobile.recv(), timeout=3))
    ok("mobile receives run_job_ack", msg["type"] == "run_job_ack" and msg["success"] is True)

    print("\n--- Desktop pushes status_update ---")
    await desktop.send(json.dumps({
        "type": "status_update",
        "name": "deploy-api",
        "status": {"state": "running", "run_id": "abc-123", "started_at": "2026-01-01T00:00:00Z"}
    }))
    msg = json.loads(await asyncio.wait_for(mobile.recv(), timeout=3))
    ok("mobile receives status_update",
       msg["type"] == "status_update" and msg["status"]["state"] == "running",
       f"state={msg['status']['state']}")

    print("\n--- Desktop pushes log_chunk ---")
    await desktop.send(json.dumps({
        "type": "log_chunk",
        "name": "deploy-api",
        "content": "Deploying to production...\nStep 1/3: Building\n",
        "timestamp": "2026-01-01T00:00:05Z"
    }))
    msg = json.loads(await asyncio.wait_for(mobile.recv(), timeout=3))
    ok("mobile receives log_chunk",
       msg["type"] == "log_chunk" and "Deploying" in msg["content"],
       f"{len(msg['content'])} bytes")

    print("\n--- Mobile -> send_input -> Desktop ---")
    await mobile.send(json.dumps({
        "type": "send_input", "id": "req-3", "name": "deploy-api", "text": "yes"
    }))
    msg = json.loads(await asyncio.wait_for(desktop.recv(), timeout=3))
    ok("desktop receives send_input",
       msg["type"] == "send_input" and msg["text"] == "yes")

    print("\n--- Desktop disconnects ---")
    await desktop.close()
    await asyncio.sleep(0.5)

    # Mobile should receive desktop_status offline
    msg = json.loads(await asyncio.wait_for(mobile.recv(), timeout=3))
    ok("mobile receives desktop_status offline",
       msg["type"] == "desktop_status" and msg["online"] is False,
       f"device={msg.get('device_name', '?')}")

    print("\n--- Mobile sends command while desktop offline ---")
    await mobile.send(json.dumps({"type": "list_jobs", "id": "req-4"}))
    msg = json.loads(await asyncio.wait_for(mobile.recv(), timeout=3))
    ok("mobile receives DESKTOP_OFFLINE error",
       msg["type"] == "error" and msg["code"] == "DESKTOP_OFFLINE",
       msg.get("message", ""))

    await mobile.close()
    print("\n--- All tests passed ---")

asyncio.run(main())
