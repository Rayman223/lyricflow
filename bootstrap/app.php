<?php

use App\Http\Middleware\ActiveAccount;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->preventRequestForgery(except: ['api/support/stripe/webhook']);
        $middleware->trimStrings(except: [fn (Request $request) => $request->is('api/sync', 'api/community/*', 'api/admin/catalog/*')]);
        $middleware->convertEmptyStringsToNull(except: [fn (Request $request) => $request->is('api/sync', 'api/community/*', 'api/admin/catalog/*')]);
        $middleware->alias(['ActiveAccount' => ActiveAccount::class]);
        $middleware->redirectGuestsTo(fn () => '/#account');
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->report(function (Throwable $exception): ?bool {
            if (request()->is('api/sync')) {
                // A QueryException can include lyric bindings. Keep diagnostics content-free.
                Log::error('Private synchronization failed.', ['type' => $exception::class]);

                return false;
            }

            return null;
        });
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
        $exceptions->respond(function (Response $response): Response {
            if (request()->is('api/*', 'auth/*')) {
                $response->headers->set('Cache-Control', 'private, no-store');
            }

            return $response;
        });
    })->create();
