#!/usr/bin/env bash
# Restaure une sauvegarde chiffrée (.sql.gz.age) dans une base PostgreSQL LOCALE vide.
# Usage : restore.sh <archive.sql.gz.age> <fichier-identite-age> <url-base-locale>
# Refuse toute cible distante (*.supabase.co, *.supabase.com, pooler) : jamais Test ni Prod.
set -euo pipefail
archive=${1:?archive .age}; identity=${2:?identite age}; target=${3:?url base locale}
case "$target" in
  *supabase.co*|*supabase.com*|*pooler*) echo "restore: cible distante refusée" >&2; exit 2;;
esac
case "$target" in
  *localhost*|*127.0.0.1*|*%2Ftmp*|*host=/*|*@/*) ;;
  *) echo "restore: seules les cibles locales (localhost/127.0.0.1/socket) sont acceptées" >&2; exit 2;;
esac
here=$(cd "$(dirname "$0")" && pwd)
n=$(psql "$target" -XAtc "select count(*) from pg_namespace where nspname in ('public','private','auth') and exists (select 1 from pg_class c where c.relnamespace=pg_namespace.oid and c.relkind='r')")
if [ "$n" != "0" ]; then echo "restore: la base cible n'est pas vide (tables présentes)" >&2; exit 3; fi
psql "$target" -X -q -v ON_ERROR_STOP=1 -f "$here/restore-preamble.sql"
# pg_dump -n public émet « CREATE SCHEMA public; » : rendu idempotent.
age -d -i "$identity" "$archive" | gunzip | sed -E 's/^CREATE SCHEMA (public|private|auth);$/CREATE SCHEMA IF NOT EXISTS \1;/' | psql "$target" -X -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null
echo "restore: OK"
psql "$target" -X -q -At -v ON_ERROR_STOP=1 -f "$here/fingerprint.sql"
