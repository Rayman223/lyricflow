<?php

namespace App\Providers;

use Illuminate\Auth\Events\Login;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Str;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Event::listen(Login::class, function (Login $event): void {
            if ($event->guard === 'web' && Auth::guard('web')->viaRemember()) {
                // Restore metadata even when the first request has no ActiveAccount middleware.
                // A validated recaller is not a fresh Google sign-in.
                session()->put('account_version', $event->user->session_version);
                session()->forget('account_signed_in_at');
            }
        });
        if ($proxies = config('lyricflow.trusted_proxies')) {
            TrustProxies::at($proxies);
        }
        URL::forceRootUrl(config('app.url'));
        if (parse_url(config('app.url'), PHP_URL_SCHEME) === 'https') {
            URL::forceScheme('https');
        }
        ResetPassword::createUrlUsing(fn ($user, string $token) => rtrim(config('app.url'), '/').'/#reset-password?'.http_build_query([
            'token' => $token, 'email' => $user->getEmailForPasswordReset(),
        ], '', '&', PHP_QUERY_RFC3986));

        RateLimiter::for('account-login', fn (Request $request) => [
            Limit::perMinute(5)->by('login:'.hash('sha256', Str::lower((string) $request->input('email'))).'|'.$request->ip()),
            Limit::perMinute(30)->by('login-ip:'.$request->ip()),
        ]);
        RateLimiter::for('account-register', fn (Request $request) => Limit::perMinute(5)->by('register:'.$request->ip()));
        RateLimiter::for('account-recovery', fn (Request $request) => Limit::perMinute(5)->by('recovery:'.$request->ip()));
        RateLimiter::for('account-google', fn (Request $request) => Limit::perMinute(15)->by('google:'.$request->ip()));
        RateLimiter::for('private-sync', fn (Request $request) => Limit::perMinute(240)->by('sync:'.$request->user()->id));
        RateLimiter::for('public-prompter', fn (Request $request) => Limit::perMinute(180)->by('public-prompter:'.$request->ip()));
        RateLimiter::for('community', fn (Request $request) => Limit::perMinute(180)->by('community:'.$request->user()->id));
        RateLimiter::for('community-write', fn (Request $request) => Limit::perMinute(30)->by('community-write:'.$request->user()->id));
    }
}
