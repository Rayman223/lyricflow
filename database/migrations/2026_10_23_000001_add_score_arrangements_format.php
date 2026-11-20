<?php

use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    public function up(): void
    {
        // Optional arrangements (LyricFlow score JSON v1) on private songs/drafts,
        // source.base and public revisions. Absence means no scores. No backfill:
        // preserve historical revisions, operation hashes and pending retries.
        // This format migration is intentionally idempotent and requires no SQL DDL.
    }

    public function down(): void
    {
        // Rolling back code must never erase users' musical content.
    }
};
