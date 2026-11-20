<?php

namespace Tests\Feature;

use App\Models\User;
use App\Services\Score;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

class ScoresTest extends TestCase
{
    use RefreshDatabase;

    private User $owner;

    protected function setUp(): void
    {
        parent::setUp();
        config(['lyricflow.accounts_enabled' => true]);
        $this->owner = User::create(['email' => 'scores@example.test', 'pseudonym' => 'scores', 'password' => 'A private password 123']);
        $this->owner->forceFill(['email_verified_at' => now()])->save();
        $this->actingAs($this->owner)->withSession(['account_version' => 1, 'account_signed_in_at' => time()]);
    }

    private function score(): array
    {
        return json_decode(file_get_contents(base_path('tests/fixtures/score.json')), true);
    }

    private function song(): array
    {
        return ['id' => (string) Str::uuid(), 'formatVersion' => 1, 'title' => 'Instrumental', 'artist' => '', 'lyrics' => '', 'arrangements' => [$this->score()], 'updatedAt' => '2026-10-23T00:00:00Z',
            'settings' => ['bpm' => 120, 'beatsPerBar' => 4, 'barsPerLine' => 1, 'speedMode' => 'bpm', 'presentation' => 'line', 'pixelsPerSecond' => 35, 'countIn' => 0, 'sound' => false, 'fontSize' => 32]];
    }

    private function sync(array $op)
    {
        return $this->postJson('/api/sync', ['accountId' => $this->owner->id, 'cursor' => 0, 'operation' => $op]);
    }

    private function publish(array $content, string $id, int $revision = 0)
    {
        return $this->postJson('/api/community/publish', ['accountId' => $this->owner->id, 'localSongId' => $id, 'expectedRevision' => $revision, 'sharingAccepted' => true, 'content' => $content]);
    }

    private function content(): array
    {
        return ['formatVersion' => 1, 'title' => 'Instrumental', 'artist' => '', 'lyrics' => '', 'music' => ['bpm' => 120, 'beatsPerBar' => 4, 'barsPerLine' => 1], 'arrangements' => [$this->score()]];
    }

    public function test_scores_round_trip_with_incomplete_drafts_and_idempotent_old_retries(): void
    {
        $song = $this->song();
        $old = $song;
        unset($old['arrangements']);
        $first = ['id' => (string) Str::uuid(), 'key' => 'song.'.$song['id'], 'baseRevision' => 0, 'value' => ['song' => $old, 'draft' => null]];
        $this->sync($first)->assertOk();
        $draft = $song;
        $draft['arrangements'][0]['tracks'][0]['staves'][0]['measures'][0]['voices'][0]['events'] = [];
        $next = [...$first, 'id' => (string) Str::uuid(), 'baseRevision' => 1, 'value' => ['song' => $song, 'draft' => $draft]];
        $this->sync($next)->assertOk()->assertJsonPath('records.0.value.draft.arrangements', $draft['arrangements']);
        $this->sync($first)->assertOk()->assertJsonPath('result.revision', 1)->assertJsonPath('records.0.value.song.arrangements', $song['arrangements']);
        $this->sync([...$first, 'id' => (string) Str::uuid(), 'baseRevision' => 2])->assertUnprocessable();
        $this->sync([...$first, 'id' => (string) Str::uuid(), 'baseRevision' => 0])->assertOk()->assertJsonPath('result.status', 'conflict')->assertJsonPath('result.record.value.song.arrangements', $song['arrangements']);
        $empty = [...$song, 'arrangements' => []];
        $this->sync([...$next, 'id' => (string) Str::uuid(), 'baseRevision' => 2, 'value' => ['song' => $empty, 'draft' => null]])->assertOk()->assertJsonPath('result.revision', 3)->assertJsonPath('records.0.value.song.arrangements', []);
    }

    public function test_score_format_migration_is_repeatable_without_mutating_records_hashes_or_revisions(): void
    {
        $song = $this->song();
        $op = ['id' => (string) Str::uuid(), 'key' => 'song.'.$song['id'], 'baseRevision' => 0, 'value' => ['song' => $song, 'draft' => null]];
        $this->sync($op)->assertOk();
        $this->publish($this->content(), $song['id'])->assertOk();
        $before = [DB::table('private_records')->first(), DB::table('private_operations')->first(), DB::table('publication_revisions')->first()];
        $migration = require database_path('migrations/2026_10_23_000001_add_score_arrangements_format.php');
        $migration->up();
        $migration->up();
        $migration->down();
        $this->assertEquals($before, [DB::table('private_records')->first(), DB::table('private_operations')->first(), DB::table('publication_revisions')->first()]);
        $this->sync($op)->assertOk()->assertJsonPath('result.revision', 1);
    }

    public function test_instrumentals_are_publicly_readable_and_old_clients_cannot_erase_scores(): void
    {
        $content = $this->content();
        $id = (string) Str::uuid();
        $publication = $this->publish($content, $id)->assertOk()->json('publication');
        $this->publish($content, $id, 0)->assertOk()->assertJsonPath('publication.revision', 1);
        $old = $content;
        unset($old['arrangements']);
        $old['lyrics'] = 'New lyric from an old app';
        $this->publish($old, $id, 1)->assertUnprocessable();
        $this->assertDatabaseCount('publication_revisions', 1);
        $this->publish([...$old, 'arrangements' => []], $id, 1)->assertOk()->assertJsonPath('publication.revision', 2);
        $this->assertSame($content, json_decode(DB::table('publication_revisions')->where('number', 1)->value('content'), true));
        auth()->logout();
        $this->getJson('/api/publications/'.$publication['id'].'/prompter')->assertOk()->assertJsonPath('publication.content.arrangements', []);
        $this->getJson('/api/community/mine')->assertUnauthorized();
    }

    public function test_invalid_musical_arrangements_cannot_publish_even_alongside_valid_lyrics(): void
    {
        $content = $this->content();
        $content['lyrics'] = 'Valid lyrics';
        $content['arrangements'][0]['tracks'][0]['staves'][0]['measures'][0]['voices'][0]['events'][0]['duration'] = 4;
        $this->publish($content, (string) Str::uuid())->assertUnprocessable();
        $this->assertDatabaseCount('publications', 0);
        $content['arrangements'] = [];
        $content['lyrics'] = '';
        $this->publish($content, (string) Str::uuid())->assertUnprocessable();
    }

    public function test_structural_limits_privacy_and_unsupported_data_are_enforced(): void
    {
        $song = $this->song();
        $op = ['id' => (string) Str::uuid(), 'key' => 'song.'.$song['id'], 'baseRevision' => 0, 'value' => ['song' => $song, 'draft' => null]];
        $bad = $op;
        $bad['value']['song']['arrangements'][0]['remoteSoundUrl'] = 'https://evil.test/sound';
        $this->sync($bad)->assertUnprocessable();
        $bad = $op;
        $bad['value']['song']['arrangements'][0]['name'] = str_repeat('a', 1000001);
        $this->sync($bad)->assertUnprocessable();
        $bad = $op;
        $bad['value']['song']['arrangements'][0]['tracks'][0]['staves'][0]['measures'][0]['voices'][0]['events'][0]['notes'][0]['pitch'] = 200;
        $this->sync($bad)->assertUnprocessable();
        $this->sync($op)->assertOk();
        $other = User::create(['email' => 'other@example.test', 'pseudonym' => 'other', 'password' => 'A private password 123']);
        $this->actingAs($other)->withSession(['account_version' => 1]);
        $this->sync($op)->assertForbidden();
        $this->postJson('/api/sync', ['accountId' => $other->id, 'cursor' => 0])->assertOk()->assertJsonCount(0, 'records');
        $this->getJson('/api/publications/'.$song['id'].'/prompter')->assertNotFound();
    }

    public function test_durations_ties_chords_and_drum_pitches_match_the_browser_contract(): void
    {
        $a = $this->score();
        $this->assertTrue(Score::playable($a));
        $voice = &$a['tracks'][0]['staves'][0]['measures'][0]['voices'][0];
        $e = $voice['events'][0];
        $voice['events'] = [];
        for ($i = 0; $i < 3; $i++) {
            $next = $e;
            $next['id'] = (string) Str::uuid();
            $next['duration'] = 2;
            $next['triplet'] = true;
            $next['notes'][0]['id'] = (string) Str::uuid();
            $next['notes'][0]['tie'] = $i < 2;
            $voice['events'][] = $next;
        }
        $this->assertTrue(Score::playable($a));
        $voice['events'][2]['notes'] = [];
        $this->assertFalse(Score::playable($a));
        $voice['events'] = [$e];
        $voice['events'][0]['notes'][0]['fret'] = 1;
        $this->assertFalse(Score::playable($a));
        $a = $this->score();
        $a['tracks'][4]['staves'][0]['measures'][0]['voices'][0]['events'][0]['notes'][0]['pitch'] = 60;
        $this->assertTrue(Score::structure([$a]));
        $this->assertFalse(Score::playable($a));
    }

    public function test_ties_cannot_cross_an_absent_voice_measure(): void
    {
        $a = $this->score();
        $a['bars'][] = (string) Str::uuid();
        foreach ($a['tracks'] as &$t) {
            foreach ($t['staves'] as &$s) {
                $m = $s['measures'][0];
                $m['id'] = (string) Str::uuid();
                foreach ($m['voices'] as &$v) {
                    $v['id'] = (string) Str::uuid();
                    foreach ($v['events'] as &$e) {
                        $e['id'] = (string) Str::uuid();
                        foreach ($e['notes'] as &$n) {
                            $n['id'] = (string) Str::uuid();
                        }
                    }
                }
                unset($v, $e, $n);
                $s['measures'][] = $m;
            }
        }
        unset($t, $s);
        foreach ([0, 2] as $mi) {
            $voice = $a['tracks'][3]['staves'][0]['measures'][$mi]['voices'][0];
            $voice['id'] = (string) Str::uuid();
            $voice['events'][0]['id'] = (string) Str::uuid();
            $voice['events'][0]['notes'][0]['id'] = (string) Str::uuid();
            $voice['events'][0]['notes'][0]['tie'] = $mi === 0;
            $a['tracks'][3]['staves'][0]['measures'][$mi]['voices'][] = $voice;
        }
        $this->assertTrue(Score::structure([$a]));
        $this->assertFalse(Score::playable($a));
    }
}
