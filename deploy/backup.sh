#!/bin/sh
# Run on Unraid. Archives contain private lyrics, account data and APP_KEY.
set -eu
umask 077
if [ "$#" -ne 4 ]; then
    echo 'Usage: sh deploy/backup.sh APPDATA_ROOT DB_CONTAINER DB_USER DB_NAME' >&2
    exit 1
fi
data_root=$1
db_container=$2
db_user=$3
db_name=$4
case "$db_container" in ''|-*|*[!a-zA-Z0-9_.-]*) echo 'Invalid database container.' >&2; exit 1;; esac
case "$db_user:$db_name" in *[!a-zA-Z0-9_:]*) echo 'Use simple database and user names.' >&2; exit 1;; esac
test -n "$db_user"
test -n "$db_name"
: "${LF_DB_PASSWORD:?Export LF_DB_PASSWORD before running the backup.}"
test -f "$data_root/config/production.env"
test -d "$data_root/data/storage"
mkdir -p "$data_root/backups"
backup_dir="$data_root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$backup_dir"
cleanup() { rm -f "$backup_dir/database.sql.partial" "$backup_dir/image.tar.partial"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# A separate file preserves the dump exit status without a shell pipeline.
docker exec -e MYSQL_PWD="$LF_DB_PASSWORD" "$db_container" \
    mariadb-dump -u "$db_user" --single-transaction --skip-lock-tables --hex-blob "$db_name" \
    > "$backup_dir/database.sql.partial"
test -s "$backup_dir/database.sql.partial"
gzip -c "$backup_dir/database.sql.partial" > "$backup_dir/database.sql.gz"
tar -czf "$backup_dir/config-storage.tar.gz" -C "$data_root" config data/storage
# The configured tag can since have moved; save the exact image running the service.
docker inspect --format '{{.Image}}' lyricflow > "$backup_dir/image.txt"
image=$(cat "$backup_dir/image.txt")
test -n "$image"
docker image save --output "$backup_dir/image.tar.partial" "$image"
gzip -c "$backup_dir/image.tar.partial" > "$backup_dir/image.tar.gz"
gzip -t "$backup_dir/database.sql.gz" "$backup_dir/config-storage.tar.gz" "$backup_dir/image.tar.gz"
(cd "$backup_dir" && sha256sum database.sql.gz config-storage.tar.gz image.tar.gz image.txt > SHA256SUMS)
echo "Backup complete: $backup_dir"
echo 'Copy this private directory off the server and test restoration before relying on it.'
