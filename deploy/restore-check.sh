#!/bin/sh
# Restores only to an explicitly named, empty control database. Never production.
set -eu
umask 077
if [ "$#" -ne 4 ]; then
    echo 'Usage: sh deploy/restore-check.sh BACKUP_DIR DB_CONTAINER RESTORE_USER lyricflow_restore_NAME' >&2
    exit 1
fi
backup_dir=$(cd "$1" && pwd)
db_container=$2
db_user=$3
test_db=$4
case "$db_container" in ''|-*|*[!a-zA-Z0-9_.-]*) echo 'Invalid database container.' >&2; exit 1;; esac
case "$db_user" in ''|*[!a-zA-Z0-9_]*) echo 'Invalid restore user.' >&2; exit 1;; esac
case "$test_db" in lyricflow_restore_?*) ;; *) echo 'Use a dedicated lyricflow_restore_NAME database.' >&2; exit 1;; esac
case "$test_db" in *[!a-zA-Z0-9_]*) echo 'Invalid control database name.' >&2; exit 1;; esac
: "${LF_DB_PASSWORD:?Export LF_DB_PASSWORD for the dedicated restore user.}"
test -f "$backup_dir/SHA256SUMS"
(cd "$backup_dir" && sha256sum -c SHA256SUMS)
tables=$(docker exec -e MYSQL_PWD="$LF_DB_PASSWORD" "$db_container" mariadb -u "$db_user" -N -B \
    -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$test_db'")
if [ "$tables" != 0 ]; then
    echo 'The control database must exist and contain no tables. Nothing was imported.' >&2
    exit 1
fi
restore_sql=$(mktemp "${TMPDIR:-/tmp}/lyricflow-restore.XXXXXX")
trap 'rm -f "$restore_sql"' EXIT
trap 'exit 1' HUP INT TERM
gzip -dc "$backup_dir/database.sql.gz" > "$restore_sql"
docker exec -i -e MYSQL_PWD="$LF_DB_PASSWORD" "$db_container" mariadb -u "$db_user" "$test_db" < "$restore_sql"
docker exec -e MYSQL_PWD="$LF_DB_PASSWORD" "$db_container" mariadb -u "$db_user" "$test_db" -e \
    "SELECT 'users' AS entity, COUNT(*) AS total FROM users UNION ALL SELECT 'private_records', COUNT(*) FROM private_records UNION ALL SELECT 'publications', COUNT(*) FROM publications UNION ALL SELECT 'publication_revisions', COUNT(*) FROM publication_revisions UNION ALL SELECT 'ratings', COUNT(*) FROM ratings UNION ALL SELECT 'reports', COUNT(*) FROM reports UNION ALL SELECT 'moderation_events', COUNT(*) FROM moderation_events"
echo 'Control database imported. Verify accounts, private access, publications, reviews and roles in an isolated application before validating restoration.'
