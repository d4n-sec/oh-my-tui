#!/bin/sh
# Generate a throwaway CA and a server certificate for local Colima use.
# SAN includes `server` (the compose service name), localhost, and 127.0.0.1.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ -f ca.pem ] && [ -f server.pem ] && [ -f server.key ]; then
  echo "certs already present in $DIR"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout ca.key -out ca.pem -subj "/CN=Oh-My-TUI Dev CA" >/dev/null 2>&1

openssl req -newkey rsa:2048 -nodes \
  -keyout server.key -out server.csr -subj "/CN=server" >/dev/null 2>&1

cat > server.ext <<'EOF'
subjectAltName=DNS:server,DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF

openssl x509 -req -days 3650 -in server.csr -CA ca.pem -CAkey ca.key \
  -CAcreateserial -out server.pem -extfile server.ext >/dev/null 2>&1

rm -f server.csr server.ext
echo "generated ca.pem, server.pem, server.key in $DIR"
