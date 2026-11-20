<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Password;
use Tests\TestCase;

class RememberedAccountsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['lyricflow.accounts_enabled' => true]);
        Notification::fake();
        $this->withCredentials();
    }

    private function login(bool $remember = true): array
    {
        $user = User::create(['email' => 'remember@example.test', 'pseudonym' => 'remember', 'password' => 'A private password 123']);
        $name = Auth::guard()->getRecallerName();
        $response = $this->postJson('/api/login', ['email' => $user->email, 'password' => 'A private password 123', 'remember' => $remember])->assertOk();
        if ($cookie = $response->getCookie($name)) {
            $this->withCookie($name, $cookie->getValue());
        }

        return [$user, $name, $response];
    }

    private function reopen(string $name, string $value): void
    {
        $this->app['session.store']->flush();
        $this->app['session.store']->save();
        $this->app['auth']->forgetGuards();
        $this->withCookie($name, $value);
    }

    public function test_remember_restores_an_expired_session_without_granting_recent_authentication(): void
    {
        [$user, $name, $response] = $this->login();
        $cookie = $response->getCookie($name);
        $this->assertNotNull($cookie);
        $this->assertGreaterThan(time(), $cookie->getExpiresTime());
        $this->assertTrue($cookie->isHttpOnly());
        $this->reopen($name, $cookie->getValue());
        $this->withSession(['account_version' => 0, 'account_signed_in_at' => time()]);
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user.id', $user->id);
        $this->assertSame($user->session_version, session('account_version'));
        $this->assertNull(session('account_signed_in_at'));
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user.id', $user->id);
    }

    public function test_unchecked_remember_does_not_create_a_persistent_login(): void
    {
        [, $name, $response] = $this->login(false);
        $response->assertCookieMissing($name);
        $this->app['session.store']->flush();
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user', null);
    }

    public function test_remember_restores_metadata_when_the_first_request_is_a_login_attempt(): void
    {
        [$user, $name, $response] = $this->login();
        $this->reopen($name, $response->getCookie($name)->getValue());
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'A private password 123'])->assertStatus(409);
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user.id', $user->id);
        $this->assertNull(session('account_signed_in_at'));
    }

    public function test_remember_restores_access_when_a_protected_api_is_requested_first(): void
    {
        [$user, $name, $response] = $this->login();
        $this->reopen($name, $response->getCookie($name)->getValue());
        $this->getJson('/api/community/catalog')->assertOk();
        $this->assertSame($user->session_version, session('account_version'));
    }

    public function test_a_remember_cookie_does_not_override_a_revoked_existing_session(): void
    {
        [$user] = $this->login();
        $user->increment('session_version');
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/session')->assertUnauthorized();
    }

    public function test_logout_revokes_a_copied_remember_cookie(): void
    {
        [, $name, $response] = $this->login();
        $value = $response->getCookie($name)->getValue();
        $this->postJson('/api/logout')->assertOk()->assertCookieExpired($name);
        $this->reopen($name, $value);
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user', null);
    }

    public function test_password_reset_revokes_a_remember_cookie(): void
    {
        [$user, $name, $response] = $this->login();
        $value = $response->getCookie($name)->getValue();
        $token = Password::createToken($user);
        $this->postJson('/api/reset-password', ['email' => $user->email, 'token' => $token,
            'password' => 'Another password 456', 'password_confirmation' => 'Another password 456'])->assertOk();
        $this->reopen($name, $value);
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user', null);
    }

    public function test_a_banned_account_cannot_be_restored(): void
    {
        [$user, $name, $response] = $this->login();
        $value = $response->getCookie($name)->getValue();
        $user->forceFill(['banned_at' => now()])->save();
        $this->reopen($name, $value);
        $this->getJson('/api/session')->assertUnauthorized();
    }

    public function test_ban_then_unban_does_not_restore_an_old_remember_cookie(): void
    {
        [$user, $name, $response] = $this->login();
        $value = $response->getCookie($name)->getValue();
        $moderator = User::create(['email' => 'moderator@example.test', 'pseudonym' => 'moderator']);
        $moderator->forceFill(['role' => 'moderator', 'email_verified_at' => now()])->save();
        $this->actingAs($moderator)->withSession(['account_version' => 1]);
        foreach (['ban', 'unban'] as $action) {
            $this->postJson('/api/moderation/actions', ['accountId' => $moderator->id, 'targetType' => 'user',
                'targetId' => $user->id, 'action' => $action, 'reason' => 'Review of account access'])->assertOk();
        }
        $this->reopen($name, $value);
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user', null);
    }

    public function test_a_tampered_cookie_cannot_restore_an_account(): void
    {
        [, $name, $response] = $this->login();
        $this->reopen($name, $response->getCookie($name)->getValue().'tampered');
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user', null);
    }

    public function test_remember_requires_a_boolean_and_invalid_credentials_do_not_issue_a_cookie(): void
    {
        $name = Auth::guard()->getRecallerName();
        $this->postJson('/api/login', ['email' => 'absent@example.test', 'password' => 'Incorrect password', 'remember' => 'yes'])
            ->assertUnprocessable()->assertJsonValidationErrors('remember')->assertCookieMissing($name);
        $this->postJson('/api/login', ['email' => 'absent@example.test', 'password' => 'Incorrect password', 'remember' => true])
            ->assertUnprocessable()->assertCookieMissing($name);
    }
}
