import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { rmSync } from 'node:fs'

export default defineConfig({
    plugins: [
        {
            name: 'clean-generated-assets',
            apply: 'build',
            buildStart() {
                // Only generated bundles, never Laravel's public/index.php.
                rmSync(new URL('../public/assets', import.meta.url), {
                    recursive: true,
                    force: true,
                })
            },
        },
        vue(),
        VitePWA({
            registerType: 'prompt',
            injectRegister: false,
            includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
            manifest: {
                name: 'LyricFlow',
                short_name: 'LyricFlow',
                description: 'Lyrics at your tempo.',
                start_url: '/',
                scope: '/',
                id: '/',
                display: 'standalone',
                background_color: '#101a20',
                theme_color: '#101a20',
                icons: [
                    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
                    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
                ],
            },
            workbox: {
                globPatterns: ['**/*.{html,js,css,svg,webmanifest}'],
                globIgnores: ['prototype/**'],
                navigateFallback: '/index.html',
                navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/auth(?:\/|$)/, /^\/up$/],
                // Activation is explicit; each tab saves or defers its own reload.
                skipWaiting: false,
                clientsClaim: false,
                cleanupOutdatedCaches: true,
            },
        }),
    ],
    build: { outDir: '../public', emptyOutDir: false },
    test: { include: ['src/**/*.test.ts'] },
})
