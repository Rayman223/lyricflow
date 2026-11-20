#!/bin/sh
set -eu

cd /app
if [ ! -r .env ]; then
    echo "Mount the production .env file at /app/.env before starting LyricFlow." >&2
    exit 1
fi

mkdir -p storage/app/private storage/app/public storage/logs \
    storage/framework/cache/data storage/framework/cache/locks \
    storage/framework/sessions storage/framework/views

# Validate without displaying the key or configuration values in container logs.
php -r '
    require "vendor/autoload.php";
    Dotenv\Dotenv::createImmutable(getcwd())->safeLoad();
    if (($_ENV["APP_ENV"] ?? "") !== "production"
        || ($_ENV["APP_DEBUG"] ?? "") !== "false"
        || !str_starts_with($_ENV["APP_URL"] ?? "", "https://")
        || !preg_match("/^base64:[A-Za-z0-9+\/=]+$/D", $_ENV["APP_KEY"] ?? "")
        || strlen(base64_decode(substr($_ENV["APP_KEY"] ?? "", 7), true) ?: "") !== 32) {
        fwrite(STDERR, "Check APP_ENV=production, APP_DEBUG=false, HTTPS APP_URL and the saved APP_KEY.\n");
        exit(1);
    }
'
php artisan package:discover --ansi
php artisan config:cache --ansi

exec "$@"
