<?php

namespace App\Models;

use App\Support\AccountFeatures;
use Illuminate\Auth\MustVerifyEmail;
use Illuminate\Auth\Notifications\VerifyEmail;
use Illuminate\Contracts\Auth\MustVerifyEmail as MustVerifyEmailContract;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Facades\DB;

class User extends Authenticatable implements MustVerifyEmailContract
{
    use HasUuids, MustVerifyEmail, Notifiable;

    protected $fillable = ['email', 'pseudonym', 'password'];

    protected $attributes = ['session_version' => 1];

    protected $hidden = ['password', 'remember_token', 'google_subject', 'session_version'];

    public function getAuthPassword(): string
    {
        // Laravel's recaller requires a string even for Google-only accounts.
        // An empty hash cannot authenticate a password; the database value stays null.
        return $this->password ?? '';
    }

    protected function casts(): array
    {
        return [
            'password' => 'hashed',
            'email_verified_at' => 'datetime',
            'banned_at' => 'datetime',
            'session_version' => 'integer',
            'supporter_public' => 'boolean',
        ];
    }

    public function accountData(): array
    {
        return [
            'id' => $this->id,
            'pseudonym' => $this->pseudonym,
            'email' => $this->email,
            'verified' => $this->hasVerifiedEmail(),
            'hasPassword' => $this->password !== null,
            'googleLinked' => $this->google_subject !== null,
            'role' => $this->role ?? 'member',
            'supporter' => $this->isSupporter(),
        ];
    }

    public function isSupporter(): bool
    {
        return DB::table('support_donations')->where('livemode', config('support.stripe_livemode'))->where('user_id', $this->id)->whereColumn('amount_cents', '>', 'refunded_cents')->exists();
    }

    public function sendEmailVerificationNotification(): void
    {
        if (AccountFeatures::emailAvailable()) {
            $this->notify(new VerifyEmail);
        }
    }
}
