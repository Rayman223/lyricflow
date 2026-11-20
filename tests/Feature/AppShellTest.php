<?php

namespace Tests\Feature;

use Tests\TestCase;

class AppShellTest extends TestCase
{
    public function test_app_shell_is_available_without_account_or_database(): void
    {
        $response = $this->get('/')->assertOk();
        $this->assertSame(public_path('index.html'), $response->baseResponse->getFile()->getPathname());
    }

    public function test_health_endpoint_works_without_database(): void
    {
        $this->get('/up')->assertOk();
    }

    public function test_unknown_online_resource_is_not_exposed_by_spa_fallback(): void
    {
        $this->getJson('/api/songs')->assertNotFound();
    }
}
