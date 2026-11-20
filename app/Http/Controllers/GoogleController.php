<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\GoogleIdentity;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

class GoogleController extends Controller
{
    public static function configured(): bool
    {
        return filled(config('services.google.client_id')) && filled(config('services.google.client_secret'))
            && filled(config('services.google.redirect'));
    }

    public function prepareLink(Request $request): JsonResponse
    {
        abort_unless(self::configured(), 503, __('accounts.google_unavailable'));
        abort_if($request->user()->google_subject !== null, 409, __('accounts.google_linked_elsewhere'));
        $request->validate(['password' => ['required', 'current_password:web']]);
        $request->session()->put('google.link', ['user' => Auth::id(), 'expires' => time() + 300]);

        return response()->json(['redirect' => '/auth/google/redirect']);
    }

    public function cancel(Request $request): JsonResponse
    {
        $request->session()->forget(['google.pending', 'google.flow']);

        return response()->json(['user' => $request->user()?->accountData()]);
    }

    public function redirect(Request $request): RedirectResponse
    {
        abort_unless(self::configured(), 503, __('accounts.google_unavailable'));
        $request->validate(['remember' => ['sometimes', 'boolean']]);
        $link = $request->session()->pull('google.link');
        abort_if(Auth::check() && (! $link || $link['user'] !== Auth::id() || $link['expires'] < time()), 409, __('accounts.already_signed_in'));
        $flow = [
            'state' => Str::random(64), 'nonce' => Str::random(64), 'verifier' => Str::random(96),
            'expires' => time() + 600, 'link' => Auth::check() ? Auth::id() : null,
            'remember' => $request->boolean('remember'),
        ];
        $request->session()->forget('google.pending');
        $request->session()->put('google.flow', $flow);

        return redirect()->away('https://accounts.google.com/o/oauth2/v2/auth?'.http_build_query([
            'client_id' => config('services.google.client_id'), 'redirect_uri' => config('services.google.redirect'),
            'response_type' => 'code', 'scope' => 'openid email', 'prompt' => 'select_account',
            'state' => $flow['state'], 'nonce' => $flow['nonce'],
            'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $flow['verifier'], true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256',
        ], '', '&', PHP_QUERY_RFC3986));
    }

    public function callback(Request $request, GoogleIdentity $google, AccountController $accounts): RedirectResponse
    {
        $flow = $request->session()->pull('google.flow');
        if (! self::configured() || ! $flow || ($flow['expires'] ?? 0) < time()
            || ! is_string($request->query('state')) || ! hash_equals($flow['state'], $request->query('state'))
            || ! is_string($request->query('code')) || strlen($request->query('code')) > 4096
            || $request->has('error')) {
            return redirect('/#account?error=google_failed');
        }
        try {
            $identity = $google->exchange($request->query('code'), $flow);
        } catch (Throwable) {
            // Tokens, authorization codes and provider responses never enter logs.
            return redirect('/#account?error=google_failed');
        }
        $owner = User::where('google_subject', $identity['subject'])->first();
        if ($flow['link']) {
            if (! Auth::check() || Auth::id() !== $flow['link'] || Auth::user()->banned_at
                || ($owner && $owner->id !== Auth::id())
                || (Auth::user()->google_subject !== null && Auth::user()->google_subject !== $identity['subject'])) {
                return redirect('/#account?error=google_linked_elsewhere');
            }
            try {
                Auth::user()->forceFill(['google_subject' => $identity['subject']])->save();
            } catch (UniqueConstraintViolationException) {
                return redirect('/#account?error=google_linked_elsewhere');
            }

            return redirect('/#account');
        }
        if (Auth::check()) {
            return redirect('/#account?error=google_failed');
        }
        if ($owner) {
            if ($owner->banned_at) {
                return redirect('/#account?error=google_failed');
            }
            $accounts->signIn($request, $owner, remember: $flow['remember'] ?? false);

            return redirect('/#account');
        }
        if (User::where('email', $identity['email'])->exists()) {
            return redirect('/#account?error=google_existing');
        }
        $request->session()->put('google.pending', [...$identity, 'expires' => time() + 600, 'remember' => $flow['remember'] ?? false]);

        return redirect('/#account');
    }

    public function complete(Request $request, AccountController $accounts): JsonResponse
    {
        abort_if(Auth::check(), 409, __('accounts.already_signed_in'));
        $pending = $request->session()->get('google.pending');
        abort_unless($pending && $pending['expires'] > time(), 422, __('accounts.google_expired'));
        $request->validate(['pseudonym' => ['required', 'string', 'max:30']]);
        $request->merge(['pseudonym' => Str::lower(trim((string) $request->input('pseudonym')))]);
        $data = $request->validate(['pseudonym' => AccountController::pseudonymRules()]);
        try {
            $user = DB::transaction(function () use ($data, $pending): User {
                $user = new User(['email' => $pending['email'], 'pseudonym' => $data['pseudonym']]);
                $user->forceFill(['google_subject' => $pending['subject'], 'email_verified_at' => now()])->save();

                return $user;
            });
        } catch (UniqueConstraintViolationException) {
            throw ValidationException::withMessages(['pseudonym' => __('accounts.google_existing')]);
        }

        return $accounts->signIn($request, $user, 201, $pending['remember'] ?? false);
    }
}
