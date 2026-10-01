#!/usr/bin/env sh
set -eu

timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
destination="${1:-${BACKUP_DIR:-./backups}}"
retention_days="${BACKUP_RETENTION_DAYS:-30}"
remote="${RCLONE_REMOTE:-}"
age_recipient="${AGE_RECIPIENT:-}"

case "$retention_days" in
  ''|*[!0-9]*) echo 'BACKUP_RETENTION_DAYS precisa ser um inteiro positivo.' >&2; exit 2 ;;
esac
if [ "$retention_days" -lt 1 ]; then
  echo 'BACKUP_RETENTION_DAYS precisa ser pelo menos 1.' >&2
  exit 2
fi
if [ -n "$age_recipient" ] && ! command -v age >/dev/null 2>&1; then
  echo 'AGE_RECIPIENT foi definido, mas o comando age não está instalado.' >&2
  exit 2
fi
if [ -n "$remote" ] && ! command -v rclone >/dev/null 2>&1; then
  echo 'RCLONE_REMOTE foi definido, mas o comando rclone não está instalado.' >&2
  exit 2
fi
if [ -n "$remote" ] && [ -z "$age_recipient" ]; then
  echo 'Configure AGE_RECIPIENT antes de enviar dados de clientes para um destino externo.' >&2
  exit 2
fi

umask 077
mkdir -p "$destination"
chmod 700 "$destination"
destination="$(cd "$destination" && pwd)"
lock="$destination/.aether-backup.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "Já existe um backup em execução (ou um lock antigo): $lock" >&2
  exit 1
fi

database_tmp=''
uploads_tmp=''
database_encrypted_tmp=''
uploads_encrypted_tmp=''
database_final=''
uploads_final=''
manifest_tmp=''
cleanup() {
  [ -z "$database_tmp" ] || rm -f "$database_tmp"
  [ -z "$uploads_tmp" ] || rm -f "$uploads_tmp"
  [ -z "$database_encrypted_tmp" ] || rm -f "$database_encrypted_tmp"
  [ -z "$uploads_encrypted_tmp" ] || rm -f "$uploads_encrypted_tmp"
  [ -z "$manifest_tmp" ] || rm -f "$manifest_tmp"
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
database_tmp="$(mktemp "$destination/.aether-database-XXXXXX")"
uploads_tmp="$(mktemp "$destination/.aether-uploads-XXXXXX")"

docker compose exec -T db pg_dump \
  -U "${POSTGRES_USER:-aether}" \
  -d "${POSTGRES_DB:-aether}" \
  --format=custom --no-owner --no-acl > "$database_tmp"
docker compose exec -T app tar -czf - -C /app/uploads . > "$uploads_tmp"

test -s "$database_tmp"
test -s "$uploads_tmp"
database_final="$destination/aether-${timestamp}.dump"
uploads_final="$destination/aether-uploads-${timestamp}.tar.gz"
if [ -n "$age_recipient" ]; then
  database_final="$database_final.age"
  uploads_final="$uploads_final.age"
  database_encrypted_tmp="$(mktemp "$destination/.aether-encrypted-database-XXXXXX")"
  uploads_encrypted_tmp="$(mktemp "$destination/.aether-encrypted-uploads-XXXXXX")"
  age -r "$age_recipient" -o "$database_encrypted_tmp" "$database_tmp"
  age -r "$age_recipient" -o "$uploads_encrypted_tmp" "$uploads_tmp"
  mv "$database_encrypted_tmp" "$database_final"
  mv "$uploads_encrypted_tmp" "$uploads_final"
  database_encrypted_tmp=''
  uploads_encrypted_tmp=''
else
  mv "$database_tmp" "$database_final"
  mv "$uploads_tmp" "$uploads_final"
  database_tmp=''
  uploads_tmp=''
fi

manifest_tmp="$(mktemp "$destination/.aether-checksums-XXXXXX")"
(
  cd "$destination"
  sha256sum "$(basename "$database_final")" "$(basename "$uploads_final")" > "$manifest_tmp"
)
manifest_final="$destination/aether-${timestamp}.sha256"
mv "$manifest_tmp" "$manifest_final"
manifest_tmp=''
chmod 600 "$database_final" "$uploads_final" "$manifest_final"

if [ -n "$remote" ]; then
  rclone copy "$database_final" "$remote"
  rclone copy "$uploads_final" "$remote"
  rclone copy "$manifest_final" "$remote"
  rclone delete "$remote" --min-age "${retention_days}d" --include 'aether-*'
fi

find "$destination" -maxdepth 1 -type f -name 'aether-*' -mtime "+$retention_days" -delete

printf 'Backup concluído:\n  %s\n  %s\n  %s\n' "$database_final" "$uploads_final" "$manifest_final"
if [ -n "$remote" ]; then
  printf 'Cópia externa enviada para: %s\n' "$remote"
fi
