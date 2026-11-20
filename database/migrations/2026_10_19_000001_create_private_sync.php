<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('private_sync_states')) {
            Schema::create('private_sync_states', function (Blueprint $table): void {
                $table->foreignUuid('user_id')->primary()->constrained('users')->cascadeOnDelete();
                $table->unsignedBigInteger('revision')->default(0);
            });
        }
        if (! Schema::hasTable('private_records')) {
            Schema::create('private_records', function (Blueprint $table): void {
                $table->foreignUuid('user_id')->constrained('users')->cascadeOnDelete();
                $table->string('record_key', 64);
                $table->unsignedBigInteger('revision');
                $table->json('value')->nullable();
                $table->primary(['user_id', 'record_key']);
                $table->unique(['user_id', 'revision']);
            });
        }
        if (! Schema::hasTable('private_operations')) {
            Schema::create('private_operations', function (Blueprint $table): void {
                $table->foreignUuid('user_id')->constrained('users')->cascadeOnDelete();
                $table->uuid('operation_id');
                $table->string('request_hash', 64);
                // Receipts contain revisions only, never another copy of private lyrics.
                $table->unsignedBigInteger('revision');
                $table->primary(['user_id', 'operation_id']);
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('private_operations');
        Schema::dropIfExists('private_records');
        Schema::dropIfExists('private_sync_states');
    }
};
