<?php

namespace App\Services;

use App\Models\User;
use Closure;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;

class StripeDonations
{
    private function synchronized(Closure $action): mixed
    {
        try {
            // Serialize the API snapshot AND its application, without holding a database
            // lock while calling Stripe. Webhooks retry if a polling page is in flight.
            return Cache::lock('lyricflow-support-stripe', 300)->block(1, $action);
        } catch (LockTimeoutException) {
            throw new RuntimeException('Donation reconciliation is busy. Retry shortly.');
        }
    }

    public function automatic(): bool
    {
        return config('lyricflow.accounts_enabled') && config('support.stripe_payment_link') && config('support.stripe_secret_key');
    }

    public function reference(string $id): string
    {
        return 'lf_'.$id.'_'.hash_hmac('sha256', 'lyricflow-donation:'.$id, config('app.key'));
    }

    private function referenceUser(mixed $reference): ?string
    {
        if (! is_string($reference) || ! preg_match('/^lf_([a-f0-9-]{36})_[a-f0-9]{64}$/D', $reference, $parts)
            || ! hash_equals($this->reference($parts[1]), $reference)) {
            return null;
        }

        return $parts[1];
    }

    public function donationUrl(?User $user): ?string
    {
        $url = config('support.stripe_url');
        $parts = is_string($url) ? parse_url($url) : false;
        if (! $parts || ($parts['scheme'] ?? '') !== 'https' || ! in_array($parts['host'] ?? '', ['buy.stripe.com', 'donate.stripe.com'], true)
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['port']) || empty($parts['path']) || preg_match('/[\s\\\\]/', $url)) {
            return null;
        }
        parse_str($parts['query'] ?? '', $query);
        unset($query['client_reference_id']);
        if ($user) {
            $query['client_reference_id'] = $this->reference($user->id);
        }

        return 'https://'.$parts['host'].$parts['path'].($query ? '?'.http_build_query($query, '', '&', PHP_QUERY_RFC3986) : '');
    }

    public function validSignature(string $body, string $header): bool
    {
        $secret = config('support.stripe_webhook_secret');
        if (! $secret || strlen($header) > 4096) {
            return false;
        }
        $values = [];
        foreach (explode(',', $header) as $part) {
            $pair = explode('=', trim($part), 2);
            if (count($pair) === 2) {
                $values[$pair[0]][] = $pair[1];
            }
        }
        $timestamp = $values['t'][0] ?? '';
        if (! ctype_digit($timestamp) || abs(now()->timestamp - (int) $timestamp) > 300) {
            return false;
        }
        $expected = hash_hmac('sha256', $timestamp.'.'.$body, $secret);
        foreach ($values['v1'] ?? [] as $signature) {
            if (hash_equals($expected, $signature)) {
                return true;
            }
        }

        return false;
    }

    private function get(string $path, array $query = []): array
    {
        if (! $this->automatic()) {
            throw new RuntimeException('Configure donation tracking, the Stripe Payment Link ID and API key first.');
        }
        try {
            $response = Http::withToken(config('support.stripe_secret_key'))->acceptJson()
                ->withHeaders(['Stripe-Version' => '2026-10-28.endive'])
                ->connectTimeout(5)->timeout(20)->get('https://api.stripe.com/v1/'.$path, $query);
            if (! $response->successful() || ! is_array($response->json())) {
                throw new RuntimeException;
            }

            return $response->json();
        } catch (Throwable) {
            // Never expose or log a provider response, authorization header or donor details.
            throw new RuntimeException('Stripe could not be reached. Donation tracking will retry.');
        }
    }

    public function syncSession(string $id, ?string $assignUser = null): bool
    {
        if (! preg_match('/^cs_[A-Za-z0-9_]{1,90}$/D', $id)) {
            throw new RuntimeException('Invalid Stripe Checkout Session ID.');
        }

        return $this->synchronized(fn () => $this->record(
            $this->get('checkout/sessions/'.$id, ['expand' => ['payment_intent.latest_charge']]), $assignUser,
        ));
    }

    public function reconcile(): int
    {
        $after = null;
        $count = 0;
        do {
            $page = $this->syncPage(array_filter([
                'payment_link' => config('support.stripe_payment_link'), 'status' => 'complete',
                'limit' => 100, 'starting_after' => $after,
            ]));
            $count += $page['count'];
            if ($page['more'] && (! is_string($page['last']) || $page['last'] === $after)) {
                throw new RuntimeException('Invalid Stripe pagination cursor.');
            }
            $after = $page['last'];
        } while ($page['more']);

        return $count;
    }

    public function syncPaymentIntent(string $id): void
    {
        if (! preg_match('/^pi_[A-Za-z0-9_]{1,90}$/D', $id)) {
            throw new RuntimeException('Invalid Stripe Payment Intent ID.');
        }
        $this->syncPage(['payment_intent' => $id, 'limit' => 100]);
    }

    private function syncPage(array $filters): array
    {
        return $this->synchronized(function () use ($filters): array {
            $page = $this->get('checkout/sessions', [...$filters, 'expand' => ['data.payment_intent.latest_charge']]);
            if (! is_array($page['data'] ?? null) || ! is_bool($page['has_more'] ?? null)) {
                throw new RuntimeException('Invalid Stripe pagination response.');
            }
            $count = 0;
            foreach ($page['data'] as $session) {
                $count += (int) $this->record($session);
            }
            $last = end($page['data']);

            return ['count' => $count, 'more' => $page['has_more'], 'last' => is_array($last) ? ($last['id'] ?? null) : null];
        });
    }

    private function record(array $session, ?string $assignUser = null): bool
    {
        if (($session['object'] ?? '') !== 'checkout.session' || ($session['payment_link'] ?? null) !== config('support.stripe_payment_link')
            || ($session['livemode'] ?? null) !== config('support.stripe_livemode') || ($session['mode'] ?? '') !== 'payment'
            || ($session['status'] ?? '') !== 'complete' || ($session['payment_status'] ?? '') !== 'paid'
            || ($session['currency'] ?? '') !== 'eur') {
            return false;
        }
        $intent = $session['payment_intent'] ?? null;
        $charge = is_array($intent) ? ($intent['latest_charge'] ?? null) : null;
        if (! is_array($charge) || ($charge['paid'] ?? false) !== true || ($charge['currency'] ?? '') !== 'eur'
            || ($charge['payment_intent'] ?? null) !== ($intent['id'] ?? null)
            || ! is_int($session['amount_total'] ?? null) || $session['amount_total'] <= 0
            || ($charge['amount'] ?? null) !== $session['amount_total'] || ! is_int($charge['amount_refunded'] ?? null)
            || $charge['amount_refunded'] < 0 || $charge['amount_refunded'] > $session['amount_total']
            || ! is_int($charge['created'] ?? null) || ! is_string($session['id'] ?? null)
            || ! is_string($intent['id'] ?? null)) {
            throw new RuntimeException('Invalid paid Stripe donation.');
        }
        $userId = $assignUser ?? $this->referenceUser($session['client_reference_id'] ?? null);

        return DB::transaction(function () use ($session, $intent, $charge, $userId, $assignUser): bool {
            // Same lock order as account deletion. Serializes webhook/polling and repeat deliveries.
            Community::lock();
            $user = $userId ? User::whereKey($userId)->lockForUpdate()->first() : null;
            $existing = DB::table('support_donations')->where('session_id', $session['id'])->lockForUpdate()->first();
            if ($assignUser && (! $user || $user->banned_at || ($existing?->user_id && $existing->user_id !== $assignUser))) {
                throw new RuntimeException('The donation cannot be assigned to this account.');
            }
            if ($existing) {
                DB::table('support_donations')->where('session_id', $session['id'])->update([
                    // A canceled/failed refund can return funds: trust the current API
                    // state rather than keeping the largest refund seen forever.
                    'refunded_cents' => $charge['amount_refunded'],
                    // Account deletion is permanent: polling must never relink an anonymized donation.
                    'user_id' => $assignUser ?? $existing->user_id, 'updated_at' => now(),
                ]);
            } else {
                DB::table('support_donations')->insert([
                    'session_id' => $session['id'], 'payment_intent' => $intent['id'], 'user_id' => $user?->id,
                    'livemode' => $session['livemode'],
                    'amount_cents' => $session['amount_total'], 'refunded_cents' => $charge['amount_refunded'],
                    'paid_at' => Carbon::createFromTimestampUTC($charge['created']), 'created_at' => now(), 'updated_at' => now(),
                ]);
            }

            return true;
        }, 3);
    }
}
