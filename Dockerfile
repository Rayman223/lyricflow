# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY .npmrc .npmrc
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
COPY frontend/ ./frontend/
# TypeScript also checks tests importing the shared PHP/frontend URL fixtures.
COPY tests/fixtures/ ./tests/fixtures/
RUN npm run build --prefix frontend

FROM dunglas/frankenphp:1-php8.4-bookworm AS php-base
RUN install-php-extensions pdo_mysql intl zip opcache
RUN cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY --chmod=644 deploy/php-security.ini /usr/local/etc/php/conf.d/zz-security.ini
WORKDIR /app

FROM php-base AS vendor
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction --no-progress

FROM php-base AS production
COPY . /app
COPY --from=vendor /app/vendor /app/vendor
COPY --from=composer:2 /usr/bin/composer /tmp/composer
COPY --from=frontend /build/public /app/public
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/entrypoint.sh /usr/local/bin/lyricflow-entrypoint
# Git checkouts made under the updater's private umask can contain 600/700 modes.
# Normalize image files before switching to www-data; persistent mounts stay private.
RUN chmod -R u=rwX,go=rX /app \
    && chmod 644 /etc/caddy/Caddyfile \
    && php /tmp/composer dump-autoload --no-dev --optimize --no-scripts \
    && rm /tmp/composer \
    && mkdir -p storage/app/private storage/app/public storage/logs \
        storage/framework/cache/data storage/framework/cache/locks \
        storage/framework/sessions storage/framework/views bootstrap/cache \
        /data/caddy /config/caddy \
    && chown -R www-data:www-data storage bootstrap/cache /data/caddy /config/caddy \
    && chmod 755 /usr/local/bin/lyricflow-entrypoint \
    && (setcap -r /usr/local/bin/frankenphp || true)
USER www-data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD php -r 'exit(@file_get_contents("http://127.0.0.1:8080/up") === false ? 1 : 0);'
ENTRYPOINT ["/usr/local/bin/lyricflow-entrypoint"]
CMD ["frankenphp", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
