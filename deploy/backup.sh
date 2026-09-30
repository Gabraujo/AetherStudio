#!/usr/bin/env sh
set -eu

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="${1:-./backups}"
mkdir -p "$destination"
chmod 700 "$destination"

database_tmp="$(mktemp "$destination/.aether-database-XXXXXX")"
uploads_tmp=''
cleanup() {
  rm -f "$database_tmp"
  [ -z "$uploads_tmp" ] || rm -f "$uploads_tmp"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
uploads_tmp="$(mktemp "$destination/.aether-uploads-XXXXXX")"

docker compose exec -T db pg_dump \
  -U "${POSTGRES_USER:-aether}" \
  -d "${POSTGRES_DB:-aether}" \
  --format=custom --no-owner --no-acl > "$database_tmp"
docker compose exec -T app tar -czf - -C /app/uploads . > "$uploads_tmp"

test -s "$database_tmp"
test -s "$uploads_tmp"

database_backup="$destination/aether-${timestamp}.dump"
uploads_backup="$destination/aether-uploads-${timestamp}.tar.gz"
chmod 600 "$database_tmp" "$uploads_tmp"
mv "$database_tmp" "$database_backup"
mv "$uploads_tmp" "$uploads_backup"

printf 'Backups criados:\n  %s\n  %s\n' "$database_backup" "$uploads_backup"
