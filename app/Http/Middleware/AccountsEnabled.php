<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class AccountsEnabled
{
    public function handle(Request $request, Closure $next): Response
    {
        abort_unless(config('lyricflow.accounts_enabled'), 503, __('accounts.unavailable'));

        return $next($request);
    }
}
