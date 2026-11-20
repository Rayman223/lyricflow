#!/bin/sh
# Failure-path checks for the Docker orchestration; real MariaDB restore is tested separately.
set -eu
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lyricflow-deploy-test.XXXXXX")
trap 'rm -rf "$fixture"' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$fixture/bin" "$fixture/root/config" "$fixture/root/data/storage"
printf '%s\n' 'APP_KEY=private-test-key' > "$fixture/root/config/production.env"
cat > "$fixture/bin/docker" <<'DOCKER'
#!/bin/sh
set -eu
case "$*" in
    *mariadb-dump*)
        if [ "${LF_TEST_DUMP_FAIL:-0}" = 1 ]; then echo 'Simulated dump failure' >&2; exit 7; fi
        echo 'CREATE TABLE restored_fixture (id INT);'
        exit 0;;
    *information_schema.tables*) echo "${LF_TEST_TABLES:-0}"; exit 0;;
    *"SELECT 'users'"*) echo 'users 1'; exit 0;;
esac
if [ "$1" = inspect ]; then
    case "$3" in
        '{{.Image}}') echo "$LF_TEST_RUNNING_IMAGE";;
        '{{.Config.Image}}') echo 'lyricflow-local:moved-tag';;
        *) exit 1;;
    esac
    exit 0
fi
if [ "$1" = image ] && [ "$2" = save ]; then
    if [ "$5" != "$LF_TEST_RUNNING_IMAGE" ]; then echo 'The backup selected a mutable tag instead of the running image.' >&2; exit 9; fi
    printf '%s\n' "$5" > "$4"
    exit 0
fi
cat > "$LF_TEST_IMPORT_CAPTURE"
DOCKER
chmod 700 "$fixture/bin/docker"
PATH="$fixture/bin:$PATH"
LF_DB_PASSWORD=private-test-password
LF_TEST_IMPORT_CAPTURE="$fixture/imported.sql"
LF_TEST_RUNNING_IMAGE=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export PATH LF_DB_PASSWORD LF_TEST_IMPORT_CAPTURE LF_TEST_RUNNING_IMAGE
sh deploy/backup.sh "$fixture/root" testdb testuser lyricflow > "$fixture/output"
backup_dir=$(find "$fixture/root/backups" -mindepth 1 -maxdepth 1 -type d)
test -f "$backup_dir/SHA256SUMS"
test "$(stat -c %a "$backup_dir")" = 700
test "$(stat -c %a "$backup_dir/database.sql.gz")" = 600
test "$(cat "$backup_dir/image.txt")" = "$LF_TEST_RUNNING_IMAGE"
test "$(gzip -dc "$backup_dir/image.tar.gz")" = "$LF_TEST_RUNNING_IMAGE"
if grep -q "$LF_DB_PASSWORD" "$fixture/output"; then echo 'A credential reached backup output.' >&2; exit 1; fi
if sh deploy/restore-check.sh "$backup_dir" testdb testuser lyricflow > "$fixture/output" 2>&1; then echo 'Production database was accepted.' >&2; exit 1; fi
test ! -e "$fixture/imported.sql"
if LF_TEST_TABLES=1 sh deploy/restore-check.sh "$backup_dir" testdb testuser lyricflow_restore_test > "$fixture/output" 2>&1; then echo 'Nonempty control database was accepted.' >&2; exit 1; fi
test ! -e "$fixture/imported.sql"
sh deploy/restore-check.sh "$backup_dir" testdb testuser lyricflow_restore_test > "$fixture/output"
test "$(cat "$fixture/imported.sql")" = 'CREATE TABLE restored_fixture (id INT);'
if LF_TEST_DUMP_FAIL=1 sh deploy/backup.sh "$fixture/root" testdb testuser lyricflow > "$fixture/output" 2>&1; then echo 'Failed dump was accepted.' >&2; exit 1; fi
test "$(find "$fixture/root/backups" -name SHA256SUMS | wc -l)" -eq 1
rm "$fixture/imported.sql"
printf '%s\n' 'tampered' >> "$backup_dir/database.sql.gz"
if sh deploy/restore-check.sh "$backup_dir" testdb testuser lyricflow_restore_test > "$fixture/output" 2>&1; then echo 'Corrupt archive was accepted.' >&2; exit 1; fi
test ! -e "$fixture/imported.sql"
cat > "$fixture/restore.env" <<'ENV'
APP_ENV=production
APP_DEBUG=false
APP_URL=https://localhost:18081
DB_DATABASE=lyricflow_restore_test
DB_USERNAME=lf_restore
DB_URL=
LYRICFLOW_ACCOUNTS_ENABLED=true
MAIL_MAILER=array
LYRICFLOW_EMAIL_ENABLED=false
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SESSION_SECURE_COOKIE=false
SESSION_DOMAIN=null
SESSION_COOKIE=lyricflow_restore_test
ENV
php deploy/check-restore-config.php "$fixture/restore.env" lyricflow_restore_test lf_restore > "$fixture/output"
sed 's/DB_DATABASE=lyricflow_restore_test/DB_DATABASE=lyricflow/' "$fixture/restore.env" > "$fixture/unsafe.env"
if php deploy/check-restore-config.php "$fixture/unsafe.env" lyricflow_restore_test lf_restore > "$fixture/output" 2>&1; then echo 'Production configuration was accepted.' >&2; exit 1; fi
sed 's|DB_URL=|DB_URL=mysql://production.invalid/lyricflow|' "$fixture/restore.env" > "$fixture/unsafe.env"
if php deploy/check-restore-config.php "$fixture/unsafe.env" lyricflow_restore_test lf_restore > "$fixture/output" 2>&1; then echo 'A connection URL override was accepted.' >&2; exit 1; fi
echo 'Deployment scripts: backup permissions, dump failure, checksums, isolated restore and nonempty/production protection passed.'
