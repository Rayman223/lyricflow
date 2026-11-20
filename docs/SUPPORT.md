# Dons volontaires via Stripe

La page `/support` peut afficher un lien de don ponctuel, un objectif annuel et un mur facultatif. Aucun accès ni fonctionnalité ne dépend d’un don.

1. Dans Stripe, créer un Payment Link dédié à l’instance avec un montant libre en EUR. Renseigner `STRIPE_DONATION_URL` avec son URL `donate.stripe.com` ou `buy.stripe.com`. Sans URL, le bouton de don reste masqué.
2. Pour le rapprochement automatique, activer les comptes et migrer la base selon le [guide d’auto-hébergement](AUTO_HEBERGEMENT.md). Renseigner `STRIPE_DONATION_PAYMENT_LINK_ID` (identifiant `plink_…`) et `STRIPE_SECRET_KEY` (clé API serveur pouvant lire Checkout Sessions, PaymentIntents et Charges). Associer des clés et un lien du même environnement à `STRIPE_LIVEMODE`. `SUPPORT_YEARLY_GOAL_EUR=0` masque la jauge.
3. Dans Stripe Workbench, créer une destination **Snapshot** utilisant la version d’API `2026-10-28.endive`. Utiliser l’URL HTTPS de l’instance suivie de `/api/support/stripe/webhook` et sélectionner ces événements.

   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `charge.refunded`
   - `refund.updated`
   - `refund.failed`

   Reporter le secret de signature `whsec_…` de cette destination dans `STRIPE_WEBHOOK_SECRET`. Garder la configuration hors du dépôt. Redémarrer le conteneur pour recharger la configuration.

4. Vérifier le rapprochement avec `docker exec lyricflow php artisan support:reconcile`. Configurer ensuite le planificateur de l’hôte avec `* * * * * docker exec lyricflow php artisan schedule:run`. Le rapprochement tourne toutes les quinze minutes et complète les notifications du webhook. Garder un cache avec verrou partagé entre le service et les commandes, par exemple le cache fichier dans le volume persistant.
5. Avec un lien et des clés de test, vérifier qu’un don payé s’affiche après rapprochement, qu’un remboursement réduit le montant pris en compte et que le donateur peut masquer son pseudonyme sur le mur.
