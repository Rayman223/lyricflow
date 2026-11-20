<?php

namespace Tests\Feature;

use App\Models\User;
use App\Services\StripeDonations;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class SupportTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['lyricflow.accounts_enabled' => true, 'support.stripe_url' => 'https://buy.stripe.com/test_lyricflow',
            'support.stripe_payment_link' => 'plink_lyricflow', 'support.stripe_secret_key' => 'sk_test_fixture',
            'support.stripe_webhook_secret' => 'whsec_fixture', 'support.stripe_livemode' => false]);
        Http::preventStrayRequests();
        $this->travelTo(now('UTC')->setDate(2026, 10, 31)->startOfDay());
    }

    private function user(string $name = 'musician', string $role = 'member'): User
    {
        $user = User::create(['pseudonym' => $name, 'email' => "$name@example.test", 'password' => 'A private password 123']);
        $user->forceFill(['role' => $role, 'email_verified_at' => now()])->save();

        return $user;
    }

    private function signIn(User $user): void
    {
        $this->actingAs($user)->withSession(['account_version' => $user->session_version, 'account_signed_in_at' => time()]);
    }

    private function paid(?User $user = null, string $id = 'one', int $amount = 1500, int $refund = 0): array
    {
        return ['id' => 'cs_test_'.$id, 'object' => 'checkout.session', 'payment_link' => 'plink_lyricflow',
            'livemode' => false, 'mode' => 'payment', 'status' => 'complete', 'payment_status' => 'paid',
            'currency' => 'eur', 'amount_total' => $amount, 'client_reference_id' => $user ? app(StripeDonations::class)->reference($user->id) : null,
            'payment_intent' => ['id' => 'pi_'.$id, 'latest_charge' => ['id' => 'ch_'.$id, 'payment_intent' => 'pi_'.$id,
                'paid' => true, 'currency' => 'eur', 'amount' => $amount, 'amount_refunded' => $refund, 'created' => now()->timestamp]],
            'customer_details' => ['email' => 'PRIVATE-DONOR@example.test', 'name' => 'PRIVATE-DONOR-NAME']];
    }

    private function webhook(array $session, string $type = 'checkout.session.completed', ?string $signature = null)
    {
        $event = ['id' => 'evt_fixture', 'livemode' => false, 'type' => $type, 'data' => ['object' => $session]];
        $body = json_encode($event, JSON_THROW_ON_ERROR);
        $header = $signature ?? 't='.now()->timestamp.',v1='.hash_hmac('sha256', now()->timestamp.'.'.$body, 'whsec_fixture');

        return $this->call('POST', '/api/support/stripe/webhook', [], [], [], [
            'CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json', 'HTTP_STRIPE_SIGNATURE' => $header,
        ], $body);
    }

    private function sync(array $session): void
    {
        Http::swap(new Factory);
        Http::preventStrayRequests();
        Http::fake(['api.stripe.com/v1/checkout/sessions/'.$session['id'].'*' => Http::response($session)]);
        $this->assertTrue(app(StripeDonations::class)->syncSession($session['id']));
    }

    public function test_support_works_without_accounts_or_a_database_and_handles_missing_configuration(): void
    {
        $connection = config('database.default');
        try {
            config(['lyricflow.accounts_enabled' => false, 'database.default' => 'nonexistent-database', 'support.stripe_url' => '']);
            $this->get('/support')->assertOk();
            $this->getJson('/api/support')->assertOk()->assertJsonPath('goalCents', 26000)->assertJsonPath('coveredCents', null)
                ->assertJsonPath('automatic', false)->assertJsonPath('donationUrl', null)->assertJsonPath('supporters', []);
            $this->webhook([])->assertStatus(503);
        } finally {
            config(['database.default' => $connection]);
        }
    }

    public function test_payment_link_references_are_signed_and_untrusted_urls_are_rejected(): void
    {
        foreach (['buy.stripe.com', 'donate.stripe.com'] as $host) {
            config(['support.stripe_url' => "https://$host/test_lyricflow?locale=en&client_reference_id=other#fragment"]);
            $this->getJson('/api/support')->assertOk()
                ->assertJsonPath('donationUrl', "https://$host/test_lyricflow?locale=en");
        }
        $user = $this->user();
        $this->signIn($user);
        foreach (['buy.stripe.com', 'donate.stripe.com'] as $host) {
            config(['support.stripe_url' => "https://$host/test_lyricflow?locale=en&client_reference_id=other#fragment"]);
            $url = $this->getJson('/api/support')->assertOk()->json('donationUrl');
            $this->assertSame($host, parse_url($url, PHP_URL_HOST));
            $this->assertSame('/test_lyricflow', parse_url($url, PHP_URL_PATH));
            parse_str(parse_url($url, PHP_URL_QUERY), $query);
            $this->assertSame(app(StripeDonations::class)->reference($user->id), $query['client_reference_id']);
            $this->assertSame('en', $query['locale']);
            $this->assertNull(parse_url($url, PHP_URL_FRAGMENT));
            foreach (['javascript:alert(1)', "http://$host/example", "https://$host.evil.test/example", "https://person@$host/example", "https://$host:444/example"] as $bad) {
                config(['support.stripe_url' => $bad]);
                $this->getJson('/api/support')->assertOk()->assertJsonPath('donationUrl', null);
            }
        }
    }

    public function test_confirmed_donation_grants_a_private_badge_and_repeat_deliveries_never_duplicate_it(): void
    {
        $user = $this->user();
        $session = $this->paid($user);
        Http::fake(['api.stripe.com/*' => Http::response($session)]);
        $this->webhook($session)->assertOk();
        $this->webhook($session, 'checkout.session.async_payment_succeeded')->assertOk();
        $this->assertDatabaseCount('support_donations', 1);
        $this->assertTrue($user->isSupporter());
        $this->assertFalse($user->fresh()->supporter_public);
        $this->signIn($user);
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user.supporter', true);
        $response = $this->getJson('/api/support')->assertOk()->assertJsonPath('coveredCents', 1500)
            ->assertJsonPath('percent', 5)->assertJsonPath('supporters', [])->assertJsonPath('viewer.supporter', true);
        $this->assertStringNotContainsString('PRIVATE-DONOR', $response->getContent());
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $stored = json_encode((array) DB::table('support_donations')->first());
        $this->assertStringNotContainsString('PRIVATE-DONOR', $stored);
        Http::assertSent(fn (ClientRequest $r) => $r->hasHeader('Authorization', 'Bearer sk_test_fixture') && $r['expand'] === ['payment_intent.latest_charge']);
    }

    public function test_polling_recovers_missed_webhooks_with_pagination_and_without_a_webhook_secret(): void
    {
        $user = $this->user();
        config(['support.stripe_webhook_secret' => '']);
        $first = $this->paid($user);
        $second = $this->paid(null, 'two', 2500);
        Http::fake(fn (ClientRequest $r) => Http::response(($r['starting_after'] ?? null)
            ? ['data' => [$second], 'has_more' => false] : ['data' => [$first], 'has_more' => true]));
        $this->artisan('support:reconcile')->assertSuccessful();
        $this->artisan('support:reconcile')->assertSuccessful();
        $this->assertDatabaseCount('support_donations', 2);
        $this->assertTrue($user->isSupporter());
        $this->getJson('/api/support')->assertJsonPath('coveredCents', 4000)->assertJsonPath('automatic', true);
        Http::assertSent(fn (ClientRequest $r) => $r['payment_link'] === 'plink_lyricflow' && $r['limit'] === 100 && $r['status'] === 'complete');
    }

    public function test_unpaid_wrong_currency_mode_or_link_never_count_or_grant_a_badge(): void
    {
        $user = $this->user();
        foreach ([['payment_status' => 'unpaid'], ['status' => 'open'], ['currency' => 'usd'], ['livemode' => true], ['mode' => 'subscription'], ['payment_link' => 'plink_other']] as $changes) {
            $session = [...$this->paid($user), ...$changes];
            Http::swap(new Factory);
            Http::preventStrayRequests();
            Http::fake(['api.stripe.com/*' => Http::response($session)]);
            $this->assertFalse(app(StripeDonations::class)->syncSession($session['id']));
        }
        $this->assertDatabaseCount('support_donations', 0);
        $this->assertFalse($user->isSupporter());
    }

    public function test_tampered_reference_is_still_counted_as_an_anonymous_donation(): void
    {
        $user = $this->user();
        $session = $this->paid($user);
        $session['client_reference_id'] .= 'tampered';
        $this->sync($session);
        $this->assertDatabaseHas('support_donations', ['user_id' => null, 'amount_cents' => 1500]);
        $this->assertFalse($user->isSupporter());
    }

    public function test_bad_or_stale_signatures_are_refused_without_fetching_stripe(): void
    {
        $session = $this->paid();
        foreach (['', 't=0,v1=wrong', 't='.now()->timestamp.',v1=wrong', 't='.(now()->timestamp + 301).',v1=wrong'] as $signature) {
            $this->webhook($session, signature: $signature)->assertBadRequest();
        }
        $body = json_encode(['id' => 'evt_fixture', 'livemode' => false, 'type' => 'checkout.session.completed', 'data' => ['object' => $session]]);
        $past = now()->timestamp - 301;
        $this->webhook($session, signature: 't='.$past.',v1='.hash_hmac('sha256', $past.'.'.$body, 'whsec_fixture'))->assertBadRequest();
        Http::assertNothingSent();
    }

    public function test_only_the_stripe_webhook_is_exempt_from_csrf_and_api_failures_remain_retryable(): void
    {
        $this->app->instance('env', 'local');
        Http::fake(['api.stripe.com/*' => Http::response(['error' => ['message' => 'CONFIDENTIAL-DIAGNOSTIC']], 503)]);
        $response = $this->webhook($this->paid())->assertStatus(503);
        $this->assertStringNotContainsString('CONFIDENTIAL-DIAGNOSTIC', $response->getContent());
        $this->postJson('/api/support/visibility', ['public' => true])->assertStatus(419);
        $this->assertDatabaseCount('support_donations', 0);
    }

    public function test_public_wall_requires_explicit_consent_and_account_identity(): void
    {
        $user = $this->user();
        $this->sync($this->paid($user));
        $this->signIn($user);
        $this->postJson('/api/support/visibility', ['accountId' => $user->id, 'public' => true])->assertOk();
        $this->getJson('/api/support')->assertJsonPath('supporters.0.pseudonym', $user->pseudonym)
            ->assertJsonMissingPath('supporters.0.amount_cents')->assertJsonMissingPath('supporters.0.email')->assertJsonPath('viewer.listed', true);
        $other = $this->user('other');
        $this->postJson('/api/support/visibility', ['accountId' => $other->id, 'public' => false])->assertForbidden();
        $this->postJson('/api/support/visibility', ['accountId' => $user->id, 'public' => false])->assertOk();
        $this->getJson('/api/support')->assertJsonPath('supporters', []);
        $this->signIn($other);
        $this->postJson('/api/support/visibility', ['accountId' => $other->id, 'public' => true])->assertForbidden();
        auth()->logout();
        $this->postJson('/api/support/visibility')->assertUnauthorized();
    }

    public function test_refunds_lower_the_total_and_a_stale_webhook_cannot_restore_refunded_money(): void
    {
        $user = $this->user();
        $paid = $this->paid($user);
        $this->sync($paid);
        $user->forceFill(['supporter_public' => true])->save();
        $partial = $this->paid($user, refund: 500);
        Http::fake(['api.stripe.com/*' => Http::response(['data' => [$partial], 'has_more' => false])]);
        $this->webhook(['payment_intent' => 'pi_one'], 'charge.refunded')->assertOk();
        $this->getJson('/api/support')->assertJsonPath('coveredCents', 1000);
        $this->assertTrue($user->isSupporter());
        $this->sync($this->paid($user, refund: 1500));
        $this->webhook($paid)->assertOk();
        $this->getJson('/api/support')->assertJsonPath('coveredCents', 0)->assertJsonPath('supporters', []);
        $this->assertFalse($user->isSupporter());
    }

    public function test_refund_received_before_payment_uses_current_stripe_state(): void
    {
        $user = $this->user();
        $refunded = $this->paid($user, refund: 1500);
        Http::fake(['api.stripe.com/*' => Http::response(['data' => [$refunded], 'has_more' => false])]);
        $this->webhook(['payment_intent' => 'pi_one'], 'charge.refunded')->assertOk();
        $this->assertDatabaseHas('support_donations', ['refunded_cents' => 1500]);
        $this->assertFalse($user->isSupporter());
    }

    public function test_year_rollover_keeps_badges_and_uses_configurable_goal_and_capped_progress(): void
    {
        $user = $this->user();
        $this->sync($this->paid($user, amount: 30000));
        $this->getJson('/api/support')->assertJsonPath('goalCents', 26000)->assertJsonPath('percent', 100);
        config(['support.yearly_goal_eur' => 500]);
        $this->getJson('/api/support')->assertJsonPath('goalCents', 50000)->assertJsonPath('percent', 60);
        $this->travelTo(now('UTC')->setDate(2027, 1, 1)->startOfDay());
        $this->getJson('/api/support')->assertJsonPath('year', 2027)->assertJsonPath('coveredCents', 0);
        $this->assertTrue($user->isSupporter());
        config(['support.yearly_goal_eur' => 0]);
        $this->getJson('/api/support')->assertJsonPath('percent', null);
    }

    public function test_test_donations_do_not_count_in_live_mode(): void
    {
        $user = $this->user();
        $this->sync($this->paid($user));
        $user->forceFill(['supporter_public' => true])->save();
        config(['support.stripe_livemode' => true]);
        $this->getJson('/api/support')->assertJsonPath('coveredCents', 0)->assertJsonPath('supporters', []);
        $this->assertFalse($user->isSupporter());
    }

    public function test_account_deletion_anonymizes_receipts_and_polling_never_relinks_them(): void
    {
        $user = $this->user();
        $session = $this->paid($user);
        $this->sync($session);
        $this->signIn($user);
        $this->postJson('/api/account/delete', ['accountId' => $user->id, 'confirmation' => 'musician', 'password' => 'A private password 123', 'keepPublications' => []])->assertOk();
        $this->assertDatabaseHas('support_donations', ['user_id' => null]);
        $this->sync($session);
        $this->assertDatabaseHas('support_donations', ['user_id' => null, 'amount_cents' => 1500]);
    }

    public function test_receipts_are_admin_only_and_banned_supporters_leave_the_wall(): void
    {
        $user = $this->user();
        $this->sync($this->paid($user));
        $this->getJson('/api/admin/support')->assertUnauthorized();
        $this->signIn($user);
        $this->getJson('/api/admin/support')->assertForbidden();
        $admin = $this->user('administrator', 'admin');
        $this->signIn($admin);
        $response = $this->getJson('/api/admin/support')->assertOk()->assertJsonPath('donations.0.session_id', 'cs_test_one');
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $user->forceFill(['supporter_public' => true, 'banned_at' => now()])->save();
        $this->getJson('/api/support')->assertJsonPath('supporters', []);
    }

    public function test_anonymous_receipt_can_be_assigned_after_verification_without_stealing_an_existing_donation(): void
    {
        $user = $this->user();
        $other = $this->user('other');
        $session = $this->paid();
        $this->sync($session);
        $this->artisan('support:reconcile', ['--session' => $session['id'], '--user' => $user->pseudonym])->assertFailed();
        $this->artisan('support:reconcile', ['--session' => $session['id'], '--user' => $user->pseudonym, '--confirm' => true])->assertSuccessful();
        $this->assertTrue($user->isSupporter());
        $this->artisan('support:reconcile', ['--session' => $session['id'], '--user' => $other->pseudonym, '--confirm' => true])->assertFailed();
        $this->assertFalse($other->isSupporter());
        $this->assertDatabaseCount('support_donations', 1);
    }

    public function test_support_migration_is_idempotent_and_preserves_consent_and_receipts(): void
    {
        $user = $this->user();
        $this->sync($this->paid($user));
        $user->forceFill(['supporter_public' => true])->save();
        $migration = require database_path('migrations/2026_10_31_000001_create_support.php');
        $migration->up();
        $migration->up();
        $this->assertTrue($user->fresh()->supporter_public);
        $this->assertDatabaseCount('support_donations', 1);
    }

    public function test_fallback_is_scheduled_every_fifteen_minutes_only_when_configured(): void
    {
        $event = collect(app(Schedule::class)->events())->first(fn ($event) => str_contains($event->command ?? '', 'support:reconcile'));
        $this->assertNotNull($event);
        $this->assertSame('*/15 * * * *', $event->expression);
        $this->assertTrue($event->withoutOverlapping);
        $this->assertTrue($event->filtersPass($this->app));
        config(['support.stripe_secret_key' => '']);
        $this->assertFalse($event->filtersPass($this->app));
        Http::assertNothingSent();
    }

    public function test_reconciliation_recovers_the_current_amount_when_a_refund_is_canceled(): void
    {
        $user = $this->user();
        $this->sync($this->paid($user, refund: 1500));
        $this->assertFalse($user->isSupporter());
        // A failed/canceled refund returns funds; this is a fresh API response, not an old event.
        $current = $this->paid($user, refund: 0);
        Http::swap(new Factory);
        Http::preventStrayRequests();
        Http::fake(['api.stripe.com/*' => Http::response(['data' => [$current], 'has_more' => false])]);
        $this->artisan('support:reconcile')->assertSuccessful();
        $this->getJson('/api/support')->assertJsonPath('coveredCents', 1500);
        $this->assertTrue($user->isSupporter());
    }

    public function test_refund_updates_and_failures_recheck_the_current_payment_instead_of_using_the_event_amount(): void
    {
        $user = $this->user();
        $this->sync($this->paid($user, refund: 1500));
        foreach ([['refund.updated', 500, 1000], ['refund.failed', 0, 1500]] as [$event, $refund, $covered]) {
            Http::swap(new Factory);
            Http::preventStrayRequests();
            Http::fake(['api.stripe.com/*' => Http::response(['data' => [$this->paid($user, refund: $refund)], 'has_more' => false])]);
            $this->webhook(['payment_intent' => 'pi_one', 'amount' => 1500], $event)->assertOk();
            $this->getJson('/api/support')->assertJsonPath('coveredCents', $covered);
        }
        $this->assertTrue($user->isSupporter());
    }

    public function test_competing_webhooks_retry_without_fetching_a_snapshot_that_could_be_applied_out_of_order(): void
    {
        $this->travelBack();
        $lock = Cache::lock('lyricflow-support-stripe', 300);
        $this->assertTrue($lock->get());
        try {
            $this->webhook($this->paid())->assertStatus(503);
            Http::assertNothingSent();
            $this->assertDatabaseCount('support_donations', 0);
        } finally {
            $lock->release();
        }
        $this->sync($this->paid());
        $this->assertDatabaseCount('support_donations', 1);
    }
}
