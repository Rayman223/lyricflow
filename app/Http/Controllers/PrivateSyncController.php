<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\MusicLinks;
use App\Services\SharedSong;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;

class PrivateSyncController extends Controller
{
    public function exchange(Request $request): JsonResponse
    {
        $data = $request->validate([
            'accountId' => ['required', 'uuid'],
            'cursor' => ['required', 'integer', 'min:0', 'max:9007199254740991'],
            'operation' => ['sometimes', 'array:id,key,baseRevision,value'],
            'operation.id' => ['required_with:operation', 'uuid'],
            'operation.key' => ['required_with:operation', 'string', 'max:64', 'regex:/^(theme|song\.[a-f0-9-]{36})$/D'],
            'operation.baseRevision' => ['required_with:operation', 'integer', 'min:0', 'max:9007199254740991'],
            'operation.value' => ['present_with:operation', 'nullable', 'array'],
        ]);
        abort_unless($data['accountId'] === $request->user()->id, 403);
        $op = $data['operation'] ?? null;
        if ($op) {
            $this->validateValue($op);
        }

        return DB::transaction(function () use ($request, $data, $op): JsonResponse {
            // One account lock orders every write, including concurrent devices and deletion.
            $user = User::whereKey($data['accountId'])->lockForUpdate()->first();
            abort_unless($user && ! $user->banned_at && $user->session_version === $request->session()->get('account_version'), 401);
            DB::table('private_sync_states')->insertOrIgnore(['user_id' => $user->id, 'revision' => 0]);
            $revision = (int) DB::table('private_sync_states')->where('user_id', $user->id)->value('revision');
            abort_if($data['cursor'] > $revision, 422);
            $result = null;
            if ($op) {
                $hash = hash('sha256', json_encode($op, JSON_THROW_ON_ERROR));
                $receipt = DB::table('private_operations')->where('user_id', $user->id)->where('operation_id', $op['id'])->first();
                $query = DB::table('private_records')->where('user_id', $user->id)->where('record_key', $op['key']);
                $current = $query->first();
                if ($receipt) {
                    abort_unless(hash_equals($receipt->request_hash, $hash), 409);
                    $result = ['status' => 'applied', 'revision' => (int) $receipt->revision];
                } elseif ($op['key'] !== 'theme' && (($current ? (int) $current->revision : 0) !== (int) $op['baseRevision'] || ($current && $current->value === null && $op['value'] !== null))) {
                    $result = ['status' => 'conflict', 'record' => $current ? $this->record($current) : ['key' => $op['key'], 'revision' => 0, 'value' => null]];
                } else {
                    $revision++;
                    $query->updateOrInsert(['user_id' => $user->id, 'record_key' => $op['key']], [
                        'revision' => $revision,
                        'value' => $op['value'] === null ? null : json_encode($op['value'], JSON_THROW_ON_ERROR),
                    ]);
                    DB::table('private_sync_states')->where('user_id', $user->id)->update(['revision' => $revision]);
                    DB::table('private_operations')->insert(['user_id' => $user->id, 'operation_id' => $op['id'], 'request_hash' => $hash, 'revision' => $revision]);
                    $result = ['status' => 'applied', 'revision' => $revision];
                }
            }
            // Bound response size even for a library of very large songs.
            $rows = DB::table('private_records')->where('user_id', $user->id)->where('revision', '>', $data['cursor'])->orderBy('revision')->limit(10)->get();

            return response()->json([
                'accountId' => $user->id, 'result' => $result,
                'records' => $rows->map(fn ($row) => $this->record($row))->all(),
                'cursor' => $rows->isEmpty() ? (int) $data['cursor'] : (int) $rows->last()->revision,
                'more' => $rows->count() === 10,
            ]);
        }, 3);
    }

    private function record(object $row): array
    {
        return ['key' => $row->record_key, 'revision' => (int) $row->revision, 'value' => $row->value === null ? null : json_decode($row->value, true, flags: JSON_THROW_ON_ERROR)];
    }

    private function validateValue(array $op): void
    {
        if ($op['key'] === 'theme') {
            Validator::make(['value' => $op['value']], ['value' => ['required', 'array:theme'], 'value.theme' => ['required', Rule::in(['light', 'dark'])]])->validate();

            return;
        }
        Validator::make(['id' => substr($op['key'], 5)], ['id' => ['required', 'uuid']])->validate();
        if ($op['value'] === null) {
            return;
        }
        $rules = ['value' => ['required', 'array:song,draft'], 'value.song' => ['present', 'nullable', 'array'], 'value.draft' => ['present', 'nullable', 'array']];
        foreach (['song', 'draft'] as $kind) {
            if (($op['value'][$kind] ?? null) === null) {
                continue;
            }
            $prefix = "value.$kind";
            $rules[$prefix] = ['required', 'array:id,formatVersion,title,artist,lyrics,settings,updatedAt,source,musicLinks'];
            $rules = [...$rules, ...MusicLinks::rules("$prefix.musicLinks", $kind === 'draft')];
            $rules["$prefix.source"] = ['sometimes', 'nullable', 'array:publicationId,revision,base'];
            if (isset($op['value'][$kind]['source'])) {
                $rules["$prefix.source.publicationId"] = ['required', 'uuid'];
                $rules["$prefix.source.revision"] = ['required', 'integer', 'min:1'];
                $rules = [...$rules, ...SharedSong::rules("$prefix.source.base")];
            }
            $rules["$prefix.id"] = ['required', Rule::in([substr($op['key'], 5)])];
            $rules["$prefix.formatVersion"] = ['required', 'integer', Rule::in([1])];
            foreach (['title' => 200, 'artist' => 200, 'lyrics' => 100000] as $field => $max) {
                $rules["$prefix.$field"] = ['present', 'string', "max:$max"];
            }
            $rules["$prefix.updatedAt"] = ['required', 'string', 'max:40', 'date'];
            $rules["$prefix.settings"] = ['required', 'array:bpm,beatsPerBar,barsPerLine,speedMode,presentation,pixelsPerSecond,countIn,sound,fontSize'];
            foreach (['bpm' => [1, 1000], 'beatsPerBar' => [1, 32], 'barsPerLine' => [0.01, 1000], 'pixelsPerSecond' => [1, 1000], 'countIn' => [0, 32], 'fontSize' => [18, 80]] as $field => [$min, $max]) {
                $rules["$prefix.settings.$field"] = ['required', in_array($field, ['beatsPerBar', 'countIn']) ? 'integer' : 'numeric', "min:$min", "max:$max", function ($attribute, $value, $fail): void {
                    if (! is_int($value) && ! is_float($value)) {
                        $fail('Use a number.');
                    }
                }];
            }
            $rules["$prefix.settings.speedMode"] = ['required', Rule::in(['bpm', 'pixels'])];
            $rules["$prefix.settings.presentation"] = ['required', Rule::in(['line', 'continuous'])];
            $rules["$prefix.settings.sound"] = ['required', 'boolean', function ($attribute, $value, $fail): void {
                if (! is_bool($value)) {
                    $fail('Use a boolean.');
                }
            }];
        }
        Validator::make(['value' => $op['value']], $rules)->validate();
        abort_if($op['value']['song'] === null && $op['value']['draft'] === null, 422);
    }
}
