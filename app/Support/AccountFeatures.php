<?php

namespace App\Support;

class AccountFeatures
{
    public static function emailAvailable(): bool
    {
        return config('lyricflow.email_enabled') && config('mail.default') !== 'log' && (! app()->isProduction()
            || in_array(config('mail.default'), ['smtp', 'sendmail', 'ses', 'postmark', 'resend'], true));
    }
}
