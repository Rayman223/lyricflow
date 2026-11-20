# LyricFlow

LyricFlow est un prompteur musical pour téléphone, tablette et ordinateur. L’éditeur conserve les morceaux et les brouillons sur l’appareil. Le lecteur règle le défilement en temps musicaux ou en pixels par seconde et fonctionne hors ligne après le premier chargement de la PWA. Les comptes, la synchronisation privée et le catalogue communautaire sont facultatifs. L’interface et le guide utilisateur sont en anglais.

## Démarrer en local

Installer PHP 8.4 ou plus récent avec les extensions demandées par Composer, Composer 2 et Node.js 22.12 ou plus récent. Le mode sans compte fonctionne sans base de données.

```bash
composer install
cp .env.example .env
php artisan key:generate
npm ci --prefix frontend
npm run build --prefix frontend
php artisan serve --host=127.0.0.1 --port=8000
```

Ouvrir <http://localhost:8000> et suivre le [guide utilisateur](docs/USER_GUIDE.md). Le [format musical](docs/FORMAT_MUSICAL.md) décrit les réglages de tempo, les sections et les pauses. Le [guide d’auto-hébergement](docs/AUTO_HEBERGEMENT.md) couvre HTTPS, Docker et l’activation des comptes.

## Contribuer

Ouvrir une [issue](https://github.com/Rayman223/lyricflow/issues) pour signaler un problème reproductible ou discuter d’une évolution. Proposer les changements dans une PR et préciser les contrôles effectués. En soumettant une contribution, vous la proposez sous la licence du dépôt et confirmez avoir le droit de le faire. Indiquez l’origine et les conditions de toute ressource de tiers. Les textes de l’interface restent en anglais, et la documentation technique, les issues et les PR sont rédigées en français.

```bash
npm test --prefix frontend
npm run build --prefix frontend
php artisan test
npx --prefix frontend playwright install chromium
npm run test:e2e --prefix frontend
sh tests/deployment_scripts_test.sh
```

Les contrôles Laravel requièrent PDO SQLite. Playwright utilise une base locale jetable `database/browser-tests.sqlite`. Signaler un problème de confidentialité ou de sécurité via [le canal de signalement privé](https://github.com/Rayman223/lyricflow/security/advisories/new).

## Licence

LyricFlow est un logiciel **source-available**. La [licence](LICENSE) autorise notamment l’utilisation professionnelle, les modifications et la redistribution gratuite. La vente du logiciel, l’accès ou l’hébergement géré payants et l’intégration dans une offre commerciale exigent un accord écrit distinct. Les [notices des tiers](NOTICE.md) recensent les conditions applicables à leurs composants. Les paroles que vous saisissez ou publiez restent soumises à leurs propres droits.
