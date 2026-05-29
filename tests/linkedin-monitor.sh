#!/usr/bin/env bash
# LinkedIn Selector & Affinity Heartbeat Monitor using agent-browser

set -euo pipefail

LI_AT="${LINKEDIN_LI_AT:-}"
JSESSIONID="${LINKEDIN_JSESSIONID:-}"
AFFINITY_API_KEY="${AFFINITY_API_KEY:-}"
REPORT_DIR="$(dirname "$0")"
STATUS_FILE="$REPORT_DIR/monitor-status.json"

log() { echo "$(date '+%H:%M:%S') $1"; }

update_status() {
  local status="$1"
  local message="$2"
  # Simplified status update via node
  node -e "
    const fs = require('fs');
    const path = require('path');
    const statusPath = '$STATUS_FILE';
    const data = {
      status: '$status',
      lastRun: new Date().toISOString(),
      message: '$message'
    };
    fs.writeFileSync(statusPath, JSON.stringify(data, null, 2));
  "
}

# 1. Affinity Heartbeat
if [[ -n "$AFFINITY_API_KEY" ]]; then
  log "🚀 Starting monitor: Affinity API Heartbeat"
  AUTH=$(echo -n ":$AFFINITY_API_KEY" | base64)
  if curl -sf -H "Authorization: Basic $AUTH" https://api.affinity.co/whoami > /dev/null; then
    log "✅ Affinity Connected."
  else
    log "❌ Affinity Heartbeat Failed."
    update_status "FAILED" "Affinity API Heartbeat failure"
    exit 1
  fi
fi

# 2. LinkedIn Selector Stability
if [[ -z "$LI_AT" || -z "$JSESSIONID" ]]; then
  log "⚠️ Missing LinkedIn credentials. Skipping live UI check."
  # No creds in this environment. Run a static check and emit SKIPPED (not a
  # silent exit) so the Navigator reports a known, non-degrading state rather
  # than UNKNOWN — a missing status file looks like a dead monitor.
  MANIFEST="$REPORT_DIR/../Extension/manifest.json"
  if [[ -f "$MANIFEST" ]] && node -e "JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'))" 2>/dev/null; then
    update_status "SKIPPED" "Static config OK (manifest valid); live LinkedIn UI check skipped - no credentials in this environment"
    log "⏭️  Wrote SKIPPED status (static config valid)."
    exit 0
  else
    update_status "FAILED" "Extension manifest.json missing or invalid"
    log "❌ manifest.json missing or invalid."
    exit 1
  fi
fi

log "🚀 Starting monitor: LinkedIn UI Selectors"

# Create temporary auth state
AUTH_JSON="/tmp/linkedin-auth.json"
cat > "$AUTH_JSON" <<EOF
{
  "cookies": [
    { "name": "li_at", "value": "$LI_AT", "domain": ".linkedin.com", "path": "/" },
    { "name": "JSESSIONID", "value": "\"$JSESSIONID\"", "domain": ".www.linkedin.com", "path": "/" }
  ]
}
EOF

cleanup() {
  rm -f "$AUTH_JSON"
  agent-browser close --session linkedin-monitor || true
}
trap cleanup EXIT

try_monitor() {
  # Use a named session for isolation
  agent-browser --session linkedin-monitor --state "$AUTH_JSON" open "https://www.linkedin.com/messaging/"
  agent-browser --session linkedin-monitor wait 1000
  
  log "⏳ Checking for messaging list..."
  # Take a snapshot to find interactive elements
  SNAPSHOT=$(agent-browser --session linkedin-monitor snapshot -i)
  
  if ! echo "$SNAPSHOT" | grep -q "msg-conversations-container"; then
    log "❌ Messaging list not found in snapshot."
    return 1
  fi

  log "🖱️ Clicking first conversation thread..."
  # Use semantic locator instead of raw selector
  agent-browser --session linkedin-monitor click ".msg-conversation-listitem" || \
  agent-browser --session linkedin-monitor find role listitem click

  log "🔍 Verifying header and name extraction..."
  # Snapshot again to get new refs
  SNAPSHOT=$(agent-browser --session linkedin-monitor snapshot -i)
  
  if echo "$SNAPSHOT" | grep -qE "msg-entity-lockup|msg-thread__topcard"; then
    log "✅ Selectors are stable."
    update_status "PASSED" "LinkedIn & Affinity Ecosystem is stable"
    return 0
  else
    log "❌ UI Selectors mismatch."
    # Capture debug data
    agent-browser --session linkedin-monitor screenshot "$REPORT_DIR/debug-linkedin-state.png"
    agent-browser --session linkedin-monitor get text body > "$REPORT_DIR/debug-linkedin-state.txt"
    return 1
  fi
}

if try_monitor; then
  log "✨ Monitor completed successfully."
else
  log "❌ Monitor failed."
  update_status "FAILED" "LinkedIn Selector failure"
  exit 1
fi
