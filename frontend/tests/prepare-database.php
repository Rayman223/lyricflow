<?php

use App\Models\User;
use Symfony\Component\Console\Input\ArgvInput;

// Browser tests only ever migrate their own SQLite file, never an operator's DB.
$path = dirname(__DIR__, 2).'/database/browser-tests.sqlite';
if (getenv('LYRICFLOW_BROWSER_TESTS') !== '1' || getenv('DB_CONNECTION') !== 'sqlite' || getenv('DB_DATABASE') !== $path) {
    throw new RuntimeException('A dedicated browser-test SQLite database is required.');
}
if (! is_file($path)) {
    touch($path);
}
require dirname(__DIR__, 2).'/vendor/autoload.php';
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$status = $app->handleCommand(new ArgvInput(['artisan', 'migrate', '--force']));
if ($status !== 0) {
    exit($status);
}
// Deterministic staff identity exists only in the guarded, disposable browser database.
$admin = User::firstOrCreate(['email' => 'browser_admin@example.test'], ['pseudonym' => 'browser_admin', 'password' => 'Browser test password 123']);
$admin->forceFill(['role' => 'admin', 'email_verified_at' => now(), 'banned_at' => null])->save();
exit(0);
