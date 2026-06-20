#!/usr/bin/env bash
# Import a CA certificate into the NSS shared database so Chrome for Testing
# (the Chromium build Playwright downloads) trusts it automatically — no
# Playwright/launch-flag changes needed.
#
# Why NSS and not /etc/ssl/certs: Chrome for Testing ignores the OpenSSL-style
# system bundle that curl/Node read. On Linux it reads the NSS shared DB at
# ~/.pki/nssdb instead, the same store a real Chrome install uses for
# enterprise/custom roots. This script sets that DB up and imports a CA into
# it, scoped to that one issuer (no blanket cert-validation bypass).
#
# Usage:
#   tests/e2e/trust-ca.sh <path-to-ca-cert.pem> [nickname]
#
# Env:
#   NSSDB_DIR   NSS database directory (default: $HOME/.pki/nssdb)
#
# Safe to re-run: re-importing the same nickname replaces the old entry.
set -euo pipefail

CERT_PATH="${1:-}"
if [ -z "$CERT_PATH" ]; then
  echo "Usage: $0 <path-to-ca-cert.pem> [nickname]" >&2
  exit 1
fi
if [ ! -f "$CERT_PATH" ]; then
  echo "error: no such file: $CERT_PATH" >&2
  exit 1
fi

NICKNAME="${2:-$(basename "$CERT_PATH" | sed 's/\.[^.]*$//')}"
NSSDB_DIR="${NSSDB_DIR:-$HOME/.pki/nssdb}"

if ! command -v certutil >/dev/null 2>&1; then
  echo "error: certutil not found. Install it first, e.g.:" >&2
  echo "  apt-get install -y libnss3-tools   # Debian/Ubuntu" >&2
  echo "  dnf install -y nss-tools           # Fedora/RHEL" >&2
  exit 1
fi

mkdir -p "$NSSDB_DIR"
if [ ! -f "$NSSDB_DIR/cert9.db" ]; then
  certutil -d "sql:$NSSDB_DIR" -N --empty-password
fi

if certutil -d "sql:$NSSDB_DIR" -L -n "$NICKNAME" >/dev/null 2>&1; then
  certutil -d "sql:$NSSDB_DIR" -D -n "$NICKNAME"
fi
certutil -d "sql:$NSSDB_DIR" -A -t "C,," -n "$NICKNAME" -i "$CERT_PATH"

echo "Imported '$NICKNAME' into $NSSDB_DIR as a trusted CA."
