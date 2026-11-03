# Stripe Checkout de test — prévisualisation seulement

2 novembre 2026, heure de Toronto. Branche de travail `codex/commercial-readiness-audit`, travaux Codex conservés. Achat fermé. Aucune clé réelle, aucune production, aucune fusion de la PR #21.

## Ce qui est préparé

Le produit visé est « KlirProspect — pilote accompagné (DÉMO) », paiement ponctuel de 49 $ CA pour 30 jours. Le prix est figé dans la base (`4900`, `cad`, 30 jours, offre `klirprospect-pilot-demo`). Le navigateur ne peut pas envoyer un montant, un nombre de crédits ou un paiement réussi.

Un compte connecté de la prévisualisation du projet Test `pwakjxjjxswdjsapsbxn` peut demander une session Checkout seulement si `KLIR_ENV=preview`, `STRIPE_TEST_CHECKOUT_ENABLED=1`, une clé `sk_test_` ou `rk_test_`, un `price_` de test, un secret de webhook `whsec_` et une origine HTTPS qui n’est pas `https://klirprospect.klirline.ca`. Sinon les fonctions répondent `purchases_closed` ou `live_key_rejected`.

La réussite vient d’une relecture Stripe de la session `cs_test_`, comparée à la commande du compte, puis de `stripe_test_apply_paid`. Un second événement ou un second clic ne crée pas une seconde activation. Un remboursement intégral retire l’accès et reprend le lot de crédits s’il est encore entier. Un remboursement partiel, un litige ou un solde insuffisant pour reprendre tout le lot ne sont pas acquittés comme un succès. Le lot technique ajouté au registre existant est de 90 crédits, soit le plafond actuel de 10 recherches complètes au tarif maximum de 9. Ce n’est pas une promesse de 10 recherches sur 30 jours : le compteur mensuel du registre ne change pas.

## Ce qui a été exécuté ici

Tests locaux isolés, sans réseau Stripe et sans base hébergée : notifications fictives, doublons, impayés, écarts de montant, remboursement intégral simulé, et registre PGlite (solde 200 → 290 pour le bon compte, l’autre compte reste à 200, remboursement retour à 200). Le bouton d’offre reste désactivé tant que le drapeau de prévisualisation est absent.

## Ce qui n’a pas été observé

Aucune variable `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` ou `SUPABASE_SERVICE_ROLE_KEY` n’était disponible. La migration `20261103010000_stripe_test_preview.sql` n’a pas été appliquée au projet Test. Aucune fonction Edge n’a été déployée. Aucun paiement carte `4242` ni webhook Stripe réel n’a été reçu. Le parcours navigateur choix de l’offre → Checkout → confirmation serveur n’a donc pas été vu en prévisualisation.

Le raccordement n’est pas terminé. Il le sera seulement après déploiement sur la prévisualisation Test, un paiement fictif constaté, la même activation refusée en double, et un échec ou un remboursement constaté sans ouvrir l’accès du mauvais compte.
