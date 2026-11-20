<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('users', 'supporter_public')) {
            Schema::table('users', fn (Blueprint $table) => $table->boolean('supporter_public')->default(false));
        }
        if (! Schema::hasTable('support_donations')) {
            Schema::create('support_donations', function (Blueprint $table): void {
                $table->string('session_id', 100)->primary();
                $table->string('payment_intent', 100)->unique();
                $table->boolean('livemode')->index();
                $table->foreignUuid('user_id')->nullable()->constrained()->nullOnDelete();
                $table->unsignedBigInteger('amount_cents');
                $table->unsignedBigInteger('refunded_cents')->default(0);
                $table->timestamp('paid_at')->index();
                $table->timestamps();
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('support_donations');
        if (Schema::hasColumn('users', 'supporter_public')) {
            Schema::table('users', fn (Blueprint $table) => $table->dropColumn('supporter_public'));
        }
    }
};
