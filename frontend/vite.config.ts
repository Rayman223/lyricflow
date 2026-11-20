import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import { alphaTab } from '@coderline/alphatab-vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { rmSync } from 'node:fs'

// Scoped source correction for pinned alphaTab 1.8.4. Its AudioWorklet output
// starts asynchronously after creating a BufferSource. Closing/pausing before
// addModule resolves calls stop() on an unstarted source and later starts a
// cancelled output. Keep workers/worklets and prevent both lifecycle races.
function alphaTabLifecycle(): Plugin {
    return {
        name: 'lyricflow-alphatab-audio-lifecycle',
        enforce: 'pre',
        transform(code, id) {
            if (
                !id
                    .split('?', 1)[0]!
                    .replaceAll('\\', '/')
                    .endsWith('/@coderline/alphatab/dist/alphaTab.core.mjs')
            )
                return
            const before = '\t\t\tthis.source.stop(0);\n\t\t\tthis.source.disconnect();'
            const after = `\t\t\ttry { this.source.stop(0); }
\t\t\tcatch (error) { if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error; }
\t\t\tthis.source.disconnect();`
            const workletBefore =
                '\t\tBrowserUiFacade.createAlphaSynthAudioWorklet(ctx, this._settings).then(() => {'
            const workletAfter = `\t\tconst requestedSource = this.source;
\t\tBrowserUiFacade.createAlphaSynthAudioWorklet(ctx, this._settings).then(() => {
\t\t\tif (this.source !== requestedSource || this.context !== ctx) return;`
            if (!code.includes(before) || !code.includes(workletBefore))
                this.error(
                    'alphaTab audio lifecycle changed: review the pinned-version correction.',
                )
            return {
                code: code.replace(before, after).replace(workletBefore, workletAfter),
                map: null,
            }
        },
    }
}

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
        alphaTab(),
        alphaTabLifecycle(),
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
                globPatterns: ['**/*.{html,js,css,svg,webmanifest,woff,woff2,ttf,sf2}'],
                maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
                globIgnores: ['prototype/**', 'font/Bravura.svg'],
                navigateFallback: '/index.html',
                navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/auth(?:\/|$)/, /^\/up$/],
                // Activation is explicit; each tab saves or defers its own reload.
                skipWaiting: false,
                clientsClaim: false,
                cleanupOutdatedCaches: true,
            },
        }),
    ],
    optimizeDeps: { exclude: ['@coderline/alphatab'] },
    build: { outDir: '../public', emptyOutDir: false },
    test: { include: ['src/**/*.test.ts'] },
})
