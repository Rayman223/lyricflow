<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('publications', 'auto_share_updates')) {
            Schema::table('publications', fn (Blueprint $table) => $table->boolean('auto_share_updates')->default(true));
        }
        if (! Schema::hasColumn('publications', 'sharing_version')) {
            Schema::table('publications', fn (Blueprint $table) => $table->unsignedInteger('sharing_version')->default(1));
        }
        if (! Schema::hasColumn('publications', 'sharing_operation_id')) {
            Schema::table('publications', fn (Blueprint $table) => $table->uuid('sharing_operation_id')->nullable());
        }
    }

    public function down(): void
    {
        foreach (['auto_share_updates', 'sharing_version', 'sharing_operation_id'] as $column) {
            if (Schema::hasColumn('publications', $column)) {
                Schema::table('publications', fn (Blueprint $table) => $table->dropColumn($column));
            }
        }
    }
};
