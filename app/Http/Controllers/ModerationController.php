<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\Community;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class ModerationController extends Controller
{
    public function reports(Request $request): JsonResponse
    {
        Community::staff($request->user());
        $data = $request->validate(['status' => ['sometimes', Rule::in(['open', 'in_progress', 'closed'])], 'page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $page = DB::table('reports')->where('status', $data['status'] ?? 'open')->orderBy('created_at')->orderBy('id')->simplePaginate(20);
        $items = array_map(function ($row): array {
            $target = match ($row->target_type) {
                'publication' => DB::table('publication_revisions as r')->join('publications as p', fn ($join) => $join->on('p.id', '=', 'r.publication_id')->on('p.revision', '=', 'r.number'))->where('p.id', $row->target_id)->value('content'),
                'rating' => DB::table('ratings')->where('id', $row->target_id)->value('comment'),
                'user' => User::whereKey($row->target_id)->value('pseudonym'),
                default => null,
            };

            return [...(array) $row, 'target' => $row->target_type === 'publication' && $target ? json_decode($target, true, flags: JSON_THROW_ON_ERROR) : $target];
        }, $page->items());

        return response()->json(['reports' => $items, 'more' => $page->hasMorePages()]);
    }

    public function review(Request $request, string $id): JsonResponse
    {
        $data = $request->validate(['status' => ['required', Rule::in(['open', 'in_progress', 'closed'])], 'decision' => ['required_if:status,closed', 'nullable', 'string', 'max:2000']]);

        return Community::mutate($request, function (User $user) use ($id, $data): JsonResponse {
            Community::staff($user);
            DB::table('reports')->where('id', $id)->firstOrFail();
            DB::table('reports')->where('id', $id)->update(['status' => $data['status'], 'assigned_to' => $user->id, 'decision' => $data['decision'] ?? null, 'updated_at' => now()]);
            Community::audit($user->id, 'report.'.$data['status'], 'report', $id, $data['decision'] ?? __('community.assigned'));

            return response()->json(['message' => __('community.action_saved')]);
        });
    }

    public function action(Request $request): JsonResponse
    {
        $data = $request->validate(['targetType' => ['required', Rule::in(['publication', 'rating', 'user'])], 'targetId' => ['required', 'uuid'], 'action' => ['required', Rule::in(['hide', 'restore', 'ban', 'unban'])], 'reason' => ['required', 'string', 'max:500']]);

        return Community::mutate($request, function (User $user) use ($data): JsonResponse {
            Community::staff($user);
            $id = $data['targetId'];
            if ($data['targetType'] === 'user') {
                abort_unless(in_array($data['action'], ['ban', 'unban']), 422);
                $target = User::whereKey($id)->lockForUpdate()->firstOrFail();
                abort_if($target->id === $user->id, 409, __('community.self_action'));
                abort_if($user->role !== 'admin' && $target->role === 'admin', 403);
                if ($data['action'] === 'ban') {
                    Community::protectLastAdmin($target);
                }
                DB::table('publications')->where('user_id', $id)->increment('sharing_version');
                $target->forceFill(['banned_at' => $data['action'] === 'ban' ? now() : null, 'session_version' => $target->session_version + 1, 'remember_token' => Str::random(60)])->save();
            } else {
                abort_unless(in_array($data['action'], ['hide', 'restore']), 422);
                $table = $data['targetType'] === 'publication' ? 'publications' : 'ratings';
                DB::table($table)->where('id', $id)->firstOrFail();
                DB::table($table)->where('id', $id)->update([$table === 'publications' ? 'moderation_hidden' : 'comment_hidden' => $data['action'] === 'hide', ...($table === 'publications' ? ['sharing_version' => DB::raw('sharing_version + 1')] : [])]);
            }
            Community::audit($user->id, $data['action'], $data['targetType'], $id, $data['reason']);

            return response()->json(['message' => __('community.action_saved')]);
        });
    }

    public function events(Request $request): JsonResponse
    {
        Community::staff($request->user());
        $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $page = DB::table('moderation_events as e')->leftJoin('users as u', 'u.id', '=', 'e.actor_id')->select('e.*', 'u.pseudonym')->orderByDesc('e.id')->simplePaginate(30);

        $items = array_map(fn ($row) => [...(array) $row, 'created_at' => Carbon::parse($row->created_at, 'UTC')->toISOString()], $page->items());

        return response()->json(['events' => $items, 'more' => $page->hasMorePages()]);
    }

    public function users(Request $request): JsonResponse
    {
        Community::staff($request->user(), true);
        $data = $request->validate(['q' => ['nullable', 'string', 'max:200'], 'page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $query = User::query()->select(['id', 'pseudonym', 'email', 'email_verified_at', 'role', 'banned_at']);
        $term = $data['q'] ?? '';
        if ($term !== '') {
            $query->where(fn ($q) => $q->whereRaw('INSTR(pseudonym, ?) > 0', [$term])->orWhereRaw('INSTR(email, ?) > 0', [$term]));
        }
        $page = $query->orderBy('pseudonym')->simplePaginate(30);

        return response()->json(['users' => $page->items(), 'more' => $page->hasMorePages()]);
    }

    public function role(Request $request, string $id): JsonResponse
    {
        $data = $request->validate(['role' => ['required', Rule::in(['member', 'moderator', 'admin'])], 'reason' => ['required', 'string', 'max:500']]);

        return Community::mutate($request, function (User $user) use ($id, $data): JsonResponse {
            Community::staff($user, true);
            $target = User::whereKey($id)->lockForUpdate()->firstOrFail();
            if ($data['role'] !== 'admin') {
                Community::protectLastAdmin($target);
            }
            $target->forceFill(['role' => $data['role']])->save();
            Community::audit($user->id, 'role.'.$data['role'], 'user', $id, $data['reason']);

            return response()->json(['message' => __('community.action_saved')]);
        });
    }

    public function settings(Request $request): JsonResponse
    {
        Community::staff($request->user(), true);
        $settings = DB::table('community_settings')->where('id', 1)->firstOrFail();

        return response()->json(['settings' => [
            'id' => (int) $settings->id,
            'publishing_enabled' => (bool) $settings->publishing_enabled,
            'reviews_enabled' => (bool) $settings->reviews_enabled,
        ]]);
    }

    public function saveSettings(Request $request): JsonResponse
    {
        $data = $request->validate(['publishingEnabled' => ['required', 'boolean'], 'reviewsEnabled' => ['required', 'boolean'], 'reason' => ['required', 'string', 'max:500']]);

        return Community::mutate($request, function (User $user) use ($data): JsonResponse {
            Community::staff($user, true);
            DB::table('community_settings')->where('id', 1)->update(['publishing_enabled' => $data['publishingEnabled'], 'reviews_enabled' => $data['reviewsEnabled']]);
            Community::audit($user->id, 'settings', 'settings', '1', $data['reason']);

            return response()->json(['message' => __('community.action_saved')]);
        });
    }

    public function catalog(Request $request): JsonResponse
    {
        Community::staff($request->user(), true);
        $data = $request->validate(['q' => ['nullable', 'string', 'max:200'], 'page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $query = DB::table('catalog_songs');
        $term = Community::normalize($data['q'] ?? '');
        if ($term !== '') {
            $query->where(fn ($q) => $q->whereRaw('INSTR(search_title, ?) > 0', [$term])->orWhereRaw('INSTR(search_artist, ?) > 0', [$term]));
        }
        $page = $query->orderBy('title')->orderBy('id')->simplePaginate(30);

        return response()->json(['songs' => $page->items(), 'more' => $page->hasMorePages()]);
    }

    public function editCatalog(Request $request, string $id): JsonResponse
    {
        $data = $request->validate(['title' => ['required', 'string', 'max:200'], 'artist' => ['present', 'string', 'max:200'], 'reason' => ['required', 'string', 'max:500']]);

        return Community::mutate($request, function (User $user) use ($id, $data): JsonResponse {
            Community::staff($user, true);
            DB::table('catalog_songs')->where('id', $id)->firstOrFail();
            $identity = Community::identity($data['title'], $data['artist']);
            abort_if(DB::table('catalog_songs')->where('identity_hash', $identity['identity_hash'])->where('id', '!=', $id)->exists(), 409, __('community.merge_required'));
            DB::table('catalog_songs')->where('id', $id)->update(['title' => trim($data['title']), 'artist' => trim($data['artist']), ...$identity, 'updated_at' => now()]);
            Community::audit($user->id, 'catalog.edit', 'catalog', $id, $data['reason']);

            return response()->json(['message' => __('community.action_saved')]);
        });
    }

    public function mergeCatalog(Request $request, string $id): JsonResponse
    {
        $data = $request->validate(['targetId' => ['required', 'uuid', Rule::notIn([$id])], 'reason' => ['required', 'string', 'max:500']]);

        return Community::mutate($request, function (User $user) use ($id, $data): JsonResponse {
            Community::staff($user, true);
            foreach ([$id, $data['targetId']] as $target) {
                DB::table('catalog_songs')->where('id', $target)->firstOrFail();
            }
            DB::table('publications')->where('catalog_song_id', $id)->update(['catalog_song_id' => $data['targetId']]);
            DB::table('catalog_songs')->where('id', $id)->delete();
            Community::audit($user->id, 'catalog.merge', 'catalog', $id, $data['reason'].' → '.$data['targetId']);

            return response()->json(['message' => __('community.action_saved')]);
        });
    }
}
