<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\Community;
use App\Services\StripeDonations;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use RuntimeException;

class SupportController extends Controller
{
    public function index(Request $request, StripeDonations $stripe): JsonResponse
    {
        $tracking = (bool) config('lyricflow.accounts_enabled');
        $user = $tracking ? $request->user() : null;
        $year = now('UTC')->year;
        $goal = config('support.yearly_goal_eur');
        $goalCents = is_numeric($goal) && is_finite((float) $goal) ? (int) round(max(0, min(1000000, (float) $goal)) * 100) : 26000;
        $covered = $tracking ? (int) DB::table('support_donations')->where('livemode', config('support.stripe_livemode'))->where('paid_at', '>=', "$year-01-01")
            ->where('paid_at', '<', ($year + 1).'-01-01')->selectRaw('COALESCE(SUM(amount_cents - refunded_cents), 0) AS total')->value('total') : null;
        $supporters = $tracking ? User::where('supporter_public', true)->whereNull('banned_at')
            ->whereIn('id', DB::table('support_donations')->where('livemode', config('support.stripe_livemode'))->select('user_id')->whereColumn('amount_cents', '>', 'refunded_cents'))
            ->select('pseudonym')->selectSub(DB::table('support_donations')->selectRaw('MIN(paid_at)')
            ->where('livemode', config('support.stripe_livemode'))->whereColumn('user_id', 'users.id')->whereColumn('amount_cents', '>', 'refunded_cents'), 'since')
            ->orderBy('since')->orderBy('pseudonym')->limit(100)->get()->map(fn ($row) => [
                'pseudonym' => $row->pseudonym, 'since' => Carbon::parse($row->since, 'UTC')->toDateString(),
            ])->all() : [];

        return response()->json([
            'year' => $year, 'goalCents' => $goalCents, 'coveredCents' => $covered,
            'percent' => $goalCents > 0 && $covered !== null ? min(100, (int) floor($covered / $goalCents * 100)) : null,
            'donationUrl' => $stripe->donationUrl($user), 'automatic' => $stripe->automatic(),
            'supporters' => $supporters, 'viewer' => $user ? [
                'id' => $user->id, 'supporter' => $user->isSupporter(), 'public' => (bool) $user->supporter_public,
                'listed' => in_array($user->pseudonym, array_column($supporters, 'pseudonym'), true),
                'admin' => $user->role === 'admin',
            ] : null,
        ]);
    }

    public function visibility(Request $request): JsonResponse
    {
        $data = $request->validate(['public' => ['required', 'boolean']]);

        return Community::mutate($request, function (User $user) use ($data): JsonResponse {
            abort_unless($user->isSupporter(), 403);
            $user->forceFill(['supporter_public' => $data['public']])->save();

            return response()->json(['saved' => true]);
        });
    }

    public function donations(Request $request): JsonResponse
    {
        Community::staff($request->user(), true);
        $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $rows = DB::table('support_donations as d')->leftJoin('users as u', 'd.user_id', '=', 'u.id')
            ->where('d.livemode', config('support.stripe_livemode'))
            ->select('d.session_id', 'd.amount_cents', 'd.refunded_cents', 'd.paid_at', 'u.pseudonym')
            ->orderByDesc('d.paid_at')->orderBy('d.session_id')->simplePaginate(30);

        return response()->json(['donations' => $rows->items(), 'more' => $rows->hasMorePages()]);
    }

    public function webhook(Request $request, StripeDonations $stripe): JsonResponse
    {
        abort_unless($stripe->automatic() && config('support.stripe_webhook_secret'), 503, 'Donation tracking is not configured.');
        $body = $request->getContent();
        abort_if(strlen($body) > 1048576, 413);
        abort_unless($stripe->validSignature($body, $request->header('Stripe-Signature', '')), 400, 'Invalid Stripe signature.');
        $event = json_decode($body, true);
        abort_unless(is_array($event) && is_array($event['data']['object'] ?? null), 400, 'Invalid Stripe event.');
        if (($event['livemode'] ?? null) !== config('support.stripe_livemode')) {
            return response()->json(['received' => true]);
        }
        $object = $event['data']['object'];
        try {
            if (in_array($event['type'] ?? '', ['checkout.session.completed', 'checkout.session.async_payment_succeeded'], true)
                && ($object['payment_link'] ?? null) === config('support.stripe_payment_link')) {
                $stripe->syncSession(is_string($object['id'] ?? null) ? $object['id'] : '');
            } elseif (in_array($event['type'] ?? '', ['charge.refunded', 'refund.updated', 'refund.failed'], true)
                && is_string($object['payment_intent'] ?? null)) {
                $stripe->syncPaymentIntent($object['payment_intent']);
            }
        } catch (RuntimeException) {
            // A failed API fetch must remain retryable; acknowledging it would lose the donation.
            abort(503, 'Donation confirmation will retry.');
        }

        return response()->json(['received' => true]);
    }
}
