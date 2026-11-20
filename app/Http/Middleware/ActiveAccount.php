<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

class ActiveAccount
{
    public function handle(Request $request, Closure $next): Response
    {
        if (! config('lyricflow.accounts_enabled')) {
            return $next($request);
        }
        $user = $request->user();
        if ($user && ($user->banned_at || $request->session()->get('account_version') !== $user->session_version)) {
            Auth::logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();
            abort(401, __('accounts.session_expired'));
        }

        return $next($request);
    }
}
