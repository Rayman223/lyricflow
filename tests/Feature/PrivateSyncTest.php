<?php

namespace Tests\Feature;

use App\Models\User;
use App\Services\MusicLinks;
use App\Services\SharedSong;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Tests\TestCase;

class PrivateSyncTest extends TestCase
{
    use RefreshDatabase;

    private User $owner;

    protected function setUp(): void
    {
        parent::setUp();
        config(['lyricflow.accounts_enabled' => true]);
        $this->owner = User::create(['email' => 'owner@example.test', 'pseudonym' => 'owner', 'password' => 'A private password 123']);
        $this->actingAs($this->owner)->withSession(['account_version' => 1, 'account_signed_in_at' => time()]);
    }

    private function operation(?string $key = null, int $base = 0): array
    {
        $key ??= 'song.'.Str::uuid();
        $song = ['id' => substr($key, 5), 'formatVersion' => 1, 'title' => '', 'artist' => '', 'lyrics' => "  Private lyric\n\n[tempo=broken]\n", 'updatedAt' => '2099-01-01T00:00:00.000Z',
            'settings' => ['bpm' => 120, 'beatsPerBar' => 4, 'barsPerLine' => 1, 'speedMode' => 'bpm', 'presentation' => 'line', 'pixelsPerSecond' => 35, 'countIn' => 4, 'sound' => false, 'fontSize' => 32]];

        return ['id' => (string) Str::uuid(), 'key' => $key, 'baseRevision' => $base, 'value' => ['song' => $song, 'draft' => null]];
    }

    private function exchange(?array $op = null, int $cursor = 0, ?string $accountId = null)
    {
        return $this->postJson('/api/sync', ['accountId' => $accountId ?? $this->owner->id, 'cursor' => $cursor, ...($op ? ['operation' => $op] : [])]);
    }

    public function test_music_links_round_trip_with_incomplete_private_drafts(): void
    {
        $op = $this->operation();
        $links = ['youtube' => 'https://youtu.be/dQw4w9WgXcQ', 'youtubeMusic' => 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'deezer' => 'https://deezer.com/track/1', 'spotify' => 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'];
        $op['value']['song']['musicLinks'] = $links;
        $op['value']['draft'] = [...$op['value']['song'], 'musicLinks' => ['youtube' => 'unfinished']];
        $this->exchange($op)->assertOk()->assertJsonPath('records.0.value.song.musicLinks', $links)->assertJsonPath('records.0.value.draft.musicLinks.youtube', 'unfinished');
        $migration = require database_path('migrations/2026_10_21_000001_add_optional_music_links_format.php');
        $before = DB::table('private_records')->value('value');
        $hash = DB::table('private_operations')->value('request_hash');
        $migration->up();
        $migration->up();
        $this->assertSame($before, DB::table('private_records')->value('value'));
        $this->assertSame($hash, DB::table('private_operations')->value('request_hash'));
        $this->exchange($op)->assertOk()->assertJsonPath('result.revision', 1);
        $bad = $this->operation();
        $bad['value']['song']['musicLinks'] = ['youtube' => 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'];
        $this->exchange($bad)->assertUnprocessable();
        $bad['value']['song']['musicLinks'] = ['other' => 'https://example.test'];
        $this->exchange($bad)->assertUnprocessable();
        $this->assertDatabaseCount('private_records', 1);
    }

    public function test_unicode_music_links_accepted_by_the_editor_can_sync_and_publish(): void
    {
        $prefix = 'https://youtu.be/dQw4w9WgXcQ?label=';
        foreach (['é', '🎵'] as $character) {
            $units = $character === 'é' ? 1 : 2;
            $url = $prefix.str_repeat($character, intdiv(2048 - strlen($prefix), $units));
            $op = $this->operation();
            $op['value']['song']['musicLinks'] = ['youtube' => $url];
            $this->exchange($op)->assertOk()->assertJsonPath('result.status', 'applied');
            $this->assertTrue(MusicLinks::valid('youtube', $url));
            $this->assertFalse(MusicLinks::valid('youtube', $url.$character));
            $this->assertSame($url, SharedSong::validate([
                'formatVersion' => 1, 'title' => 'Unicode music link', 'artist' => '', 'lyrics' => 'A lyric',
                'musicLinks' => ['youtube' => $url], 'music' => ['bpm' => 120, 'beatsPerBar' => 4, 'barsPerLine' => 1],
            ])['musicLinks']['youtube']);
        }
    }

    public function test_songs_drafts_and_exact_lyrics_round_trip_without_publication(): void
    {
        $op = $this->operation();
        $op['value']['draft'] = [...$op['value']['song'], 'lyrics' => 'Unfinished'];
        $response = $this->exchange($op)->assertOk()->assertJsonPath('result.status', 'applied')->assertJsonPath('result.revision', 1);
        $this->assertSame($op['value'], $response->json('records.0.value'));
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->exchange(null, 0)->assertOk()->assertJsonPath('records.0.value.draft.lyrics', 'Unfinished');
        $this->exchange(null, 1)->assertOk()->assertJsonCount(0, 'records');
    }

    public function test_retries_are_idempotent_even_after_a_later_change(): void
    {
        $first = $this->operation();
        $this->exchange($first)->assertOk();
        $second = $this->operation($first['key'], 1);
        $second['value']['song']['lyrics'] = 'Newer';
        $this->exchange($second)->assertOk()->assertJsonPath('result.revision', 2);
        $this->exchange($first)->assertOk()->assertJsonPath('result.revision', 1)->assertJsonPath('records.0.value.song.lyrics', 'Newer');
        $this->assertDatabaseCount('private_records', 1);
        $first['value']['song']['lyrics'] = 'Forged retry';
        $this->exchange($first)->assertStatus(409);
    }

    public function test_concurrent_edits_and_deletes_preserve_the_server_version(): void
    {
        $first = $this->operation();
        $this->exchange($first)->assertOk();
        $other = $this->operation($first['key'], 0);
        $this->exchange($other)->assertOk()->assertJsonPath('result.status', 'conflict')->assertJsonPath('result.record.revision', 1);
        $delete = ['id' => (string) Str::uuid(), 'key' => $first['key'], 'baseRevision' => 1, 'value' => null];
        $this->exchange($delete)->assertOk()->assertJsonPath('records.0.value', null);
        $this->exchange($other)->assertOk()->assertJsonPath('result.status', 'conflict')->assertJsonPath('result.record.value', null);
        $other['baseRevision'] = 2;
        $this->exchange($other)->assertOk()->assertJsonPath('result.status', 'conflict');
        $this->assertNull(DB::table('private_records')->value('value'));
    }

    public function test_theme_uses_server_confirmation_order_instead_of_device_time(): void
    {
        foreach (['dark', 'light'] as $theme) {
            $this->exchange(['id' => (string) Str::uuid(), 'key' => 'theme', 'baseRevision' => 0, 'value' => ['theme' => $theme]])->assertOk()->assertJsonPath('result.status', 'applied');
        }
        $this->exchange()->assertOk()->assertJsonPath('records.0.value.theme', 'light')->assertJsonPath('records.0.revision', 2);
    }

    public function test_delta_pagination_and_idempotent_migration_keep_existing_data(): void
    {
        for ($i = 0; $i < 12; $i++) {
            $this->exchange($this->operation())->assertOk();
        }
        $this->exchange()->assertOk()->assertJsonCount(10, 'records')->assertJsonPath('more', true)->assertJsonPath('cursor', 10);
        $this->exchange(null, 10)->assertOk()->assertJsonCount(2, 'records')->assertJsonPath('cursor', 12);
        $migration = require database_path('migrations/2026_10_19_000001_create_private_sync.php');
        $migration->up();
        $migration->up();
        $this->assertDatabaseCount('private_records', 12);
    }

    public function test_another_account_cannot_read_or_mutate_private_records_even_with_same_song_id(): void
    {
        $op = $this->operation();
        $this->exchange($op)->assertOk();
        $other = User::create(['email' => 'other@example.test', 'pseudonym' => 'other', 'password' => 'Another password 123']);
        $this->actingAs($other);
        $this->exchange(null, 0, $this->owner->id)->assertForbidden();
        $this->exchange($op, 0, $this->owner->id)->assertForbidden();
        $this->exchange(null, 0, $other->id)->assertOk()->assertJsonCount(0, 'records');
        $this->exchange($op, 0, $other->id)->assertOk();
        $this->assertDatabaseCount('private_records', 2);
    }

    public function test_invalid_payloads_are_rejected_atomically_and_not_cached(): void
    {
        $op = $this->operation();
        $op['value']['song']['settings']['bpm'] = 0;
        $this->exchange($op)->assertUnprocessable();
        $op = $this->operation();
        $op['value']['song']['lyrics'] = str_repeat('x', 100001);
        $this->exchange($op)->assertUnprocessable();
        $op = $this->operation();
        $op['value']['song']['owner'] = 'someone-else';
        $response = $this->exchange($op)->assertUnprocessable();
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->exchange(null, 100)->assertUnprocessable();
        $this->assertDatabaseCount('private_records', 0);
    }

    public function test_expired_and_banned_sessions_cannot_sync_or_delete(): void
    {
        $this->withSession(['account_version' => 0]);
        $this->exchange($this->operation())->assertUnauthorized();
        $this->actingAs($this->owner)->withSession(['account_version' => 1]);
        $this->owner->forceFill(['banned_at' => now()])->save();
        $this->exchange($this->operation())->assertUnauthorized();
        $this->assertDatabaseCount('private_records', 0);
    }

    public function test_account_deletion_requires_confirmation_and_removes_only_its_private_data(): void
    {
        $this->exchange($this->operation())->assertOk();
        DB::table('password_reset_tokens')->insert(['email' => $this->owner->email, 'token' => 'hashed-token']);
        $data = ['accountId' => $this->owner->id, 'confirmation' => 'owner', 'password' => 'wrong'];
        $this->postJson('/api/account/delete', $data)->assertUnprocessable();
        $data['password'] = 'A private password 123';
        $data['confirmation'] = 'someone-else';
        $this->postJson('/api/account/delete', $data)->assertUnprocessable();
        $data['confirmation'] = 'owner';
        $this->postJson('/api/account/delete', $data)->assertOk()->assertJsonPath('user', null);
        foreach (['users', 'private_records', 'private_operations', 'private_sync_states', 'password_reset_tokens'] as $table) {
            $this->assertDatabaseCount($table, 0);
        }
        $this->getJson('/api/session')->assertOk()->assertJsonPath('user', null);
        $this->exchange()->assertUnauthorized();
    }

    public function test_google_only_deletion_requires_recent_sign_in(): void
    {
        $this->owner->forceFill(['password' => null, 'google_subject' => 'google-identity'])->save();
        $data = ['accountId' => $this->owner->id, 'confirmation' => 'owner'];
        $this->withSession(['account_signed_in_at' => time() - 601])->postJson('/api/account/delete', $data)->assertForbidden();
        $this->withSession(['account_signed_in_at' => time()])->postJson('/api/account/delete', $data)->assertOk();
    }

    public function test_sync_and_delete_require_csrf_outside_test_bypass(): void
    {
        $this->app->instance('env', 'local');
        $this->exchange($this->operation())->assertStatus(419);
        $this->postJson('/api/account/delete', ['accountId' => $this->owner->id, 'confirmation' => 'owner', 'password' => 'A private password 123'])->assertStatus(419);
    }

    public function test_sync_exceptions_do_not_log_private_query_bindings(): void
    {
        $original = $this->app['request'];
        $this->app->instance('request', Request::create('/api/sync', 'POST'));
        $exception = new QueryException('sqlite', 'insert into private_records values (?)', ['Confidential private lyrics'], new \RuntimeException('Database unavailable'));
        Log::shouldReceive('error')->once()->with('Private synchronization failed.', ['type' => $exception::class]);
        try {
            $this->app->make(ExceptionHandler::class)->report($exception);
        } finally {
            $this->app->instance('request', $original);
        }
    }

    public function test_source_provenance_round_trips_privately_and_rejects_unshared_fields(): void
    {
        $op = $this->operation();
        $source = ['publicationId' => (string) Str::uuid(), 'revision' => 2, 'base' => ['formatVersion' => 1, 'title' => 'Original public source', 'artist' => '', 'lyrics' => 'Original lyrics', 'musicLinks' => ['deezer' => 'https://deezer.com/track/1'], 'music' => ['bpm' => 90, 'beatsPerBar' => 3, 'barsPerLine' => 1]]];
        $op['value']['song']['source'] = $source;
        $response = $this->exchange($op)->assertOk();
        $this->assertSame($source, $response->json('records.0.value.song.source'));
        $op['id'] = (string) Str::uuid();
        $op['baseRevision'] = 1;
        $op['value']['song']['source']['base']['music']['fontSize'] = 48;
        $this->exchange($op)->assertUnprocessable();
    }
}
