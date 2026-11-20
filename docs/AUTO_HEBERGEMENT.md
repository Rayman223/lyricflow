# Auto-héberger LyricFlow

## Installer le conteneur

Prévoir Docker et un proxy inverse qui termine HTTPS. Par défaut, l’application fonctionne sans base de données et conserve les morceaux sur l’appareil où ils sont saisis.

Pour une instance tierce accessible à d’autres utilisateurs, choisir un nom et des icônes propres avant de construire l’image. Mettre à jour le titre dans `frontend/index.html`, le manifeste dans `frontend/vite.config.ts`, les icônes dans `frontend/public/` et les libellés de marque dans `frontend/src/App.vue` et `frontend/src/i18n/en.ts`. Régler aussi `APP_NAME` et `MAIL_FROM_NAME` sur l’identité de l’instance.

Depuis la racine du dépôt, préparer la configuration et générer une clé dédiée. Conserver la même `APP_KEY` lors des mises à jour et des restaurations.

```bash
umask 077
cp deploy/production.env.example .env.production
docker build --target production -t lyricflow-local .
docker run --rm --entrypoint php lyricflow-local artisan key:generate --show
```

Reporter la clé dans `.env.production` et régler `APP_URL` sur l’URL HTTPS de l’instance. Pour que le fichier soit lisible par le conteneur, lui donner le groupe de `www-data` (GID 33 avec l’image Debian et Docker sans remappage des utilisateurs) et le mode `0640`. Garder ce fichier privé.

```bash
docker volume create lyricflow-storage
docker run -d --name lyricflow --restart unless-stopped \
    -p 127.0.0.1:8080:8080 \
    --mount "type=bind,src=$PWD/.env.production,dst=/app/.env,readonly" \
    --mount type=volume,src=lyricflow-storage,dst=/app/storage \
    lyricflow-local
```

Configurer le proxy inverse pour se connecter à `127.0.0.1:8080` et transmettre le nom d’hôte, le protocole HTTPS et l’adresse IP du visiteur. Laravel utilise cette adresse pour les limites de requêtes. Régler `TRUSTED_PROXIES` sur l’adresse du proxy telle que le conteneur la voit. Pour un Nginx directement exposé à Internet, écraser les en-têtes reçus du client avec les valeurs connues du proxy.

```nginx
proxy_pass http://127.0.0.1:8080;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
```

Vérifier que `/up` renvoie HTTP 200 via HTTPS et que la PWA s’ouvre.

## Activer les comptes

1. Créer une base MariaDB et un utilisateur dédiés. Renseigner les paramètres `DB_*` dans `.env.production`. L’adresse doit être joignable depuis le conteneur. Si MariaDB est un autre conteneur, joindre les deux services au même réseau Docker et utiliser le nom du service comme `DB_HOST`.
2. Régler `LYRICFLOW_ACCOUNTS_ENABLED=true`. Pour l’inscription et la récupération par e-mail, régler aussi `LYRICFLOW_EMAIL_ENABLED=true`, `MAIL_MAILER=smtp`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD` et `MAIL_FROM_ADDRESS`. Pour Google, configurer un client OAuth et enregistrer la même URI HTTPS se terminant par `/auth/google/callback` dans Google et `GOOGLE_REDIRECT_URI`, puis fournir `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`.
3. Avant d’ouvrir le trafic avec cette configuration, appliquer les migrations avec l’image candidate et ses accès à la base. Lors d’une mise à jour, sauvegarder la base, le stockage persistant et la configuration privée avant de migrer.

   ```bash
   docker run --rm --entrypoint php \
       --mount "type=bind,src=$PWD/.env.production,dst=/app/.env,readonly" \
       lyricflow-local artisan migrate --force
   ```

   Avec une base sur un réseau Docker partagé, passer le même `--network` aux commandes de migration et de lancement. Redémarrer le conteneur après toute modification de sa configuration. Vérifier l’inscription et la sauvegarde privée d’un morceau de test.

4. Pour nommer le premier administrateur, utiliser un compte actif et vérifié puis exécuter `docker exec lyricflow php artisan lyricflow:admin admin@example.invalid --confirm` en remplaçant l’adresse d’exemple.

## Activer les dons volontaires

Suivre le [guide Stripe](SUPPORT.md) pour créer un lien de don, configurer le webhook et activer le rapprochement planifié. Les dons restent facultatifs.
