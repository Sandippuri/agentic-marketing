#!/usr/bin/env bash
# Daily pg_dump backup to Supabase Storage.
# Usage: DATABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> SUPABASE_URL=<url> ./pg-dump-backup.sh
#
# Requires: pg_dump, curl
# Schedule: Railway or GitHub Actions cron — daily at 02:00 UTC.

set -euo pipefail

DATE=$(date -u +%Y-%m-%d)
DUMP_FILE="/tmp/backup-${DATE}.pgdump"
BUCKET="backups"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || [ -z "${SUPABASE_URL:-}" ]; then
  echo "ERROR: SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL must be set" >&2
  exit 1
fi

echo "[pg-dump-backup] Dumping database to ${DUMP_FILE}..."
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --exclude-schema=auth \
  --exclude-schema=storage \
  --exclude-schema=realtime \
  "${DATABASE_URL}" \
  --file="${DUMP_FILE}"

echo "[pg-dump-backup] Dump complete ($(du -sh "$DUMP_FILE" | cut -f1)). Uploading..."

# Upload to Supabase Storage via REST API.
curl --silent --show-error --fail \
  -X POST \
  "${SUPABASE_URL}/storage/v1/object/${BUCKET}/${DATE}.pgdump" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${DUMP_FILE}"

echo "[pg-dump-backup] Uploaded to ${BUCKET}/${DATE}.pgdump"
rm -f "${DUMP_FILE}"
echo "[pg-dump-backup] Done."
