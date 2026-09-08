#!/bin/sh
# Run inside a disposable machine image, never an existing paired host:
# docker run --rm -i --entrypoint sh IMAGE -s < tests/linux-container-readiness.sh
set -eu
umask 077
test ! -e /home/clawtab/.config/clawtab/settings.yaml
sh /usr/local/bin/machine-entrypoint > /tmp/daemon.log 2>&1 &
daemon_pid=$!
trap 'kill "$daemon_pid"' EXIT
for attempt in 1 2 3 4 5; do
 if cwtctl jobs list > /tmp/jobs.log 2>&1; then break; fi
 sleep 1
done
cwtctl jobs list
test ! -e /home/clawtab/.config/clawtab/machine-paired
printf 'PASS: unpaired daemon responds to readiness probe\n'
cat > /tmp/pairing-fixture.py <<'PY'
import http.server,json,urllib.parse,pathlib
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length','0')))
  data={'pairing_id':'fixture','code':'FIXTURE','poll_token':'fixture'}
  if self.path.endswith('/poll'):data={'status':'paired','device_id':'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','device_token':'fixture'}
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode())
 def do_GET(self):
  query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
  if query.get('device_token')==['fixture']:pathlib.Path('/tmp/relay-attempted').touch()
  self.send_response(400);self.end_headers()
http.server.HTTPServer(('127.0.0.1',18643),Handler).serve_forever()
PY
python3 /tmp/pairing-fixture.py &
sleep 1
cwtctl setup --name fixture --relay http://127.0.0.1:18643 --no-service > /tmp/setup.log 2>&1
for attempt in 1 2 3 4 5; do
 if test -f /tmp/relay-attempted; then break; fi
 sleep 1
done
test -f /tmp/relay-attempted
kill -0 "$daemon_pid"
cwtctl jobs list
python3 - <<'PY'
import subprocess
from pathlib import Path
assert len(subprocess.check_output(['pgrep','-x','clawtab-daemon']).splitlines())==1
assert Path('/home/clawtab/.config/clawtab/credentials/secrets.json').stat().st_mode & 0o777 == 0o600
assert not Path('/home/clawtab/.config/systemd/user/clawtab.service').exists()
PY
printf 'PASS: pairing reloads credentials and connects the same single daemon without a restart\n'
