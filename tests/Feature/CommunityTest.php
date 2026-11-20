<?php

namespace Tests\Feature;

use App\Models\User;
use App\Services\MusicLinks;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

class CommunityTest extends TestCase
{
    use RefreshDatabase;

    private User $owner;

    protected function setUp(): void
    {
        parent::setUp();
        config(['lyricflow.accounts_enabled' => true]);
        $this->owner = $this->user('owner');
        $this->signIn($this->owner);
    }

    private function user(string $name, string $role = 'member'): User
    {
        $user = User::create(['email' => "$name@example.test", 'pseudonym' => $name, 'password' => 'A private password 123']);
        $user->forceFill(['role' => $role, 'email_verified_at' => now()])->save();

        return $user;
    }

    private function signIn(User $user): void
    {
        $this->actingAs($user)->withSession(['account_version' => $user->session_version, 'account_signed_in_at' => time()]);
    }

    private function content(string $title = 'Élan', string $lyrics = "  First lyric\n[tempo=80%]\n[line bars=1.5] Second lyric\n[/tempo]\n"): array
    {
        return ['formatVersion' => 1, 'title' => $title, 'artist' => 'A Band', 'lyrics' => $lyrics, 'music' => ['bpm' => 120, 'beatsPerBar' => 4, 'barsPerLine' => 1]];
    }

    private function publish(?array $content = null, ?string $songId = null, int $revision = 0): array
    {
        return $this->postJson('/api/community/publish', ['accountId' => auth()->id(), 'localSongId' => $songId ?? (string) Str::uuid(), 'expectedRevision' => $revision, 'sharingAccepted' => true, 'content' => $content ?? $this->content()])->assertOk()->json('publication');
    }

    private function mutation(string $path, array $data = [])
    {
        if (str_ends_with($path, '/auto-share') && ! isset($data['operationId'])) {
            $data['operationId'] = (string) Str::uuid();
        }

        return $this->postJson($path, ['accountId' => auth()->id(), ...$data]);
    }

    public function test_music_links_are_validated_published_and_removed_in_a_new_revision(): void
    {
        foreach (json_decode(file_get_contents(base_path('tests/fixtures/music-links.json')), true) as $case) {
            $this->assertSame($case['valid'], MusicLinks::valid($case['service'], $case['url']), $case['url']);
        }
        $content = [...$this->content(), 'musicLinks' => ['youtube' => 'https://youtu.be/dQw4w9WgXcQ']];
        $songId = (string) Str::uuid();
        $publication = $this->publish($content, $songId);
        $this->getJson("/api/publications/{$publication['id']}/prompter")->assertOk()->assertJsonPath('publication.content.musicLinks', $content['musicLinks']);
        $this->mutation('/api/community/publish', ['localSongId' => $songId, 'expectedRevision' => 1, 'sharingAccepted' => true, 'content' => [...$content, 'musicLinks' => ['youtube' => 'javascript:alert(1)']]])->assertUnprocessable();
        $this->assertDatabaseCount('publication_revisions', 1);
        $migration = require database_path('migrations/2026_10_21_000001_add_optional_music_links_format.php');
        $before = DB::table('publication_revisions')->value('content');
        $migration->up();
        $migration->up();
        $this->assertSame($before, DB::table('publication_revisions')->value('content'));
        $this->publish($this->content(), $songId, 1);
        auth()->logout();
        $this->getJson("/api/publications/{$publication['id']}/prompter")->assertOk()->assertJsonPath('publication.revision', 2)->assertJsonMissingPath('publication.content.musicLinks');
    }

    public function test_beat_timing_and_line_passages_survive_publication(): void
    {
        $content = $this->content(lyrics: "[line tempo=80% beats=6]\nFirst\n[line bars=2] Second\n[/line]\nLast");
        $publication = $this->publish($content);
        $invalid = [...$content, 'lyrics' => '[line beats=6 bars=2] Invalid'];
        $this->mutation('/api/community/publish', ['localSongId' => $publication['localSongId'], 'expectedRevision' => 1, 'sharingAccepted' => true, 'content' => $invalid])->assertUnprocessable();
        $this->assertDatabaseCount('publication_revisions', 1);
        auth()->logout();
        $this->getJson("/api/publications/{$publication['id']}/prompter")->assertStatus(409)->assertJsonMissingPath('publication');
        $this->getJson("/api/publications/{$publication['id']}/prompter", ['X-LyricFlow-Capabilities' => 'line-timing'])->assertOk()->assertJsonPath('publication.content', $content);
    }

    public function test_prompter_negotiates_line_timing_without_blocking_legacy_songs(): void
    {
        $sources = [
            [true, '[line beats=6] Inline'],
            [true, '[line tempo=80% beats=.5] Inline'],
            [true, '[line beats=6 tempo=90] Inline'],
            [true, "[line beats=6]\nFirst\nSecond\n[/line]"],
            [true, "  [line bars=2]\r\nFirst\r[/line]"],
            [true, "[line tempo=80%]\nFirst\n[/line]"],
            [false, "[tempo=80%]\n[line tempo=90 bars=2] First\n[pause beats=6]\n[/tempo]"],
            [false, "\\[line beats=6]\n\\[line bars=2]\n\\[/line]"],
            [false, '[line bars=2] The words beats=6 are lyrics'],
            [false, 'Text [line beats=6] stays literal'],
            [false, "[section=line beats=6]\nFirst"],
        ];
        $publications = [];
        foreach ($sources as [$required, $lyrics]) {
            $publications[] = [$required, $this->publish($this->content(lyrics: $lyrics))];
        }
        auth()->logout();
        foreach ($publications as [$required, $publication]) {
            $path = "/api/publications/{$publication['id']}/prompter";
            foreach ([[], ['X-LyricFlow-Capabilities' => 'unrelated'], ['X-LyricFlow-Capabilities' => 'line-timing-v2']] as $headers) {
                $response = $this->getJson($path, $headers);
                if ($required) {
                    $response->assertStatus(409)->assertJsonPath('error', 'client_update_required')->assertJsonMissingPath('publication');
                    $this->assertStringNotContainsString($publication['content']['lyrics'], $response->getContent());
                } else {
                    $response->assertOk()->assertJsonPath('publication.content', $publication['content']);
                }
                $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
            }
            $this->getJson($path, ['X-LyricFlow-Capabilities' => 'other, line-timing '])->assertOk()->assertJsonPath('publication.content', $publication['content']);
        }
    }

    public function test_prompter_rechecks_capability_after_each_public_revision(): void
    {
        $publication = $this->publish();
        $path = "/api/publications/{$publication['id']}/prompter";
        $this->getJson($path)->assertOk();
        $this->publish($this->content(lyrics: "[line beats=6]\nFirst\nSecond\n[/line]"), $publication['localSongId'], 1);
        $this->getJson($path)->assertStatus(409)->assertJsonMissingPath('publication');
        $this->getJson($path, ['X-LyricFlow-Capabilities' => 'line-timing'])->assertOk()->assertJsonPath('publication.revision', 2);
        $this->publish($this->content(), $publication['localSongId'], 2);
        $this->getJson($path)->assertOk()->assertJsonPath('publication.revision', 3);
    }

    public function test_anonymous_prompter_returns_only_public_music_and_the_latest_revision(): void
    {
        $songId = (string) Str::uuid();
        $publication = $this->publish(songId: $songId);
        $this->publish($this->content(lyrics: 'Latest public lyrics'), $songId, 1);
        auth()->logout();
        $response = $this->getJson("/api/publications/{$publication['id']}/prompter")->assertOk();
        $response->assertExactJson(['publication' => [
            'id' => $publication['id'], 'revision' => 2, 'author' => 'owner',
            'content' => $this->content(lyrics: 'Latest public lyrics'),
        ]]);
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->getJson('/api/community/catalog')->assertUnauthorized();
        $this->getJson('/api/community/mine')->assertUnauthorized();
        $this->getJson("/api/publications/{$songId}/prompter")->assertNotFound();
    }

    public function test_anonymous_prompter_obeys_public_visibility_and_configuration(): void
    {
        $publication = $this->publish($this->content(lyrics: '[line beats=6] First'));
        $path = "/api/publications/{$publication['id']}/prompter";
        $this->withHeader('X-LyricFlow-Capabilities', 'line-timing');
        auth()->logout();
        foreach ([['published', false], ['moderation_hidden', true]] as [$column, $value]) {
            DB::table('publications')->where('id', $publication['id'])->update([$column => $value]);
            $response = $this->getJson($path)->assertNotFound();
            $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
            DB::table('publications')->where('id', $publication['id'])->update([$column => ! $value]);
        }
        $this->owner->forceFill(['banned_at' => now()])->save();
        $this->getJson($path)->assertNotFound();
        $this->owner->forceFill(['banned_at' => null])->save();
        DB::table('publications')->where('id', $publication['id'])->update(['user_id' => null]);
        $this->getJson($path)->assertOk()->assertJsonPath('publication.author', 'Anonymous');
        $this->getJson('/api/publications/not-a-uuid/prompter')->assertNotFound();
        $this->getJson('/api/publications/'.Str::uuid().'/prompter')->assertNotFound();
        config(['lyricflow.accounts_enabled' => false]);
        $this->getJson($path)->assertStatus(503);
    }

    public function test_publication_is_explicit_grouped_searchable_and_excludes_personal_settings(): void
    {
        $this->getJson('/api/community/catalog')->assertOk()->assertJsonCount(0, 'songs');
        $content = $this->content();
        $publication = $this->publish($content);
        $this->assertSame($content, $publication['content']);
        $this->assertArrayNotHasKey('email', $publication);
        $this->publish($this->content('  ELAN '));
        $this->assertDatabaseCount('catalog_songs', 1);
        $this->getJson('/api/community/catalog?q=élan')->assertOk()->assertJsonCount(1, 'songs')->assertJsonPath('songs.0.version_count', 2);
        $this->getJson('/api/community/catalog?q=%25')->assertOk()->assertJsonCount(0, 'songs');
        $content['fontSize'] = 70;
        $this->mutation('/api/community/publish', ['localSongId' => (string) Str::uuid(), 'expectedRevision' => 0, 'sharingAccepted' => true, 'content' => $content])->assertUnprocessable();
    }

    public function test_community_timestamps_identify_utc_for_local_display(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-01-02T23:04:05Z'));
        $expected = '2026-01-02T23:04:05.000000Z';
        $publication = $this->publish();
        $this->assertSame($expected, $publication['updatedAt']);
        $this->getJson("/api/community/catalog/{$publication['catalogId']}")
            ->assertOk()->assertJsonPath('publications.0.updatedAt', $expected);

        $this->signIn($this->user('reader'));
        $this->mutation("/api/community/publications/{$publication['id']}/rating", ['stars' => 4])->assertOk();
        $this->getJson("/api/community/publications/{$publication['id']}")
            ->assertOk()->assertJsonPath('publication.updatedAt', $expected)
            ->assertJsonPath('ratings.0.updatedAt', $expected);

        $this->signIn($this->user('moderator', 'moderator'));
        $this->mutation('/api/moderation/actions', ['targetType' => 'publication', 'targetId' => $publication['id'], 'action' => 'hide', 'reason' => 'Timestamp test'])->assertOk();
        $this->getJson('/api/moderation/events')->assertOk()->assertJsonPath('events.0.created_at', $expected);
    }

    public function test_public_revisions_increment_only_for_effective_explicit_updates_and_retries_are_safe(): void
    {
        $songId = (string) Str::uuid();
        $first = $this->publish(songId: $songId);
        $same = $this->publish(songId: $songId);
        $this->assertSame($first['id'], $same['id']);
        $this->assertSame(1, $same['revision']);
        $content = $this->content(lyrics: 'New public lyrics');
        $next = $this->publish($content, $songId, 1);
        $this->assertSame(2, $next['revision']);
        $this->assertSame(2, $this->publish($content, $songId, 1)['revision']);
        $this->mutation('/api/community/publish', ['localSongId' => $songId, 'expectedRevision' => 1, 'sharingAccepted' => true, 'content' => $this->content(lyrics: 'Stale different lyrics')])->assertStatus(409);
        $this->assertDatabaseCount('publication_revisions', 2);
    }

    public function test_unpublish_keeps_revisions_and_reviews_and_republishing_restores_them(): void
    {
        $songId = (string) Str::uuid();
        $pub = $this->publish(songId: $songId);
        $reader = $this->user('reader');
        $this->signIn($reader);
        $this->mutation("/api/community/publications/{$pub['id']}/rating", ['stars' => 4])->assertOk();
        $this->mutation("/api/community/publications/{$pub['id']}/unpublish", ['expectedRevision' => 1])->assertNotFound();
        $this->signIn($this->owner);
        $this->mutation("/api/community/publications/{$pub['id']}/unpublish", ['expectedRevision' => 1])->assertOk();
        $this->getJson("/api/community/publications/{$pub['id']}")->assertNotFound();
        $this->getJson('/api/community/catalog')->assertJsonCount(0, 'songs');
        $this->getJson('/api/community/mine')->assertJsonPath('publications.0.published', false);
        $restored = $this->publish(songId: $songId, revision: 1);
        $this->assertSame(1, $restored['revision']);
        $this->assertSame(4.0, (float) $restored['average']);
        $this->assertDatabaseCount('ratings', 1);
    }

    public function test_attribution_and_source_update_metadata_survive_source_withdrawal(): void
    {
        $source = $this->publish();
        $other = $this->user('adapter');
        $this->signIn($other);
        $adaptation = $this->mutation('/api/community/publish', ['localSongId' => (string) Str::uuid(), 'expectedRevision' => 0, 'sharingAccepted' => true, 'content' => $this->content(lyrics: 'Adapted lyrics'), 'source' => ['publicationId' => $source['id'], 'revision' => 1]])->assertOk()->json('publication');
        $this->assertSame($source['id'], $adaptation['source']['publicationId']);
        $this->mutation('/api/community/updates', ['ids' => [$source['id']]])->assertOk()->assertJsonPath('updates.0.available', true);
        $this->signIn($this->owner);
        $this->mutation("/api/community/publications/{$source['id']}/unpublish", ['expectedRevision' => 1])->assertOk();
        $this->signIn($other);
        $this->mutation('/api/community/updates', ['ids' => [$source['id']]])->assertOk()->assertJsonPath('updates.0.available', false);
        $this->getJson("/api/community/publications/{$adaptation['id']}")->assertOk()->assertJsonPath('publication.source.publicationId', $source['id']);
    }

    public function test_ratings_accept_zero_reject_fractions_and_self_ratings_and_update_in_place(): void
    {
        $pub = $this->publish();
        $path = "/api/community/publications/{$pub['id']}/rating";
        $this->mutation($path, ['stars' => 5])->assertForbidden();
        $reader = $this->user('reader');
        $this->signIn($reader);
        foreach ([null, -1, 6, 1.5, '3'] as $stars) {
            $this->mutation($path, ['stars' => $stars])->assertUnprocessable();
        }
        $this->mutation($path, ['stars' => 0, 'comment' => '<script>plain text</script>'])->assertOk();
        $this->getJson("/api/community/publications/{$pub['id']}")->assertOk()->assertJsonPath('publication.average', 0)->assertJsonPath('publication.ratingCount', 1)->assertJsonPath('ratings.0.comment', '<script>plain text</script>');
        $this->mutation($path, ['stars' => 5, 'comment' => 'Edited'])->assertOk();
        $this->assertDatabaseCount('ratings', 1);
        $this->mutation($path.'/remove')->assertOk();
        $this->getJson("/api/community/publications/{$pub['id']}")->assertJsonPath('publication.average', null)->assertJsonPath('publication.ratingCount', 0);
    }

    public function test_ranking_uses_average_then_review_count_then_unrated_versions(): void
    {
        $a = $this->publish();
        $b = $this->publish();
        $zero = $this->publish();
        $unrated = $this->publish();
        $this->signIn($this->user('first'));
        foreach ([[$a, 5], [$b, 5], [$zero, 0]] as [$publication, $stars]) {
            $this->mutation("/api/community/publications/{$publication['id']}/rating", ['stars' => $stars])->assertOk();
        }
        $this->signIn($this->user('second'));
        $this->mutation("/api/community/publications/{$b['id']}/rating", ['stars' => 5])->assertOk();
        $ids = $this->getJson("/api/community/catalog/{$a['catalogId']}")->assertOk()->json('publications');
        $this->assertSame([$b['id'], $a['id'], $zero['id'], $unrated['id']], array_column($ids, 'id'));
        $this->getJson('/api/community/catalog?sort=stars')->assertOk()->assertJsonCount(1, 'songs');
    }

    public function test_reports_are_deduplicated_and_have_a_moderated_lifecycle(): void
    {
        $pub = $this->publish();
        $this->signIn($this->user('reporter'));
        $data = ['targetType' => 'publication', 'targetId' => $pub['id'], 'reason' => 'copyright', 'details' => 'Please review rights'];
        $id = $this->mutation('/api/community/reports', $data)->assertStatus(202)->json('id');
        $this->mutation('/api/community/reports', $data)->assertStatus(202)->assertJsonPath('id', $id);
        $this->assertDatabaseCount('reports', 1);
        $this->getJson('/api/moderation/reports')->assertForbidden();
        $this->signIn($this->user('moderator', 'moderator'));
        $this->getJson('/api/moderation/reports')->assertOk()->assertJsonPath('reports.0.target.lyrics', $pub['content']['lyrics']);
        $this->mutation("/api/moderation/reports/$id", ['status' => 'in_progress'])->assertOk();
        $this->mutation("/api/moderation/reports/$id", ['status' => 'closed'])->assertUnprocessable();
        $this->mutation("/api/moderation/reports/$id", ['status' => 'closed', 'decision' => 'Reviewed and withdrawn'])->assertOk();
        $this->getJson('/api/moderation/reports?status=closed')->assertJsonCount(1, 'reports');
        $this->assertDatabaseCount('moderation_events', 2);
    }

    public function test_ban_hides_every_public_route_and_unban_preserves_individual_moderation(): void
    {
        $visible = $this->publish();
        $hidden = $this->publish();
        $moderator = $this->user('moderator', 'moderator');
        $this->signIn($moderator);
        $this->mutation('/api/moderation/actions', ['targetType' => 'publication', 'targetId' => $hidden['id'], 'action' => 'hide', 'reason' => 'Specific content issue'])->assertOk();
        $this->mutation('/api/moderation/actions', ['targetType' => 'user', 'targetId' => $this->owner->id, 'action' => 'ban', 'reason' => 'Account abuse'])->assertOk();
        foreach ([$visible, $hidden] as $pub) {
            $this->getJson("/api/community/publications/{$pub['id']}")->assertNotFound();
        }
        $this->getJson('/api/community/catalog')->assertJsonCount(0, 'songs');
        $this->mutation('/api/community/updates', ['ids' => [$visible['id']]])->assertJsonPath('updates.0.available', false);
        $this->mutation('/api/moderation/actions', ['targetType' => 'user', 'targetId' => $this->owner->id, 'action' => 'unban', 'reason' => 'Appeal accepted'])->assertOk();
        $this->getJson("/api/community/publications/{$visible['id']}")->assertOk();
        $this->getJson("/api/community/publications/{$hidden['id']}")->assertNotFound();
        $this->signIn($this->owner->fresh());
        $this->withSession(['account_version' => 1]); // An old session version must still be refused.
        $this->getJson('/api/community/catalog')->assertUnauthorized();
    }

    public function test_hidden_comments_keep_stars_and_cannot_be_restored_by_editing(): void
    {
        $pub = $this->publish();
        $reader = $this->user('reader');
        $this->signIn($reader);
        $this->mutation("/api/community/publications/{$pub['id']}/rating", ['stars' => 3, 'comment' => 'Moderated comment'])->assertOk();
        $rating = DB::table('ratings')->first();
        $this->signIn($this->user('mod', 'moderator'));
        $this->mutation('/api/moderation/actions', ['targetType' => 'rating', 'targetId' => $rating->id, 'action' => 'hide', 'reason' => 'Abuse'])->assertOk();
        $this->signIn($reader);
        $this->mutation("/api/community/publications/{$pub['id']}/rating", ['stars' => 4, 'comment' => 'Replacement'])->assertOk();
        $this->getJson("/api/community/publications/{$pub['id']}")->assertJsonPath('ratings.0.comment', null)->assertJsonPath('publication.average', 4);
    }

    public function test_permissions_and_last_administrator_protection_apply_to_roles_and_deletion(): void
    {
        $admin = $this->user('admin', 'admin');
        $mod = $this->user('mod', 'moderator');
        $this->getJson('/api/admin/users')->assertForbidden();
        $this->mutation("/api/admin/users/{$this->owner->id}/role", ['role' => 'admin', 'reason' => 'Escalation attempt'])->assertForbidden();
        $this->signIn($mod);
        $this->getJson('/api/admin/settings')->assertForbidden();
        $this->mutation('/api/moderation/actions', ['targetType' => 'user', 'targetId' => $admin->id, 'action' => 'ban', 'reason' => 'Forbidden'])->assertForbidden();
        $this->signIn($admin);
        $this->mutation("/api/admin/users/{$admin->id}/role", ['role' => 'member', 'reason' => 'Last admin'])->assertStatus(409);
        $this->mutation('/api/account/delete', ['confirmation' => 'admin', 'password' => 'A private password 123'])->assertStatus(409);
        $this->mutation("/api/admin/users/{$this->owner->id}/role", ['role' => 'admin', 'reason' => 'Successor'])->assertOk();
        $this->mutation("/api/admin/users/{$admin->id}/role", ['role' => 'member', 'reason' => 'Handover'])->assertOk();
    }

    public function test_admin_catalog_merge_preserves_publication_ids_revisions_and_ratings(): void
    {
        $a = $this->publish();
        $b = $this->publish($this->content('Other song'));
        $this->signIn($this->user('admin', 'admin'));
        $this->mutation("/api/admin/catalog/{$b['catalogId']}", ['title' => 'Élan', 'artist' => 'A Band', 'reason' => 'Duplicate'])->assertStatus(409);
        $this->mutation("/api/admin/catalog/{$b['catalogId']}/merge", ['targetId' => $a['catalogId'], 'reason' => 'Same song'])->assertOk();
        $this->assertDatabaseCount('catalog_songs', 1);
        $this->getJson("/api/community/publications/{$b['id']}")->assertOk()->assertJsonPath('publication.catalogId', $a['catalogId'])->assertJsonPath('publication.revision', 1);
        $this->assertDatabaseCount('publication_revisions', 2);
    }

    public function test_catalog_corrections_and_merges_survive_lyric_updates_and_retries(): void
    {
        $songId = (string) Str::uuid();
        $a = $this->publish();
        $b = $this->publish($this->content('Other spelling'), $songId);
        $this->signIn($this->user('admin', 'admin'));
        $this->mutation("/api/admin/catalog/{$b['catalogId']}/merge", ['targetId' => $a['catalogId'], 'reason' => 'Same song'])->assertOk();
        $this->mutation("/api/admin/catalog/{$a['catalogId']}", ['title' => 'Corrected spelling', 'artist' => 'A Band', 'reason' => 'Correct title'])->assertOk();
        $this->signIn($this->owner);
        $updated = $this->content('Other spelling', 'New public lyrics');
        foreach ([1, 1, 2] as $revision) {
            $pub = $this->publish($updated, $songId, $revision);
            $this->assertSame($a['catalogId'], $pub['catalogId']);
            $this->assertSame(2, $pub['revision']);
            $this->assertDatabaseCount('catalog_songs', 1);
        }
        // An explicit change of song identity may still move the publication.
        $pub = $this->publish($this->content('An intentionally different song'), $songId, 2);
        $this->assertNotSame($a['catalogId'], $pub['catalogId']);
    }

    public function test_account_deletion_anonymizes_selected_publications_and_removes_emitted_reviews(): void
    {
        $kept = $this->publish();
        $removed = $this->publish();
        $other = $this->user('other');
        $this->signIn($other);
        $otherPub = $this->publish();
        $this->mutation("/api/community/publications/{$kept['id']}/rating", ['stars' => 5])->assertOk();
        $this->signIn($this->owner);
        $this->mutation("/api/community/publications/{$otherPub['id']}/rating", ['stars' => 2])->assertOk();
        $this->mutation('/api/account/delete', ['confirmation' => 'owner', 'password' => 'A private password 123', 'keepPublications' => [$otherPub['id']]])->assertUnprocessable();
        $this->mutation('/api/account/delete', ['confirmation' => 'owner', 'password' => 'A private password 123', 'keepPublications' => [$kept['id']]])->assertOk();
        $this->signIn($other);
        $this->getJson("/api/community/publications/{$kept['id']}")->assertOk()->assertJsonPath('publication.author', 'Anonymous')->assertJsonPath('publication.ratingCount', 1);
        $this->getJson("/api/community/publications/{$removed['id']}")->assertNotFound();
        $this->getJson("/api/community/publications/{$otherPub['id']}")->assertJsonPath('publication.average', null)->assertJsonPath('publication.ratingCount', 0);
        $this->assertDatabaseMissing('users', ['id' => $this->owner->id]);
    }

    public function test_admin_tools_never_return_another_users_private_lyrics(): void
    {
        $private = ['song' => ['id' => (string) Str::uuid(), 'lyrics' => 'PRIVATE-SECRET-LYRICS'], 'draft' => null];
        DB::table('private_records')->insert(['user_id' => $this->owner->id, 'record_key' => 'song.'.$private['song']['id'], 'revision' => 1, 'value' => json_encode($private)]);
        $admin = $this->user('admin', 'admin');
        $this->signIn($admin);
        foreach (['/api/admin/users', '/api/admin/catalog', '/api/moderation/reports', '/api/moderation/events', '/api/community/catalog', '/api/community/mine'] as $path) {
            $response = $this->getJson($path)->assertOk();
            $this->assertStringNotContainsString('PRIVATE-SECRET-LYRICS', $response->getContent());
            $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        }
        $this->mutation('/api/sync', ['accountId' => $this->owner->id, 'cursor' => 0])->assertForbidden();
    }

    public function test_service_settings_return_booleans_after_saving_and_reloading(): void
    {
        $this->signIn($this->user('admin', 'admin'));
        $this->getJson('/api/admin/settings')->assertOk()
            ->assertJsonPath('settings.publishing_enabled', true)
            ->assertJsonPath('settings.reviews_enabled', true);

        foreach ([[false, false], [true, false], [false, true], [true, true]] as [$publishing, $reviews]) {
            $this->mutation('/api/admin/settings', [
                'publishingEnabled' => $publishing,
                'reviewsEnabled' => $reviews,
                'reason' => 'Service settings regression test',
            ])->assertOk();
            $this->getJson('/api/admin/settings')->assertOk()
                ->assertJsonPath('settings.publishing_enabled', $publishing)
                ->assertJsonPath('settings.reviews_enabled', $reviews);
        }
    }

    public function test_settings_migration_and_first_admin_command_are_repeatable(): void
    {
        $pub = $this->publish();
        $this->artisan('lyricflow:admin', ['email' => $this->owner->email])->assertFailed();
        $this->artisan('lyricflow:admin', ['email' => $this->owner->email, '--confirm' => true])->assertSuccessful();
        $this->signIn($this->owner->fresh());
        $this->mutation('/api/admin/settings', ['publishingEnabled' => false, 'reviewsEnabled' => false, 'reason' => 'Maintenance'])->assertOk();
        $migration = require database_path('migrations/2026_10_19_000002_create_community.php');
        $migration->up();
        $migration->up();
        $this->assertDatabaseCount('publications', 1);
        $this->assertFalse((bool) DB::table('community_settings')->value('publishing_enabled'));
        $this->mutation('/api/community/publish', ['localSongId' => (string) Str::uuid(), 'expectedRevision' => 0, 'sharingAccepted' => true, 'content' => $this->content()])->assertForbidden();
        $this->getJson("/api/community/publications/{$pub['id']}")->assertOk();
    }

    public function test_mutations_require_csrf_and_the_current_account_and_guest_access_is_refused(): void
    {
        $other = $this->user('other');
        $this->mutation('/api/community/publish', ['accountId' => $other->id, 'localSongId' => (string) Str::uuid(), 'expectedRevision' => 0, 'sharingAccepted' => true, 'content' => $this->content()])->assertForbidden();
        $this->app->instance('env', 'local');
        $this->mutation('/api/community/reports')->assertStatus(419);
        $this->app->instance('env', 'testing');
        $this->mutation('/api/logout')->assertOk();
        $this->getJson('/api/community/catalog')->assertUnauthorized();
        $this->getJson('/api/moderation/reports')->assertUnauthorized();
    }

    public function test_invalid_public_music_and_missing_consent_never_create_publications(): void
    {
        foreach (['[tempo=0]\nLyrics\n[/tempo]', '[pause beats=-2]', '[line bars=0] Lyrics', '[tempo=80]\nLyrics', '[section=Solo]'] as $lyrics) {
            $this->mutation('/api/community/publish', ['localSongId' => (string) Str::uuid(), 'expectedRevision' => 0, 'sharingAccepted' => true, 'content' => $this->content(lyrics: str_replace('\\n', "\n", $lyrics))])->assertUnprocessable();
        }
        $this->mutation('/api/community/publish', ['localSongId' => (string) Str::uuid(), 'expectedRevision' => 0, 'content' => $this->content()])->assertUnprocessable();
        $this->assertDatabaseCount('publications', 0);
    }

    public function test_search_keeps_non_latin_titles_distinct_and_handles_expanded_transliterations(): void
    {
        $this->publish($this->content('歌曲'));
        $this->publish($this->content('別の曲'));
        $this->publish($this->content(str_repeat('ß', 200)));
        $this->assertDatabaseCount('catalog_songs', 3);
        $this->getJson('/api/community/catalog?q='.urlencode('歌曲'))->assertOk()->assertJsonCount(1, 'songs')->assertJsonPath('songs.0.title', '歌曲');
    }

    public function test_zero_is_a_literal_search_term_in_public_and_administrator_tools(): void
    {
        $this->publish($this->content('Song 0'));
        $this->publish([...$this->content('Another song'), 'artist' => 'Band 0']);
        $this->publish($this->content('Unrelated song'));
        $this->getJson('/api/community/catalog?q=0')->assertOk()->assertJsonCount(2, 'songs');
        $this->user('user0');
        $this->signIn($this->user('admin', 'admin'));
        $this->getJson('/api/admin/catalog?q=0')->assertOk()->assertJsonCount(2, 'songs');
        $this->getJson('/api/admin/users?q=0')->assertOk()->assertJsonCount(1, 'users')->assertJsonPath('users.0.pseudonym', 'user0');
    }

    public function test_automatic_sharing_migration_is_repeatable_and_keeps_existing_content(): void
    {
        $publication = $this->publish();
        $migration = require database_path('migrations/2026_10_19_000003_add_automatic_sharing.php');
        $migration->down();
        $migration->up();
        $migration->up();
        $this->getJson('/api/community/mine')->assertOk()
            ->assertJsonPath('accountId', $this->owner->id)
            ->assertJsonPath('publications.0.autoShareUpdates', true)
            ->assertJsonPath('publications.0.sharingVersion', 1)
            ->assertJsonPath('publications.0.content', $publication['content']);
        $this->getJson("/api/community/publications/{$publication['id']}")
            ->assertJsonMissingPath('publication.autoShareUpdates')->assertJsonMissingPath('publication.sharingVersion');
    }

    public function test_automatic_updates_are_idempotent_and_reject_concurrent_different_content(): void
    {
        $publication = $this->publish();
        $path = "/api/community/publications/{$publication['id']}/auto-update";
        $data = ['localSongId' => $publication['localSongId'], 'expectedRevision' => 1, 'expectedSharingVersion' => 1, 'content' => $this->content(lyrics: 'Saved public changes')];
        $this->mutation($path, $data)->assertOk()->assertJsonPath('publication.revision', 2);
        $this->mutation($path, $data)->assertOk()->assertJsonPath('publication.revision', 2);
        $data['content'] = $this->content(lyrics: 'Stale offline changes');
        $this->mutation($path, $data)->assertConflict();
        $this->assertDatabaseCount('publication_revisions', 2);
        $this->mutation('/api/community/publications/'.Str::uuid().'/auto-update', $data)->assertNotFound();
        $this->assertDatabaseCount('publications', 1);
        $data['expectedRevision'] = 2;
        $data['content']['fontSize'] = 80;
        $this->mutation($path, $data)->assertUnprocessable();
    }

    public function test_automatic_sharing_settings_belong_to_the_owner_and_invalidate_old_operations(): void
    {
        $publication = $this->publish();
        $path = "/api/community/publications/{$publication['id']}";
        $data = ['localSongId' => $publication['localSongId'], 'expectedRevision' => 1, 'expectedSharingVersion' => 1, 'content' => $this->content(lyrics: 'Delayed saved changes')];
        $disable = ['enabled' => false, 'expectedSharingVersion' => 1, 'operationId' => (string) Str::uuid()];
        $this->mutation("$path/auto-share", $disable)->assertOk()->assertJsonPath('publication.sharingVersion', 2);
        $this->mutation("$path/auto-share", $disable)->assertOk()->assertJsonPath('publication.sharingVersion', 2);
        $this->mutation("$path/auto-update", $data)->assertConflict();
        $this->mutation("$path/auto-share", ['enabled' => true, 'expectedSharingVersion' => 1])->assertConflict();
        $this->mutation("$path/auto-share", ['enabled' => true, 'expectedSharingVersion' => 2])->assertOk()->assertJsonPath('publication.sharingVersion', 3);
        $this->mutation("$path/auto-update", $data)->assertConflict();
        $this->mutation("$path/auto-share", ['enabled' => true, 'expectedSharingVersion' => 1])->assertConflict();
        $this->mutation("$path/auto-share", $disable)->assertConflict();
        $this->getJson('/api/community/mine')->assertJsonPath('publications.0.autoShareUpdates', true);
        $this->signIn($this->user('sharing_intruder', 'admin'));
        $this->mutation("$path/auto-share", ['enabled' => false, 'expectedSharingVersion' => 3])->assertNotFound();
        $this->mutation("$path/auto-update", $data)->assertNotFound();
        $this->getJson('/api/community/mine')->assertJsonCount(0, 'publications');
    }

    public function test_withdrawal_republication_and_moderation_reject_stale_automatic_updates(): void
    {
        $publication = $this->publish();
        $path = "/api/community/publications/{$publication['id']}";
        $data = ['localSongId' => $publication['localSongId'], 'expectedRevision' => 1, 'expectedSharingVersion' => 1, 'content' => $this->content(lyrics: 'Delayed saved changes')];
        $this->mutation("$path/unpublish", ['expectedRevision' => 1])->assertOk();
        $this->mutation("$path/auto-update", $data)->assertConflict();
        $this->publish(songId: $publication['localSongId'], revision: 1);
        $this->mutation("$path/auto-update", $data)->assertConflict();
        $fresh = $this->getJson('/api/community/mine')->json('publications.0.sharingVersion');
        $moderator = $this->user('sharing_moderator', 'moderator');
        $this->signIn($moderator);
        foreach (['hide', 'restore'] as $action) {
            $this->mutation('/api/moderation/actions', ['targetType' => 'publication', 'targetId' => $publication['id'], 'action' => $action, 'reason' => 'Review the publication'])->assertOk();
        }
        $this->signIn($this->owner);
        $data['expectedSharingVersion'] = $fresh;
        $this->mutation("$path/auto-update", $data)->assertConflict();
        $data['expectedSharingVersion'] = $this->getJson('/api/community/mine')->json('publications.0.sharingVersion');
        DB::table('community_settings')->where('id', 1)->update(['publishing_enabled' => false]);
        $this->mutation("$path/auto-update", $data)->assertForbidden();
        $this->assertDatabaseCount('publication_revisions', 1);
    }

    public function test_owner_pagination_can_keep_a_stable_order_while_publications_change(): void
    {
        for ($i = 0; $i < 21; $i++) {
            $this->publish($this->content("Stable page $i"));
        }
        // Native MariaDB UUIDs and SQLite text need not have the same ordering.
        $ids = DB::table('publications')->orderBy('id')->pluck('id')->all();
        $first = $this->getJson('/api/community/mine?sort=id')->assertOk()->assertJsonPath('more', true)->json('publications');
        $this->assertSame(array_slice($ids, 0, 20), array_column($first, 'id'));
        DB::table('publications')->where('id', $ids[20])->update(['updated_at' => now()->addMinute()]);
        $second = $this->getJson('/api/community/mine?sort=id&page=2')->assertOk()->assertJsonPath('more', false)->json('publications');
        $this->assertSame([$ids[20]], array_column($second, 'id'));
        $this->getJson('/api/community/mine?sort=unsupported')->assertUnprocessable();
    }
}
