<?php

namespace App\Services;

use App\Models\User;
use Closure;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class Community
{
    public static function normalize(string $text): string
    {
        $text = preg_replace('/\s+/u', ' ', trim($text));
        $text = preg_replace('/\p{M}+/u', '', $text);

        // Fold accents without discarding scripts that have no ASCII transliteration.
        return Str::lower(preg_replace_callback('/[^\x00-\x7f]/u', fn ($match) => Str::ascii($match[0]) ?: $match[0], $text));
    }

    public static function identity(string $title, string $artist): array
    {
        $title = self::normalize($title);
        $artist = self::normalize($artist);

        return ['search_title' => $title, 'search_artist' => $artist, 'identity_hash' => hash('sha256', json_encode([$title, $artist], JSON_THROW_ON_ERROR))];
    }

    public static function lock(): object
    {
        return DB::table('community_settings')->where('id', 1)->lockForUpdate()->firstOrFail();
    }

    public static function mutate(Request $request, Closure $action): mixed
    {
        $request->validate(['accountId' => ['required', 'uuid']]);
        abort_unless($request->input('accountId') === $request->user()->id, 403);

        return DB::transaction(function () use ($request, $action) {
            $settings = self::lock();
            $user = User::whereKey($request->user()->id)->lockForUpdate()->first();
            abort_unless($user && ! $user->banned_at && $user->session_version === $request->session()->get('account_version'), 401);

            return $action($user, $settings);
        }, 3);
    }

    public static function visible(): Builder
    {
        return self::publications()->where('p.published', true)->where('p.moderation_hidden', false)
            ->where(fn ($query) => $query->whereNull('p.user_id')->orWhere(fn ($owner) => $owner->whereNotNull('u.id')->whereNull('u.banned_at')));
    }

    public static function publications(): Builder
    {
        return DB::table('publications as p')->leftJoin('users as u', 'u.id', '=', 'p.user_id')
            ->select('p.*', 'u.pseudonym')
            ->selectSub(DB::table('ratings')->whereColumn('publication_id', 'p.id')->selectRaw('AVG(stars)'), 'average')
            ->selectSub(DB::table('ratings')->whereColumn('publication_id', 'p.id')->selectRaw('COUNT(*)'), 'rating_count');
    }

    public static function rank(Builder $query): Builder
    {
        return $query->orderByRaw('average IS NULL')->orderByDesc('average')->orderByDesc('rating_count')->orderBy('p.id');
    }

    public static function publication(string $id, bool $visible = true): object
    {
        return ($visible ? self::visible() : self::publications())->where('p.id', $id)->firstOrFail();
    }

    public static function data(object $publication, bool $content = false): array
    {
        $data = [
            'id' => $publication->id, 'catalogId' => $publication->catalog_song_id,
            'author' => $publication->pseudonym ?? 'Anonymous', 'authorId' => $publication->user_id,
            'revision' => (int) $publication->revision, 'updatedAt' => Carbon::parse($publication->updated_at, 'UTC')->toISOString(),
            'average' => $publication->average === null ? null : (float) $publication->average,
            'ratingCount' => (int) $publication->rating_count,
            'published' => (bool) $publication->published, 'hidden' => (bool) $publication->moderation_hidden,
            'source' => $publication->source_publication_id ? ['publicationId' => $publication->source_publication_id, 'revision' => (int) $publication->source_revision] : null,
        ];
        if ($content) {
            $revision = DB::table('publication_revisions')->where('publication_id', $publication->id)->where('number', $publication->revision)->firstOrFail();
            $data['content'] = json_decode($revision->content, true, flags: JSON_THROW_ON_ERROR);
        }

        return $data;
    }

    public static function ownedData(object $publication): array
    {
        return [...self::data($publication, true), 'localSongId' => $publication->local_song_id,
            'autoShareUpdates' => (bool) $publication->auto_share_updates,
            'sharingVersion' => (int) $publication->sharing_version];
    }

    public static function staff(User $user, bool $admin = false): void
    {
        abort_unless($admin ? $user->role === 'admin' : in_array($user->role, ['moderator', 'admin']), 403);
    }

    public static function audit(?string $actorId, string $action, string $type, string $id, string $reason): void
    {
        DB::table('moderation_events')->insert(['actor_id' => $actorId, 'action' => $action, 'target_type' => $type, 'target_id' => $id, 'reason' => $reason, 'created_at' => now()]);
    }

    public static function protectLastAdmin(User $target): void
    {
        if ($target->role === 'admin' && ! $target->banned_at) {
            abort_if(User::where('role', 'admin')->whereNull('banned_at')->count() <= 1, 409, __('community.last_admin'));
        }
    }
}
