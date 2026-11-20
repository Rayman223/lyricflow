<?php

use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    public function up(): void
    {
        // JSON format extension: optional musicLinks on private songs/drafts,
        // source.base and public revision content. A missing field means no links.
        // No SQL column or backfill is needed: retain historical revision content,
        // private operation hashes and pending retry snapshots byte for byte.
    }

    public function down(): void
    {
        // Preserve user links; rolling back the code must not erase stored content.
    }
};
