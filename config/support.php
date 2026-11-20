<?php

return [
    'yearly_goal_eur' => env('SUPPORT_YEARLY_GOAL_EUR', 260),
    'stripe_url' => env('STRIPE_DONATION_URL', ''),
    'stripe_payment_link' => env('STRIPE_DONATION_PAYMENT_LINK_ID', ''),
    'stripe_secret_key' => env('STRIPE_SECRET_KEY', ''),
    'stripe_webhook_secret' => env('STRIPE_WEBHOOK_SECRET', ''),
    'stripe_livemode' => (bool) env('STRIPE_LIVEMODE', true),
];
