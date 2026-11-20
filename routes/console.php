<?php

use App\Models\User;
use App\Services\Community;
use App\Services\StripeDonations;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schedule;

Artisan::command('lyricflow:admin {email} {--confirm}', function (): int {
    if (! $this->option('confirm')) {
        $this->error('Grant administrator access to an existing account with --confirm.');

        return 1;
    }

    return DB::transaction(function (): int {
        Community::lock();
        $user = User::where('email', strtolower(trim($this->argument('email'))))->lockForUpdate()->first();
        if (! $user || $user->banned_at || ! $user->hasVerifiedEmail()) {
            $this->error('An active account with a verified email address is required.');

            return 1;
        }
        $user->forceFill(['role' => 'admin'])->save();
        Community::audit(null, 'role.admin', 'user', $user->id, 'Administrator granted from the server console.');
        $this->info('Administrator access granted. Refresh the account session.');

        return 0;
    });
})->purpose('Grant administrator access to an existing verified account');

Artisan::command('support:reconcile {--session= : Recheck one Checkout Session} {--user= : Assign an anonymous donation to an existing pseudonym} {--confirm}', function (StripeDonations $stripe): int {
    if ($this->option('user') && (! $this->option('session') || ! $this->option('confirm'))) {
        $this->error('Assigning an anonymous donation requires --session, --user and --confirm after checking the Stripe receipt.');

        return 1;
    }
    try {
        $user = $this->option('user') ? User::where('pseudonym', $this->option('user'))->firstOrFail() : null;
        $count = $this->option('session')
            ? (int) $stripe->syncSession($this->option('session'), $user?->id)
            : $stripe->reconcile();
        $this->info("Donation reconciliation complete: $count paid EUR session(s) checked.");

        return 0;
    } catch (Throwable) {
        $this->error('Donation reconciliation failed. Check Stripe configuration and connectivity, then retry.');

        return 1;
    }
})->purpose('Recover Stripe donations and supporter badges without relying on webhooks');

Schedule::command('support:reconcile')->everyFifteenMinutes()->withoutOverlapping(60)
    ->when(fn () => app(StripeDonations::class)->automatic());
