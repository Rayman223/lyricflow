<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\Community;
use App\Services\Score;
use App\Services\SharedSong;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class CommunityController extends Controller
{
    public function prompter(Request $request, string $id): JsonResponse
    {
        $publication = Community::data(Community::publication($id), true);
        $capabilities = array_map('trim', explode(',', $request->header('X-LyricFlow-Capabilities', '')));
        if (! in_array('line-timing', $capabilities, true) && SharedSong::requiresLineTiming($publication['content']['lyrics'])) {
            return response()->json(['error' => 'client_update_required', 'message' => __('community.client_update_required')], 409);
        }

        return response()->json(['publication' => array_intersect_key($publication, array_flip(['id', 'revision', 'author', 'content']))]);
    }

    public function catalog(Request $request): JsonResponse
    {
        $data = $request->validate(['q' => ['nullable', 'string', 'max:200'], 'page' => ['sometimes', 'integer', 'min:1', 'max:100000'], 'sort' => ['sometimes', Rule::in(['title', 'stars'])]]);
        $stats = DB::query()->fromSub(Community::visible(), 'versions')->select('catalog_song_id')->selectRaw('MAX(average) as best_average, COUNT(*) as version_count')->groupBy('catalog_song_id');
        $query = DB::table('catalog_songs as c')->joinSub($stats, 'stats', 'stats.catalog_song_id', '=', 'c.id')->select('c.id', 'c.title', 'c.artist', 'stats.best_average', 'stats.version_count');
        $term = Community::normalize($data['q'] ?? '');
        if ($term !== '') {
            // Literal substring matching avoids wildcard expansion from user input.
            $query->where(fn ($q) => $q->whereRaw('INSTR(c.search_title, ?) > 0', [$term])->orWhereRaw('INSTR(c.search_artist, ?) > 0', [$term]));
        }
        if (($data['sort'] ?? 'title') === 'stars') {
            $query->orderByRaw('best_average IS NULL')->orderByDesc('best_average');
        }
        $page = $query->orderBy('c.title')->orderBy('c.id')->simplePaginate(20);

        return response()->json(['songs' => $page->items(), 'more' => $page->hasMorePages(), 'settings' => DB::table('community_settings')->where('id', 1)->first()]);
    }

    public function versions(Request $request, string $id): JsonResponse
    {
        $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $song = DB::table('catalog_songs')->where('id', $id)->firstOrFail();
        abort_unless(Community::visible()->where('p.catalog_song_id', $id)->exists(), 404);
        $page = Community::rank(Community::visible()->where('p.catalog_song_id', $id))->simplePaginate(20);

        return response()->json(['song' => ['id' => $song->id, 'title' => $song->title, 'artist' => $song->artist], 'publications' => array_map(fn ($row) => Community::data($row), $page->items()), 'more' => $page->hasMorePages()]);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $publication = Community::publication($id);
        $ratings = DB::table('ratings as r')->join('users as u', 'u.id', '=', 'r.user_id')->where('r.publication_id', $id)->orderByDesc('r.updated_at')->orderBy('r.id')
            ->select('r.id', 'r.user_id', 'u.pseudonym', 'r.stars', 'r.comment', 'r.comment_hidden', 'r.revision', 'r.updated_at')->simplePaginate(20);
        $items = array_map(function ($row): array {
            return ['id' => $row->id, 'authorId' => $row->user_id, 'author' => $row->pseudonym, 'stars' => (int) $row->stars, 'comment' => $row->comment_hidden ? null : $row->comment, 'revision' => (int) $row->revision, 'updatedAt' => Carbon::parse($row->updated_at, 'UTC')->toISOString()];
        }, $ratings->items());
        $own = DB::table('ratings')->where('publication_id', $id)->where('user_id', $request->user()->id)->first();

        return response()->json(['publication' => Community::data($publication, true), 'ratings' => $items, 'more' => $ratings->hasMorePages(), 'ownRating' => $own ? ['stars' => (int) $own->stars, 'comment' => $own->comment ?? '', 'hidden' => (bool) $own->comment_hidden] : null]);
    }

    public function mine(Request $request): JsonResponse
    {
        $data = $request->validate(['songId' => ['sometimes', 'uuid'], 'sort' => ['sometimes', Rule::in(['id'])], 'page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $query = Community::publications()->where('p.user_id', $request->user()->id);
        if (isset($data['songId'])) {
            $query->where('p.local_song_id', $data['songId']);
        }
        // Background pagination must not move rows when another tab updates a song.
        if (($data['sort'] ?? null) !== 'id') {
            $query->orderByDesc('p.updated_at');
        }
        $page = $query->orderBy('p.id')->simplePaginate(20);

        return response()->json(['accountId' => $request->user()->id, 'publications' => array_map(fn ($row) => Community::ownedData($row), $page->items()), 'more' => $page->hasMorePages()]);
    }

    public function publish(Request $request): JsonResponse
    {
        return $this->publishVersion($request);
    }

    public function automaticUpdate(Request $request, string $id): JsonResponse
    {
        return $this->publishVersion($request, $id);
    }

    public function autoShare(Request $request, string $id): JsonResponse
    {
        $data = $request->validate(['enabled' => ['required', 'boolean'], 'expectedSharingVersion' => ['required', 'integer', 'min:1'], 'operationId' => ['required', 'uuid']]);

        return Community::mutate($request, function (User $user) use ($id, $data): JsonResponse {
            $publication = DB::table('publications')->where('id', $id)->where('user_id', $user->id)->firstOrFail();
            if ($publication->sharing_operation_id === $data['operationId']) {
                abort_unless((bool) $publication->auto_share_updates === (bool) $data['enabled'] && (int) $publication->sharing_version === (int) $data['expectedSharingVersion'] + 1, 409, __('community.sharing_changed'));
            } else {
                abort_unless((int) $publication->sharing_version === (int) $data['expectedSharingVersion'], 409, __('community.sharing_changed'));
                DB::table('publications')->where('id', $id)->update(['auto_share_updates' => (bool) $data['enabled'], 'sharing_version' => $publication->sharing_version + 1, 'sharing_operation_id' => $data['operationId']]);
            }

            return response()->json(['publication' => Community::ownedData(Community::publication($id, false))]);
        });
    }

    private function publishVersion(Request $request, ?string $publicationId = null): JsonResponse
    {
        $automatic = $publicationId !== null;
        $data = $request->validate([
            'localSongId' => ['required', 'uuid'], 'expectedRevision' => ['required', 'integer', 'min:0'],
            'content' => ['required', 'array'], 'sharingAccepted' => $automatic ? ['sometimes', 'accepted'] : ['required', 'accepted'],
            'expectedSharingVersion' => $automatic ? ['required', 'integer', 'min:1'] : ['sometimes', 'integer', 'min:1'],
            'source' => ['sometimes', 'nullable', 'array:publicationId,revision'],
            'source.publicationId' => ['required_with:source', 'uuid'], 'source.revision' => ['required_with:source', 'integer', 'min:1'],
        ]);
        $content = SharedSong::validate($data['content']);

        return Community::mutate($request, function (User $user, object $settings) use ($data, $content, $automatic, $publicationId): JsonResponse {
            abort_unless($settings->publishing_enabled, 403, __('community.publishing_paused'));
            $existing = DB::table('publications')->where('user_id', $user->id)->where('local_song_id', $data['localSongId'])->first();
            if ($automatic) {
                abort_unless($existing && $existing->id === $publicationId, 404);
                abort_unless($existing->published && ! $existing->moderation_hidden && $existing->auto_share_updates
                    && (int) $existing->sharing_version === (int) $data['expectedSharingVersion'], 409, __('community.sharing_changed'));
            }
            $oldContent = $existing ? json_decode(DB::table('publication_revisions')->where('publication_id', $existing->id)->where('number', $existing->revision)->firstOrFail()->content, true, flags: JSON_THROW_ON_ERROR) : null;
            if ($oldContent) {
                Score::preserve($oldContent, $content);
            }
            $catalogId = $existing?->catalog_song_id;
            // Retain administrative corrections and merges when only musical content changes.
            if (! $existing || $oldContent['title'] !== $content['title'] || $oldContent['artist'] !== $content['artist']) {
                $identity = Community::identity($content['title'], $content['artist']);
                $catalog = DB::table('catalog_songs')->where('identity_hash', $identity['identity_hash'])->first();
                if (! $catalog) {
                    $catalogId = (string) Str::uuid();
                    DB::table('catalog_songs')->insert(['id' => $catalogId, 'title' => trim($content['title']), 'artist' => trim($content['artist']), ...$identity, 'created_at' => now(), 'updated_at' => now()]);
                } else {
                    $catalogId = $catalog->id;
                }
            }
            if ($existing) {
                $changed = $oldContent != $content;
                // Retrying an already applied explicit update never creates an extra revision.
                abort_if((int) $data['expectedRevision'] !== (int) $existing->revision && $changed, 409, __('community.revision_changed'));
                $number = (int) $existing->revision + (int) $changed;
                if ($changed) {
                    DB::table('publication_revisions')->insert(['publication_id' => $existing->id, 'number' => $number, 'content' => json_encode($content, JSON_THROW_ON_ERROR), 'created_at' => now()]);
                }
                DB::table('publications')->where('id', $existing->id)->update(['catalog_song_id' => $catalogId, 'revision' => $number, 'published' => true, 'sharing_version' => $existing->sharing_version + (int) ! $automatic, 'updated_at' => $changed || ! $existing->published ? now() : $existing->updated_at]);
                $id = $existing->id;
            } else {
                abort_unless((int) $data['expectedRevision'] === 0, 409, __('community.revision_changed'));
                $source = $data['source'] ?? null;
                if ($source) {
                    // A source may since have disappeared: a known public revision is enough
                    // for attribution; it is never returned by this validation lookup.
                    if (DB::table('publications')->where('id', $source['publicationId'])->exists()) {
                        abort_unless(DB::table('publication_revisions')->where('publication_id', $source['publicationId'])->where('number', $source['revision'])->exists(), 422, __('community.source_unavailable'));
                    }
                }
                $id = (string) Str::uuid();
                DB::table('publications')->insert(['id' => $id, 'catalog_song_id' => $catalogId, 'user_id' => $user->id, 'local_song_id' => $data['localSongId'], 'revision' => 1, 'published' => true, 'moderation_hidden' => false, 'source_publication_id' => $source['publicationId'] ?? null, 'source_revision' => $source['revision'] ?? null, 'created_at' => now(), 'updated_at' => now()]);
                DB::table('publication_revisions')->insert(['publication_id' => $id, 'number' => 1, 'content' => json_encode($content, JSON_THROW_ON_ERROR), 'created_at' => now()]);
            }

            return response()->json(['publication' => Community::ownedData(Community::publication($id, false))]);
        });
    }

    public function unpublish(Request $request, string $id): JsonResponse
    {
        $data = $request->validate(['expectedRevision' => ['required', 'integer', 'min:1']]);

        return Community::mutate($request, function (User $user) use ($id, $data): JsonResponse {
            $publication = DB::table('publications')->where('id', $id)->where('user_id', $user->id)->firstOrFail();
            abort_unless((int) $publication->revision === (int) $data['expectedRevision'], 409, __('community.revision_changed'));
            DB::table('publications')->where('id', $id)->update(['published' => false, 'sharing_version' => $publication->sharing_version + 1]);

            return response()->json(['message' => __('community.unpublished'), 'publication' => Community::ownedData(Community::publication($id, false))]);
        });
    }

    public function updates(Request $request): JsonResponse
    {
        $data = $request->validate(['ids' => ['required', 'array', 'max:100'], 'ids.*' => ['required', 'uuid', 'distinct']]);
        $visible = Community::visible()->whereIn('p.id', $data['ids'])->get()->keyBy('id');

        return response()->json(['updates' => array_map(fn ($id) => ['id' => $id, 'available' => isset($visible[$id]), 'revision' => isset($visible[$id]) ? (int) $visible[$id]->revision : null], $data['ids'])]);
    }

    public function rate(Request $request, string $id): JsonResponse
    {
        $data = $request->validate(['stars' => ['required', 'integer', 'between:0,5', function ($attribute, $value, $fail): void {
            if (! is_int($value)) {
                $fail(__('community.integer_rating'));
            }
        }], 'comment' => ['nullable', 'string', 'max:2000']]);

        return Community::mutate($request, function (User $user, object $settings) use ($id, $data): JsonResponse {
            abort_unless($settings->reviews_enabled, 403, __('community.reviews_paused'));
            $publication = Community::publication($id);
            abort_if($publication->user_id === $user->id, 403, __('community.self_rating'));
            $old = DB::table('ratings')->where('publication_id', $id)->where('user_id', $user->id)->first();
            DB::table('ratings')->updateOrInsert(['publication_id' => $id, 'user_id' => $user->id], [
                'id' => $old?->id ?? (string) Str::uuid(), 'stars' => $data['stars'], 'comment' => $data['comment'] ?? null,
                'revision' => $publication->revision, 'created_at' => $old?->created_at ?? now(), 'updated_at' => now(),
                // Editing a moderated review cannot silently restore its hidden comment.
                'comment_hidden' => $old?->comment_hidden ?? false,
            ]);

            return response()->json(['message' => __('community.rating_saved')]);
        });
    }

    public function removeRating(Request $request, string $id): JsonResponse
    {
        return Community::mutate($request, function (User $user) use ($id): JsonResponse {
            DB::table('ratings')->where('publication_id', $id)->where('user_id', $user->id)->delete();

            return response()->json(['message' => __('community.rating_removed')]);
        });
    }

    public function report(Request $request): JsonResponse
    {
        $data = $request->validate(['targetType' => ['required', Rule::in(['publication', 'user', 'rating'])], 'targetId' => ['required', 'uuid'], 'reason' => ['required', Rule::in(['spam', 'abuse', 'copyright', 'other'])], 'details' => ['nullable', 'string', 'max:2000']]);

        return Community::mutate($request, function (User $user) use ($data): JsonResponse {
            abort_if($data['reason'] === 'copyright' && $data['targetType'] !== 'publication', 422);
            if ($data['targetType'] === 'publication') {
                Community::publication($data['targetId']);
            } elseif ($data['targetType'] === 'rating') {
                $rating = DB::table('ratings')->where('id', $data['targetId'])->firstOrFail();
                Community::publication($rating->publication_id);
            } else {
                abort_unless(User::whereKey($data['targetId'])->exists(), 404);
            }
            $query = DB::table('reports')->where('reporter_id', $user->id)->where('target_type', $data['targetType'])->where('target_id', $data['targetId']);
            $existing = $query->first();
            $id = $existing?->id ?? (string) Str::uuid();
            if (! $existing || $existing->status === 'closed') {
                $query->updateOrInsert(['reporter_id' => $user->id, 'target_type' => $data['targetType'], 'target_id' => $data['targetId']], ['id' => $id, 'reason' => $data['reason'], 'details' => $data['details'] ?? null, 'status' => 'open', 'assigned_to' => null, 'decision' => null, 'created_at' => $existing?->created_at ?? now(), 'updated_at' => now()]);
            }

            return response()->json(['message' => __('community.report_received'), 'id' => $id], 202);
        });
    }
}
