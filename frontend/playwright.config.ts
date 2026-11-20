import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
    testDir: './tests',
    workers: 1,
    use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
    projects: [{ name: 'android-browser', use: { ...devices['Pixel 7'] } }],
    webServer: {
        command:
            'npm run build && php tests/prepare-database.php && php ../artisan serve --host=127.0.0.1 --port=4173',
        env: {
            APP_ENV: 'local',
            APP_KEY: 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            APP_URL: 'http://127.0.0.1:4173',
            DB_CONNECTION: 'sqlite',
            DB_DATABASE: fileURLToPath(
                new URL('../database/browser-tests.sqlite', import.meta.url),
            ),
            MAIL_MAILER: 'array',
            CACHE_STORE: 'array',
            SESSION_DRIVER: 'file',
            LYRICFLOW_ACCOUNTS_ENABLED: 'true',
            LYRICFLOW_EMAIL_ENABLED: 'true',
            LYRICFLOW_BROWSER_TESTS: '1',
        },
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: false,
        timeout: 120000,
    },
})
