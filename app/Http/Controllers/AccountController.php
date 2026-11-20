<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\Community;
use App\Support\AccountFeatures;
use Illuminate\Auth\Events\PasswordReset;
use Illuminate\Auth\Events\Registered;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password as PasswordRule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\Mailer\Exception\TransportExceptionInterface;

class AccountController extends Controller
{
    public static function emailAvailable(): bool
    {
        return AccountFeatures::emailAvailable();
    }

    public function session(Request $request): JsonResponse
    {
        $enabled = (bool) config('lyricflow.accounts_enabled');

        return response()->json([
            'enabled' => $enabled,
            'emailEnabled' => $enabled && self::emailAvailable(),
            'googleEnabled' => $enabled && GoogleController::configured(),
            'user' => $enabled ? $request->user()?->accountData() : null,
            'csrfToken' => csrf_token(),
            'googlePending' => $enabled && $request->session()->get('google.pending.expires', 0) > time(),
        ]);
    }

    public static function pseudonymRules(): array
    {
        return ['required', 'string', 'min:3', 'max:30', 'regex:/^[a-z0-9][a-z0-9_-]*$/', Rule::notIn(['anonymous']), Rule::unique('users', 'pseudonym')];
    }

    private function passwordRules(bool $new = true): array
    {
        return ['required', 'string', ...($new ? ['confirmed', PasswordRule::min(12)] : []), function (string $attribute, mixed $value, \Closure $fail): void {
            // Bcrypt must never silently truncate passwords beyond its byte limit.
            if (is_string($value) && (strlen($value) > 72 || str_contains($value, "\0"))) {
                $fail(__('accounts.password_length'));
            }
        }];
    }

    public function register(Request $request): JsonResponse
    {
        abort_if(Auth::check(), 409, __('accounts.already_signed_in'));
        $request->validate(['email' => ['required', 'string', 'max:254'], 'pseudonym' => ['required', 'string', 'max:30']]);
        $request->merge(['email' => Str::lower(trim((string) $request->input('email'))), 'pseudonym' => Str::lower(trim((string) $request->input('pseudonym')))]);
        $data = $request->validate([
            'email' => ['required', 'email', 'max:254', Rule::unique('users', 'email')],
            'pseudonym' => self::pseudonymRules(),
            'password' => $this->passwordRules(),
        ], ['pseudonym.regex' => __('accounts.pseudonym'), 'pseudonym.not_in' => __('accounts.pseudonym')]);
        try {
            $user = User::create($data);
        } catch (UniqueConstraintViolationException) {
            throw ValidationException::withMessages(['email' => __('accounts.identity_unavailable')]);
        }
        $response = $this->signIn($request, $user, 201);
        try {
            event(new Registered($user));
        } catch (TransportExceptionInterface) {
            Log::warning('Account verification email delivery failed.');
            $response->setData([...$response->getData(true), 'message' => __('accounts.email_failed')]);
        }

        return $response;
    }

    public function login(Request $request): JsonResponse
    {
        abort_if(Auth::check(), 409, __('accounts.already_signed_in'));
        $data = $request->validate(['email' => ['required', 'email', 'max:254'], 'password' => $this->passwordRules(false), 'remember' => ['sometimes', 'boolean']]);
        $credentials = ['email' => Str::lower(trim($data['email'])), 'password' => $data['password'], 'banned_at' => null];
        if (! Auth::attempt($credentials)) {
            throw ValidationException::withMessages(['email' => __('accounts.credentials')]);
        }

        return $this->signIn($request, Auth::user(), remember: $data['remember'] ?? false);
    }

    public function signIn(Request $request, User $user, int $status = 200, bool $remember = false): JsonResponse
    {
        abort_if($user->banned_at, 403, __('accounts.credentials'));
        Auth::login($user, $remember);
        $request->session()->regenerate();
        $request->session()->put('account_version', $user->session_version);
        $request->session()->put('account_signed_in_at', time());
        $request->session()->forget(['google.pending', 'google.flow', 'google.link']);

        return response()->json(['user' => $user->accountData(), 'csrfToken' => csrf_token()], $status);
    }

    public function logout(Request $request): JsonResponse
    {
        Auth::logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json(['user' => null, 'csrfToken' => csrf_token()]);
    }

    public function delete(Request $request): JsonResponse
    {
        $data = $request->validate([
            'accountId' => ['required', 'uuid'],
            'confirmation' => ['required', Rule::in([$request->user()->pseudonym])],
            'password' => ['nullable', 'string', 'max:128'],
            'keepPublications' => ['sometimes', 'array', 'max:10000'],
            'keepPublications.*' => ['required', 'uuid', 'distinct'],
        ]);
        abort_unless($data['accountId'] === $request->user()->id, 403);
        DB::transaction(function () use ($request, $data): void {
            Community::lock();
            $user = User::whereKey($data['accountId'])->lockForUpdate()->first();
            abort_unless($user && ! $user->banned_at && $user->session_version === $request->session()->get('account_version'), 401);
            if ($user->password && ! Hash::check($data['password'] ?? '', $user->password)) {
                throw ValidationException::withMessages(['password' => __('accounts.credentials')]);
            }
            // Google-only accounts require a recent sign-in as well as typed confirmation.
            abort_if(! $user->password && $request->session()->get('account_signed_in_at', 0) < time() - 600, 403, __('accounts.recent_sign_in'));
            Community::protectLastAdmin($user);
            $keep = $data['keepPublications'] ?? [];
            abort_unless(DB::table('publications')->where('user_id', $user->id)->whereIn('id', $keep)->count() === count($keep), 422);
            DB::table('publications')->where('user_id', $user->id)->whereNotIn('id', $keep)->delete();
            DB::table('publications')->where('user_id', $user->id)->update(['user_id' => null, 'local_song_id' => null]);
            Community::audit($user->id, 'account.delete', 'user', $user->id, 'Account deleted by its owner.');
            DB::table('password_reset_tokens')->where('email', $user->email)->delete();
            $user->delete(); // Foreign keys remove private data, tombstones and receipts.
        });

        return $this->logout($request);
    }

    public function forgot(Request $request): JsonResponse
    {
        abort_unless(self::emailAvailable(), 503, __('accounts.email_unavailable'));
        $data = $request->validate(['email' => ['required', 'email', 'max:254']]);
        try {
            Password::sendResetLink(['email' => Str::lower(trim($data['email']))]);
        } catch (TransportExceptionInterface) {
            Log::warning('Account recovery email delivery failed.');
            abort(503, __('accounts.email_failed'));
        }

        return response()->json(['message' => __('accounts.recovery_sent')], 202);
    }

    public function reset(Request $request): JsonResponse
    {
        $data = $request->validate([
            'email' => ['required', 'email', 'max:254'], 'token' => ['required', 'string', 'max:200'],
            'password' => $this->passwordRules(),
        ]);
        $data['email'] = Str::lower(trim($data['email']));
        $status = Password::reset($data, function (User $user, string $password): void {
            DB::transaction(function () use ($user, $password): void {
                $user->forceFill(['password' => Hash::make($password), 'remember_token' => Str::random(60)])->save();
                $user->increment('session_version');
            });
            event(new PasswordReset($user));
        });
        if ($status !== Password::PasswordReset) {
            throw ValidationException::withMessages(['email' => __('accounts.reset_invalid')]);
        }
        $request->session()->forget(['google.pending', 'google.flow', 'google.link']);

        return response()->json(['message' => __('accounts.password_reset')]);
    }

    public function resend(Request $request): JsonResponse
    {
        abort_unless(self::emailAvailable(), 503, __('accounts.email_unavailable'));
        if (! $request->user()->hasVerifiedEmail()) {
            try {
                $request->user()->sendEmailVerificationNotification();
            } catch (TransportExceptionInterface) {
                Log::warning('Account verification email delivery failed.');
                abort(503, __('accounts.email_failed'));
            }
        }

        return response()->json(['message' => __('accounts.verification_sent')]);
    }
}
