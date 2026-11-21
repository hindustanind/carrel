#!/bin/sh
# Dev only: share the local site with a phone on any network through a free Cloudflare quick tunnel.
# Writes the tunnel URL to .tunnel-url so desk QR codes point at it (the server reads it on every request,
# and checks that the tunnel actually answers before printing it into a QR).
cd "$(dirname "$0")/.." || exit 1
command -v cloudflared >/dev/null || { echo "cloudflared is not installed: brew install cloudflared"; exit 1; }
cleanup() { rm -f .tunnel-url; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP
rm -f .tunnel-url
cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT:-8080}" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  url=$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
  if [ -n "$url" ] && [ ! -s .tunnel-url ]; then printf '%s\n' "$url" > .tunnel-url; printf '\n  Phone link: %s\n\n' "$url"; fi
done
