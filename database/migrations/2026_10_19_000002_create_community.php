<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('users', 'role')) {
            Schema::table('users', fn (Blueprint $table) => $table->string('role', 20)->default('member')->index());
        }
        if (! Schema::hasTable('community_settings')) {
            Schema::create('community_settings', function (Blueprint $table): void {
                $table->unsignedTinyInteger('id')->primary();
                $table->boolean('publishing_enabled')->default(true);
                $table->boolean('reviews_enabled')->default(true);
            });
        }
        DB::table('community_settings')->insertOrIgnore(['id' => 1, 'publishing_enabled' => true, 'reviews_enabled' => true]);
        if (! Schema::hasTable('catalog_songs')) {
            Schema::create('catalog_songs', function (Blueprint $table): void {
                $table->uuid('id')->primary();
                $table->string('title', 200);
                $table->string('artist', 200);
                $table->text('search_title');
                $table->text('search_artist');
                $table->string('identity_hash', 64)->unique();
                $table->timestamps();
            });
        }
        if (! Schema::hasTable('publications')) {
            Schema::create('publications', function (Blueprint $table): void {
                $table->uuid('id')->primary();
                $table->foreignUuid('catalog_song_id')->constrained('catalog_songs');
                $table->foreignUuid('user_id')->nullable()->constrained('users')->nullOnDelete();
                $table->uuid('local_song_id')->nullable();
                $table->unsignedInteger('revision')->default(1);
                $table->boolean('published')->default(true);
                $table->boolean('moderation_hidden')->default(false);
                $table->uuid('source_publication_id')->nullable();
                $table->unsignedInteger('source_revision')->nullable();
                $table->timestamps();
                $table->unique(['user_id', 'local_song_id']);
                $table->index(['catalog_song_id', 'published', 'moderation_hidden']);
            });
        }
        if (! Schema::hasTable('publication_revisions')) {
            Schema::create('publication_revisions', function (Blueprint $table): void {
                $table->foreignUuid('publication_id')->constrained('publications')->cascadeOnDelete();
                $table->unsignedInteger('number');
                $table->json('content');
                $table->timestamp('created_at');
                $table->primary(['publication_id', 'number']);
            });
        }
        if (! Schema::hasTable('ratings')) {
            Schema::create('ratings', function (Blueprint $table): void {
                $table->uuid('id')->primary();
                $table->foreignUuid('publication_id')->constrained('publications')->cascadeOnDelete();
                $table->foreignUuid('user_id')->constrained('users')->cascadeOnDelete();
                $table->unsignedTinyInteger('stars');
                $table->text('comment')->nullable();
                $table->boolean('comment_hidden')->default(false);
                $table->unsignedInteger('revision');
                $table->timestamps();
                $table->unique(['publication_id', 'user_id']);
            });
        }
        if (! Schema::hasTable('reports')) {
            Schema::create('reports', function (Blueprint $table): void {
                $table->uuid('id')->primary();
                $table->foreignUuid('reporter_id')->nullable()->constrained('users')->nullOnDelete();
                $table->string('target_type', 20);
                $table->uuid('target_id');
                $table->string('reason', 30);
                $table->text('details')->nullable();
                $table->string('status', 20)->default('open');
                $table->foreignUuid('assigned_to')->nullable()->constrained('users')->nullOnDelete();
                $table->text('decision')->nullable();
                $table->timestamps();
                $table->unique(['reporter_id', 'target_type', 'target_id']);
                $table->index(['status', 'created_at']);
            });
        }
        if (! Schema::hasTable('moderation_events')) {
            Schema::create('moderation_events', function (Blueprint $table): void {
                $table->bigIncrements('id');
                $table->foreignUuid('actor_id')->nullable()->constrained('users')->nullOnDelete();
                $table->string('action', 40);
                $table->string('target_type', 20);
                $table->string('target_id', 64);
                $table->text('reason');
                $table->timestamp('created_at');
            });
        }
    }

    public function down(): void
    {
        foreach (['moderation_events', 'reports', 'ratings', 'publication_revisions', 'publications', 'catalog_songs', 'community_settings'] as $table) {
            Schema::dropIfExists($table);
        }
        if (Schema::hasColumn('users', 'role')) {
            Schema::table('users', fn (Blueprint $table) => $table->dropColumn('role'));
        }
    }
};
