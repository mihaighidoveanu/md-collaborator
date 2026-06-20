#!/usr/bin/env bash
# Session-spawn setup: imports this sandbox's egress-gateway CA into the NSS
# shared database so Chrome for Testing (the Chromium build Playwright
# downloads) trusts it automatically — no Playwright/launch-flag changes
# needed. Chrome for Testing ignores the OpenSSL-style bundle Node/curl use
# and reads ~/.pki/nssdb instead, same as a real Chrome install.
#
# No args, no env vars — hardcoded for this environment so it can run
# unattended on every fresh container. Safe to re-run.
set -euo pipefail

CERT_PATH="/usr/local/share/ca-certificates/egress-gateway-ca-production.crt"
NICKNAME="egress-gateway-ca-production"
NSSDB_DIR="$HOME/.pki/nssdb"

if [ ! -f "$CERT_PATH" ]; then
  echo "trust-ca.sh: no such file: $CERT_PATH, skipping" >&2
  exit 0
fi

if ! command -v certutil >/dev/null 2>&1; then
  apt-get install -y libnss3-tools >/dev/null
fi

mkdir -p "$NSSDB_DIR"
if [ ! -f "$NSSDB_DIR/cert9.db" ]; then
  certutil -d "sql:$NSSDB_DIR" -N --empty-password
fi

if certutil -d "sql:$NSSDB_DIR" -L -n "$NICKNAME" >/dev/null 2>&1; then
  certutil -d "sql:$NSSDB_DIR" -D -n "$NICKNAME"
fi
certutil -d "sql:$NSSDB_DIR" -A -t "C,," -n "$NICKNAME" -i "$CERT_PATH"

echo "trust-ca.sh: imported '$NICKNAME' into $NSSDB_DIR"
