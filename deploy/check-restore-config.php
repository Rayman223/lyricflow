<?php

// Validate the isolated restore configuration without printing any value or secret.
require dirname(__DIR__).'/vendor/autoload.php';
if ($argc !== 4 || ! preg_match('/^lyricflow_restore_[a-zA-Z0-9_]+$/D', $argv[2])) {
    fwrite(STDERR, 'Usage: php deploy/check-restore-config.php ENV_FILE lyricflow_restore_NAME RESTORE_USER'.PHP_EOL);
    exit(1);
}
try {
    $values = Dotenv\Dotenv::parse(file_get_contents($argv[1]));
} catch (Throwable) {
    fwrite(STDERR, 'The private restore configuration could not be read.'.PHP_EOL);
    exit(1);
}
$expected = ['APP_ENV' => 'production', 'APP_DEBUG' => 'false', 'APP_URL' => 'https://localhost:18081', 'DB_DATABASE' => $argv[2], 'DB_USERNAME' => $argv[3], 'LYRICFLOW_ACCOUNTS_ENABLED' => 'true', 'MAIL_MAILER' => 'array', 'LYRICFLOW_EMAIL_ENABLED' => 'false', 'SESSION_SECURE_COOKIE' => 'false'];
$valid = true;
foreach ($expected as $key => $value) {
    $valid = $valid && ($values[$key] ?? '') === $value;
}
foreach (['DB_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as $key) {
    $valid = $valid && ($values[$key] ?? '') === '';
}
$valid = $valid && in_array($values['SESSION_DOMAIN'] ?? '', ['', 'null'], true) && str_starts_with($values['SESSION_COOKIE'] ?? '', 'lyricflow_restore_');
if (! $valid) {
    fwrite(STDERR, 'Restore configuration rejected: check the isolated database/user, blank DB_URL and Google credentials, disabled email, loopback URL and separate session cookie/domain.'.PHP_EOL);
    exit(1);
}
echo 'Isolated restore configuration accepted.'.PHP_EOL;
