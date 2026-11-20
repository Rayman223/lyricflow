<?php

use App\Http\Controllers\AccountController;
use App\Http\Controllers\CommunityController;
use App\Http\Controllers\GoogleController;
use App\Http\Controllers\ModerationController;
use App\Http\Controllers\PrivateSyncController;
use App\Http\Controllers\SupportController;
use App\Http\Middleware\AccountsEnabled;
use App\Http\Middleware\ActiveAccount;
use App\Http\Middleware\PrivateResponse;
use Illuminate\Foundation\Auth\EmailVerificationRequest;
use Illuminate\Support\Facades\Route;

Route::get('/', $shell = function () {
    $path = public_path('index.html');

    abort_unless(is_file($path), 503, 'Build the LyricFlow interface before starting the app.');

    return response()->file($path, ['Cache-Control' => 'no-cache']);
});
Route::get('/support', $shell);

Route::middleware(PrivateResponse::class)->group(function (): void {
    Route::get('/api/support', [SupportController::class, 'index'])->middleware([ActiveAccount::class, 'throttle:60,1']);
    Route::post('/api/support/stripe/webhook', [SupportController::class, 'webhook']);
    Route::get('/api/session', [AccountController::class, 'session'])->middleware(ActiveAccount::class);
    Route::middleware(AccountsEnabled::class)->group(function (): void {
        Route::get('/api/publications/{id}/prompter', [CommunityController::class, 'prompter'])
            ->whereUuid('id')->middleware([ActiveAccount::class, 'throttle:public-prompter']);
        Route::post('/api/register', [AccountController::class, 'register'])->middleware('throttle:account-register');
        Route::post('/api/login', [AccountController::class, 'login'])->middleware('throttle:account-login')->name('login');
        Route::post('/api/forgot-password', [AccountController::class, 'forgot'])->middleware('throttle:account-recovery');
        Route::post('/api/reset-password', [AccountController::class, 'reset'])->middleware('throttle:account-recovery');
        Route::get('/auth/google/redirect', [GoogleController::class, 'redirect'])->middleware(['ActiveAccount', 'throttle:account-google']);
        Route::get('/auth/google/callback', [GoogleController::class, 'callback'])->middleware(['ActiveAccount', 'throttle:account-google']);
        Route::post('/api/google/complete', [GoogleController::class, 'complete'])->middleware('throttle:account-register');
        Route::post('/api/google/cancel', [GoogleController::class, 'cancel']);
        Route::middleware(['auth', ActiveAccount::class])->group(function (): void {
            Route::post('/api/support/visibility', [SupportController::class, 'visibility'])->middleware('throttle:community-write');
            Route::get('/api/admin/support', [SupportController::class, 'donations'])->middleware('throttle:community');
            Route::prefix('/api/community')->middleware('throttle:community')->group(function (): void {
                Route::get('/catalog', [CommunityController::class, 'catalog']);
                Route::get('/catalog/{id}', [CommunityController::class, 'versions']);
                Route::get('/publications/{id}', [CommunityController::class, 'show']);
                Route::get('/mine', [CommunityController::class, 'mine']);
                Route::post('/updates', [CommunityController::class, 'updates']);
                Route::middleware('throttle:community-write')->group(function (): void {
                    Route::post('/publish', [CommunityController::class, 'publish']);
                    Route::post('/publications/{id}/auto-share', [CommunityController::class, 'autoShare']);
                    Route::post('/publications/{id}/auto-update', [CommunityController::class, 'automaticUpdate']);
                    Route::post('/publications/{id}/unpublish', [CommunityController::class, 'unpublish']);
                    Route::post('/publications/{id}/rating', [CommunityController::class, 'rate']);
                    Route::post('/publications/{id}/rating/remove', [CommunityController::class, 'removeRating']);
                    Route::post('/reports', [CommunityController::class, 'report']);
                });
            });
            Route::prefix('/api/moderation')->middleware('throttle:community')->group(function (): void {
                Route::get('/reports', [ModerationController::class, 'reports']);
                Route::get('/events', [ModerationController::class, 'events']);
                Route::post('/reports/{id}', [ModerationController::class, 'review']);
                Route::post('/actions', [ModerationController::class, 'action']);
            });
            Route::prefix('/api/admin')->middleware('throttle:community')->group(function (): void {
                Route::get('/users', [ModerationController::class, 'users']);
                Route::post('/users/{id}/role', [ModerationController::class, 'role']);
                Route::get('/settings', [ModerationController::class, 'settings']);
                Route::post('/settings', [ModerationController::class, 'saveSettings']);
                Route::get('/catalog', [ModerationController::class, 'catalog']);
                Route::post('/catalog/{id}', [ModerationController::class, 'editCatalog']);
                Route::post('/catalog/{id}/merge', [ModerationController::class, 'mergeCatalog']);
            });
            Route::post('/api/sync', [PrivateSyncController::class, 'exchange'])->middleware('throttle:private-sync');
            Route::post('/api/account/delete', [AccountController::class, 'delete'])->middleware('throttle:account-login');
            Route::post('/api/logout', [AccountController::class, 'logout']);
            Route::post('/api/email/verification-notification', [AccountController::class, 'resend'])->middleware('throttle:account-recovery');
            Route::post('/api/google/link', [GoogleController::class, 'prepareLink'])->middleware('throttle:account-login');
            Route::get('/auth/email/verify/{id}/{hash}', function (EmailVerificationRequest $request) {
                $request->fulfill();

                return redirect('/#account?verified=1');
            })->middleware(['signed', 'throttle:account-recovery'])->name('verification.verify');
        });
    });
});
