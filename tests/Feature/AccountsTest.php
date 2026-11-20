<?php

namespace Tests\Feature;

use App\Models\User;
use App\Support\AccountFeatures;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Auth\Notifications\VerifyEmail;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Facades\URL;
use Symfony\Component\Mailer\Exception\TransportException;
use Tests\TestCase;

class AccountsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['lyricflow.accounts_enabled' => true, 'lyricflow.email_enabled' => true]);
        Notification::fake();
    }

    private function user(string $email = 'musician@example.test', string $pseudonym = 'musician'): User
    {
        return User::create(['email' => $email, 'pseudonym' => $pseudonym, 'password' => 'A private password 123']);
    }

    public function test_registration_normalizes_identity_hashes_password_and_rotates_session(): void
    {
        $this->withSession(['_token' => 'before-registration']);
        $response = $this->postJson('/api/register', [
            'email' => 'Player@Example.test', 'pseudonym' => 'Player_1',
            'password' => 'A private password 123', 'password_confirmation' => 'A private password 123',
            'banned_at' => now(), 'role' => 'admin',
        ])->assertCreated()->assertJsonPath('user.pseudonym', 'player_1')->assertJsonPath('user.verified', false);
        $user = User::firstOrFail();
        $this->assertSame('player@example.test', $user->email);
        $this->assertTrue(Hash::check('A private password 123', $user->password));
        $this->assertNull($user->banned_at);
        $this->assertNotSame('before-registration', $response->json('csrfToken'));
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->assertArrayNotHasKey('password', $response->json('user'));
        Notification::assertSentToTimes($user, VerifyEmail::class, 1);
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user.id', $user->id);
    }

    public function test_reserved_pseudonyms_case_duplicates_and_short_passwords_are_rejected(): void
    {
        $this->user();
        $this->postJson('/api/register', [
            'email' => 'MUSICIAN@example.test', 'pseudonym' => 'Anonymous',
            'password' => 'short', 'password_confirmation' => 'short',
        ])->assertUnprocessable()->assertJsonValidationErrors(['email', 'pseudonym', 'password']);
        $this->assertDatabaseCount('users', 1);
    }

    public function test_login_logout_and_banned_users(): void
    {
        $user = $this->user();
        $this->postJson('/api/login', ['email' => 'MUSICIAN@example.test', 'password' => 'A private password 123'])
            ->assertOk()->assertJsonPath('user.id', $user->id);
        $this->postJson('/api/logout')->assertOk()->assertJsonPath('user', null);
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user', null);
        $user->forceFill(['banned_at' => now()])->save();
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'A private password 123'])
            ->assertUnprocessable()->assertJsonValidationErrors('email');
    }

    public function test_banning_an_existing_session_revokes_account_access(): void
    {
        $user = $this->user();
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'A private password 123'])->assertOk();
        $user->forceFill(['banned_at' => now()])->save();
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/session')->assertUnauthorized();
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user', null);
    }

    public function test_password_recovery_is_generic_and_tokens_are_single_use(): void
    {
        $user = $this->user();
        $known = $this->postJson('/api/forgot-password', ['email' => $user->email])->assertStatus(202)->json();
        $unknown = $this->postJson('/api/forgot-password', ['email' => 'absent@example.test'])->assertStatus(202)->json();
        $this->assertSame($known, $unknown);
        $token = null;
        Notification::assertSentTo($user, ResetPassword::class, function (ResetPassword $notification) use (&$token, $user): bool {
            $token = $notification->token;
            $url = $notification->toMail($user)->actionUrl;
            $this->assertSame('/', parse_url($url, PHP_URL_PATH));
            $this->assertNull(parse_url($url, PHP_URL_QUERY));
            $this->assertStringContainsString('#reset-password?', $url);

            return true;
        });
        $data = ['email' => $user->email, 'token' => $token, 'password' => 'A different password 456', 'password_confirmation' => 'A different password 456'];
        $this->postJson('/api/reset-password', $data)->assertOk();
        $this->assertTrue(Hash::check($data['password'], $user->fresh()->password));
        $this->assertSame(2, $user->fresh()->session_version);
        $this->postJson('/api/reset-password', $data)->assertUnprocessable();
    }

    public function test_password_reset_revokes_old_sessions_without_removing_account(): void
    {
        $user = $this->user();
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'A private password 123'])->assertOk();
        $token = Password::createToken($user);
        $this->postJson('/api/reset-password', ['email' => $user->email, 'token' => $token,
            'password' => 'Another password 456', 'password_confirmation' => 'Another password 456'])->assertOk();
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/session')->assertUnauthorized();
        $this->assertDatabaseCount('users', 1);
    }

    public function test_expired_reset_and_wrong_verification_links_are_rejected(): void
    {
        $user = $this->user();
        $token = Password::createToken($user);
        $this->travel(61)->minutes();
        $this->postJson('/api/reset-password', ['email' => $user->email, 'token' => $token,
            'password' => 'Another password 456', 'password_confirmation' => 'Another password 456'])->assertUnprocessable();
        $this->actingAs($user)->withSession(['account_version' => 1]);
        $url = URL::temporarySignedRoute('verification.verify', now()->addMinutes(10), ['id' => $user->id, 'hash' => sha1($user->email)]);
        $this->get($url.'invalid')->assertForbidden();
        $this->get($url)->assertRedirect('/#account?verified=1');
        $this->assertNotNull($user->fresh()->email_verified_at);
    }

    public function test_local_only_mode_does_not_require_account_tables(): void
    {
        config(['lyricflow.accounts_enabled' => false]);
        $previous = config('database.default');
        try {
            config(['database.default' => 'nonexistent-database']);
            $this->withSession([Auth::guard()->getName() => 'stale-session-user']);
            $this->getJson('/api/session')->assertOk()->assertJsonPath('enabled', false)->assertJsonPath('user', null);
            $this->postJson('/api/register')->assertStatus(503);
        } finally {
            config(['database.default' => $previous]);
        }
    }

    public function test_production_log_mailer_cannot_log_recovery_or_verification_secrets(): void
    {
        $this->app->instance('env', 'production');
        config(['mail.default' => 'log']);
        $this->postJson('/api/register', [
            'email' => 'player@example.test', 'pseudonym' => 'player',
            'password' => 'A private password 123', 'password_confirmation' => 'A private password 123',
        ])->assertStatus(419);
        // Exercise the notification guard independently of the CSRF middleware.
        $user = $this->user();
        $user->sendEmailVerificationNotification();
        Notification::assertNothingSent();
        $this->assertFalse(AccountFeatures::emailAvailable());
    }

    public function test_login_requires_csrf_outside_the_test_bypass(): void
    {
        $user = $this->user();
        $this->app->instance('env', 'local');
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'A private password 123'])->assertStatus(419);
        $token = $this->getJson('/api/session')->json('csrfToken');
        $this->withSession(['_token' => $token])->withHeader('X-CSRF-TOKEN', $token)
            ->postJson('/api/login', ['email' => $user->email, 'password' => 'A private password 123'])->assertOk();
    }

    public function test_login_attempts_are_rate_limited_and_errors_are_not_cacheable(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/login', ['email' => 'absent@example.test', 'password' => 'Incorrect password'])->assertUnprocessable();
        }
        $response = $this->postJson('/api/login', ['email' => 'absent@example.test', 'password' => 'Incorrect password'])->assertStatus(429);
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
    }

    public function test_migration_can_be_repeated_without_altering_existing_accounts(): void
    {
        $user = $this->user();
        $migration = require database_path('migrations/2026_10_18_000001_create_accounts.php');
        $migration->up();
        $migration->up();
        $this->assertSame($user->email, $user->fresh()->email);
        $this->assertDatabaseCount('users', 1);
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
    }

    public function test_registration_keeps_the_account_and_session_when_smtp_fails(): void
    {
        Notification::shouldReceive('send')->once()->andThrow(new TransportException('Confidential provider diagnostic'));
        $this->postJson('/api/register', ['email' => 'player@example.test', 'pseudonym' => 'player',
            'password' => 'A private password 123', 'password_confirmation' => 'A private password 123'])
            ->assertCreated()->assertJsonPath('user.pseudonym', 'player')->assertJsonPath('user.verified', false)
            ->assertJsonPath('message', __('accounts.email_failed'));
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user.pseudonym', 'player');
        $this->assertDatabaseCount('users', 1);
    }

    public function test_malformed_identity_and_bcrypt_byte_overflow_are_validation_errors(): void
    {
        $this->postJson('/api/register', ['email' => ['bad'], 'pseudonym' => ['bad']])->assertUnprocessable();
        $password = str_repeat('é', 40);
        $this->postJson('/api/register', ['email' => 'player@example.test', 'pseudonym' => 'player',
            'password' => $password, 'password_confirmation' => $password])->assertUnprocessable()->assertJsonValidationErrors('password');
        $this->assertDatabaseCount('users', 0);
    }
}
