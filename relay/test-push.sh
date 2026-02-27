#!/bin/bash
# Send test push notifications to verify formatting on iOS.
# Usage: ./test-push.sh <jwt_token> [relay_url]
#
# The relay's /debug/test-push endpoint sends 6 different notification
# scenarios with a 1s delay between each:
#   1. yes_no        - 2 short options (Yes/No on single line)
#   2. france_6opts  - 6 options with descriptions (tests filtering + button limit)
#   3. tool_permission - 3 medium options
#   4. long_options  - 3 long option labels (multi-line)
#   5. short_3opts   - 3 short options (Save/Discard/Cancel)
#   6. four_options  - 4 short options (max buttons)
#
# Get your JWT token from the app or generate one.
# Your device must have a push token registered.

set -euo pipefail

TOKEN="${1:?Usage: $0 <jwt_token> [relay_url]}"
RELAY="${2:-https://relay.clawtab.com}"

# Get device token from the API by checking push_tokens
echo "Fetching device token..."
DEVICE_TOKEN=$(psql "$DATABASE_URL" -t -A -c "
  SELECT push_token FROM push_tokens
  WHERE platform = 'ios'
  ORDER BY created_at DESC
  LIMIT 1
")

if [ -z "$DEVICE_TOKEN" ]; then
  echo "No iOS push token found in database"
  exit 1
fi

echo "Using device token: ${DEVICE_TOKEN:0:20}..."
echo "Sending 6 test notifications..."
echo ""

curl -s -X POST "$RELAY/debug/test-push" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"device_token\": \"$DEVICE_TOKEN\"}" | python3 -m json.tool

echo ""
echo "Check your phone for 6 notifications."
