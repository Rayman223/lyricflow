<?php

return [
    // Keep the existing local-only installation usable until MariaDB is ready.
    'accounts_enabled' => (bool) env('LYRICFLOW_ACCOUNTS_ENABLED', false),
    'email_enabled' => (bool) env('LYRICFLOW_EMAIL_ENABLED', false),
    'trusted_proxies' => env('TRUSTED_PROXIES'),
];
