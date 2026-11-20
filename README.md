# LyricFlow

LyricFlow is a music teleprompter for phones, tablets, and computers. The editor saves songs and drafts on your device. The prompter scrolls in time with the music or at a fixed speed in pixels per second. It works offline after the PWA first loads. Accounts, private sync, and the community catalog are optional. The interface and user guide are in English.

## Run locally

Install PHP 8.4 or later with the extensions required by Composer, along with Composer 2 and Node.js 22.12 or later. Guest mode works without a database.

```bash
composer install
cp .env.example .env
php artisan key:generate
npm ci --prefix frontend
npm run build --prefix frontend
php artisan serve --host=127.0.0.1 --port=8000
```

Open <http://localhost:8000> and follow the [user guide](docs/USER_GUIDE.md). The [music notation guide (French)](docs/FORMAT_MUSICAL.md) covers tempo settings, sections, and pauses. The [self-hosting guide (French)](docs/AUTO_HEBERGEMENT.md) covers HTTPS, Docker, and enabling accounts.

## Contributing

Open an [issue](https://github.com/Rayman223/lyricflow/issues) to report a reproducible problem or discuss a proposed change. Submit changes in a pull request and describe the checks you ran. By submitting a contribution, you offer it under the repository license and confirm that you have the right to do so. Include the source and license terms of any third-party resources. Use English for interface text and French for technical documentation, issues, and pull requests.

```bash
npm test --prefix frontend
npm run build --prefix frontend
php artisan test
npx --prefix frontend playwright install chromium
npm run test:e2e --prefix frontend
sh tests/deployment_scripts_test.sh
```

The Laravel tests require PDO SQLite. Playwright uses a disposable local database at `database/browser-tests.sqlite`. Report privacy or security issues through the [private reporting channel](https://github.com/Rayman223/lyricflow/security/advisories/new).

## License

LyricFlow is **source-available** software. The [license](LICENSE) permits professional use, modification, and redistribution free of charge. Selling the software, charging for access or managed hosting, or including it in a commercial offering requires a separate written agreement. The [third-party notices](NOTICE.md) list the terms that apply to those components. Any lyrics you enter or publish remain subject to the rights that apply to them.
