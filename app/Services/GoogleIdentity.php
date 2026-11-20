<?php

namespace App\Services;

use Firebase\JWT\JWK;
use Firebase\JWT\JWT;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use UnexpectedValueException;

class GoogleIdentity
{
    public const TOKEN_URL = 'https://oauth2.googleapis.com/token';

    public const KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

    public function exchange(string $code, array $flow): array
    {
        $response = Http::asForm()->timeout(15)->post(self::TOKEN_URL, [
            'client_id' => config('services.google.client_id'),
            'client_secret' => config('services.google.client_secret'),
            'redirect_uri' => config('services.google.redirect'),
            'grant_type' => 'authorization_code',
            'code' => $code,
            'code_verifier' => $flow['verifier'],
        ]);
        // Do not throw an HTTP exception containing Google's response or tokens.
        if (! $response->successful() || ! is_string($token = $response->json('id_token'))) {
            throw new UnexpectedValueException('Google token exchange failed.');
        }

        $keys = Cache::remember('google.oidc.public-keys', 3600, fn () => $this->fetchKeys());
        try {
            $claims = JWT::decode($token, JWK::parseKeySet($keys, 'RS256'));
        } catch (UnexpectedValueException $error) {
            // A provider key rotation must work without waiting for cache expiry.
            if (! str_contains($error->getMessage(), 'kid')) {
                throw $error;
            }
            $keys = $this->fetchKeys();
            Cache::put('google.oidc.public-keys', $keys, 3600);
            $claims = JWT::decode($token, JWK::parseKeySet($keys, 'RS256'));
        }

        $audience = (array) ($claims->aud ?? []);
        $client = config('services.google.client_id');
        if (! in_array($claims->iss ?? '', ['https://accounts.google.com', 'accounts.google.com'], true)
            || ! in_array($client, $audience, true)
            || (isset($claims->azp) && $claims->azp !== $client)
            || (count($audience) > 1 && ($claims->azp ?? null) !== $client)
            || ! is_numeric($claims->exp ?? null) || $claims->exp <= time()
            || ! is_numeric($claims->iat ?? null)
            || ! is_string($claims->nonce ?? null) || ! hash_equals($flow['nonce'], $claims->nonce)
            || ! is_string($claims->sub ?? null) || $claims->sub === '' || strlen($claims->sub) > 255
            || ($claims->email_verified ?? false) !== true
            || ! is_string($claims->email ?? null) || strlen($claims->email) > 254
            || ! filter_var($claims->email, FILTER_VALIDATE_EMAIL)) {
            throw new UnexpectedValueException('Google identity claims were rejected.');
        }

        return ['subject' => $claims->sub, 'email' => Str::lower($claims->email)];
    }

    private function fetchKeys(): array
    {
        $response = Http::timeout(10)->get(self::KEYS_URL);
        if (! $response->successful() || ! is_array($keys = $response->json('keys'))) {
            throw new UnexpectedValueException('Google public keys are unavailable.');
        }

        $keys = array_values(array_filter($keys, fn ($key) => is_array($key)
            && ($key['kty'] ?? '') === 'RSA' && ($key['alg'] ?? '') === 'RS256'));
        if ($keys === []) {
            throw new UnexpectedValueException('Google public keys are unavailable.');
        }

        return ['keys' => $keys];
    }
}
