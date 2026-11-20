<?php

namespace Tests\Feature;

use App\Models\User;
use App\Services\GoogleIdentity;
use Firebase\JWT\JWT;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class GoogleAccountsTest extends TestCase
{
    use RefreshDatabase;

    private static string $privateKey = '';

    private static array $jwk;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($key, self::$privateKey);
        $rsa = openssl_pkey_get_details($key)['rsa'];
        self::$jwk = ['kty' => 'RSA', 'alg' => 'RS256', 'kid' => 'test-key',
            'n' => JWT::urlsafeB64Encode($rsa['n']), 'e' => JWT::urlsafeB64Encode($rsa['e'])];
    }

    protected function setUp(): void
    {
        parent::setUp();
        config(['lyricflow.accounts_enabled' => true,
            'services.google.client_id' => 'test-client', 'services.google.client_secret' => 'test-secret',
            'services.google.redirect' => 'http://localhost/auth/google/callback']);
        Http::preventStrayRequests();
        Cache::flush();
    }

    private function start(bool $remember = false): array
    {
        $response = $this->get('/auth/google/redirect?remember='.($remember ? '1' : '0'))->assertRedirect();
        parse_str(parse_url($response->headers->get('Location'), PHP_URL_QUERY), $query);
        $this->assertSame('openid email', $query['scope']);
        $this->assertSame('S256', $query['code_challenge_method']);

        return $this->app['session.store']->get('google.flow');
    }

    private function identity(array $flow, array $overrides = [], bool $tampered = false): void
    {
        $token = JWT::encode(array_replace([
            'iss' => 'https://accounts.google.com', 'aud' => 'test-client', 'sub' => 'google-subject',
            'iat' => time() - 1, 'exp' => time() + 600, 'nonce' => $flow['nonce'],
            'email' => 'google@example.test', 'email_verified' => true,
        ], $overrides), self::$privateKey, 'RS256', 'test-key');
        if ($tampered) {
            $parts = explode('.', $token);
            $parts[2] = ($parts[2][0] === 'A' ? 'B' : 'A').substr($parts[2], 1);
            $token = implode('.', $parts);
        }
        Http::fake([GoogleIdentity::TOKEN_URL => Http::response(['id_token' => $token]),
            GoogleIdentity::KEYS_URL => Http::response(['keys' => [self::$jwk]])]);
    }

    private function googleCallback(array $flow): TestResponse
    {
        return $this->get('/auth/google/callback?'.http_build_query(['state' => $flow['state'], 'code' => 'test-code']));
    }

    public static function rememberChoices(): array
    {
        return ['new remembered' => [true, true], 'existing remembered' => [false, true],
            'new temporary' => [true, false], 'existing temporary' => [false, false]];
    }

    #[DataProvider('rememberChoices')]
    public function test_google_remember_choice_survives_the_flow_and_restores_passwordless_accounts(bool $new, bool $remember): void
    {
        if (! $new) {
            $user = User::create(['email' => 'google@example.test', 'pseudonym' => 'google_player']);
            $user->forceFill(['google_subject' => 'google-subject'])->save();
        }
        $name = Auth::guard()->getRecallerName();
        $flow = $this->start($remember);
        $this->identity($flow);
        $response = $this->googleCallback($flow)->assertRedirect('/#account');
        if ($new) {
            $response->assertCookieMissing($name);
            $this->postJson('/api/google/complete', ['pseudonym' => 'Anonymous'])->assertUnprocessable();
            // The trusted server flow wins over a changed completion payload.
            $response = $this->postJson('/api/google/complete', ['pseudonym' => 'google_player', 'remember' => ! $remember])->assertCreated();
        }
        $user = User::where('google_subject', 'google-subject')->firstOrFail();
        $this->assertNull($user->password);
        $cookie = $response->getCookie($name);
        if ($remember) {
            $this->assertNotNull($cookie);
        } else {
            $response->assertCookieMissing($name);
        }
        $this->app['session.store']->flush();
        $this->app['auth']->forgetGuards();
        $this->withCredentials();
        if ($cookie) {
            $this->withCookie($name, $cookie->getValue());
        }
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user.id', $remember ? $user->id : null);
        if ($remember) {
            $this->postJson('/api/account/delete', ['accountId' => $user->id, 'confirmation' => $user->pseudonym])->assertForbidden();
            $this->assertDatabaseCount('users', 1);
            $this->postJson('/api/logout')->assertOk();
            $this->app['auth']->forgetGuards();
            $this->postJson('/api/login', ['email' => $user->email, 'password' => 'Some attempted password'])->assertUnprocessable();
        }
    }

    public function test_google_cancel_discards_remember_choice_before_a_new_flow(): void
    {
        $flow = $this->start(true);
        $this->identity($flow);
        $this->googleCallback($flow)->assertRedirect('/#account');
        $this->postJson('/api/google/cancel')->assertOk();
        $this->postJson('/api/google/complete', ['pseudonym' => 'google_player'])->assertUnprocessable();
        $flow = $this->start();
        $this->assertFalse($flow['remember']);
        $this->getJson('/api/session')->assertOk()->assertJsonPath('googlePending', false)->assertJsonPath('user', null);
    }

    public function test_google_requires_a_chosen_pseudonym_and_validates_a_signed_id_token(): void
    {
        $flow = $this->start();
        $this->identity($flow);
        $this->googleCallback($flow)->assertRedirect('/#account');
        $this->assertDatabaseCount('users', 0);
        $this->getJson('/api/session')->assertJsonPath('googlePending', true);
        $this->postJson('/api/google/complete', ['pseudonym' => 'Guitar_Player'])->assertCreated()
            ->assertJsonPath('user.pseudonym', 'guitar_player')->assertJsonPath('user.verified', true)
            ->assertJsonPath('user.hasPassword', false);
        $this->assertDatabaseHas('users', ['google_subject' => 'google-subject']);
        Http::assertSent(fn ($request) => $request->url() === GoogleIdentity::TOKEN_URL && $request['code_verifier'] === $flow['verifier']);
        $this->googleCallback($flow)->assertRedirect('/#account?error=google_failed');
    }

    public static function rejectedClaims(): array
    {
        return [
            'issuer' => [['iss' => 'https://attacker.example']],
            'audience' => [['aud' => 'another-client']],
            'authorized-party' => [['azp' => 'another-client']],
            'nonce' => [['nonce' => 'another-nonce']],
            'expired' => [['exp' => 1]],
            'unverified-email' => [['email_verified' => false]],
            'missing-subject' => [['sub' => '']],
            'missing-expiry' => [['exp' => null]],
        ];
    }

    #[DataProvider('rejectedClaims')]
    public function test_invalid_identity_claims_are_rejected(array $claims): void
    {
        $flow = $this->start();
        $this->identity($flow, $claims);
        $this->googleCallback($flow)->assertRedirect('/#account?error=google_failed');
        $this->assertDatabaseCount('users', 0);
        $this->getJson('/api/session')->assertJsonPath('googlePending', false)->assertJsonPath('user', null);
    }

    public function test_wrong_state_is_rejected_before_contacting_google(): void
    {
        $flow = $this->start();
        $flow['state'] = 'wrong-state';
        $this->googleCallback($flow)->assertRedirect('/#account?error=google_failed');
        Http::assertNothingSent();
    }

    public function test_a_forged_signature_is_rejected(): void
    {
        $flow = $this->start();
        $this->identity($flow, [], true);
        $this->googleCallback($flow)->assertRedirect('/#account?error=google_failed');
        $this->getJson('/api/session')->assertJsonPath('googlePending', false)->assertJsonPath('user', null);
    }

    public function test_an_expired_flow_is_rejected_before_contacting_google(): void
    {
        $flow = $this->start();
        $this->withSession(['google.flow' => [...$flow, 'expires' => 1]]);
        $this->googleCallback($flow)->assertRedirect('/#account?error=google_failed');
        Http::assertNothingSent();
    }

    public function test_existing_email_is_never_automatically_linked(): void
    {
        $user = User::create(['email' => 'google@example.test', 'pseudonym' => 'existing', 'password' => 'A private password 123']);
        $flow = $this->start();
        $this->identity($flow);
        $this->googleCallback($flow)->assertRedirect('/#account?error=google_existing');
        $this->assertNull($user->fresh()->google_subject);
        $this->assertGuest();
    }

    public function test_linking_requires_password_confirmation_and_preserves_account_identity(): void
    {
        $user = User::create(['email' => 'local@example.test', 'pseudonym' => 'existing', 'password' => 'A private password 123']);
        $this->actingAs($user)->withSession(['account_version' => 1]);
        $this->get('/auth/google/redirect')->assertStatus(409);
        $this->postJson('/api/google/link', ['password' => 'wrong'])->assertUnprocessable();
        $this->postJson('/api/google/link', ['password' => 'A private password 123'])->assertOk();
        $flow = $this->start();
        $this->identity($flow);
        $this->googleCallback($flow)->assertRedirect('/#account');
        $this->assertSame('google-subject', $user->fresh()->google_subject);
        $this->assertSame('local@example.test', $user->fresh()->email);
        $this->assertDatabaseCount('users', 1);
    }

    public function test_a_linked_subject_signs_in_even_when_google_email_changes(): void
    {
        $user = User::create(['email' => 'original@example.test', 'pseudonym' => 'original']);
        $user->forceFill(['google_subject' => 'google-subject'])->save();
        $flow = $this->start();
        $this->identity($flow, ['email' => 'changed@example.test']);
        $this->googleCallback($flow)->assertRedirect('/#account');
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user.id', $user->id);
        $this->assertDatabaseCount('users', 1);
    }

    public function test_linking_cannot_take_another_accounts_google_identity(): void
    {
        $owner = User::create(['email' => 'owner@example.test', 'pseudonym' => 'owner']);
        $owner->forceFill(['google_subject' => 'google-subject'])->save();
        $user = User::create(['email' => 'local@example.test', 'pseudonym' => 'local', 'password' => 'A private password 123']);
        $this->actingAs($user)->withSession(['account_version' => 1]);
        $this->postJson('/api/google/link', ['password' => 'A private password 123'])->assertOk();
        $flow = $this->start();
        $this->identity($flow);
        $this->googleCallback($flow)->assertRedirect('/#account?error=google_linked_elsewhere');
        $this->assertNull($user->fresh()->google_subject);
        $this->assertSame('google-subject', $owner->fresh()->google_subject);
    }
}
