# Sécurité et migrations requises

## Mesures immédiates

- aucun mot de passe, jeton, secret API ou PII n’est écrit dans `localStorage`;
- sessions Supabase limitées à l’onglet (`sessionStorage`), PKCE, rotation et déconnexion globale;
- confirmation e-mail et récupération par `token_hash`, échangé seulement après un clic, avec sessions PKCE limitées à l’onglet;
- profil RLS, horodatage de sortie du mode démo écrit par trigger, et suppression réelle après ressaisie du mot de passe;
- rôle admin distinct : ligne dans `private.admins`, lue seulement par `public.is_admin()` (`security definer`, `search_path` vide). Aucun client authentifié ne peut s’y inscrire, et `public.profiles` n’a pas de colonne de rôle. La migration `20261105014500_admin_role` n’est appliquée ni sur Test ni sur Prod sans OK explicite de Philippe. Voir `docs/role-admin.md`;
- migration des données démo volontaire, limitée à 2 Mo, nettoyée des secrets et protégée par RLS;
- identifiants générés avec Web Crypto;
- imports CSV limités à 1 Mo / 1 000 lignes, texte neutralisé et formules CSV protégées;
- validation stricte des domaines, refus des IP/hôtes privés et requêtes HTTPS sans credentials ni redirections;
- CSP, HSTS et en-têtes défensifs livrés dans `dist/_headers`;
- build en liste blanche vers `dist/`, sans plug-in serveur public ni modules sensibles.

## Risques résiduels

- l’application historique construit encore certaines vues avec `innerHTML` et des styles inline. Les chaînes externes (OpenStreetMap, Sirene, textes IA, prospects, CRM, campagnes) sont neutralisées avec `KlirSecurity.publishValue` / `text` avant d’entrer dans l’état, et les interpolations HTML passent par `KlirSecurity.html` (ou `hx` / `esc` / `wEsc` / `pjEsc`). Une migration complète vers des nœuds DOM reste souhaitable. Les clics passent par des écouteurs (`data-nav`, `data-scroll`, `data-dismiss` ou `.onclick` posé depuis un script externe) : `script-src` n’autorise plus `'unsafe-inline'`. Le seul script inline restant est le gestionnaire fixe du formulaire d’aperçu Web AI, autorisé par empreinte `sha256`. `style-src` conserve `'unsafe-inline'` tant que les styles inline n’ont pas migré ;
- le registre de crédits et ses réservations sont gérés par PostgreSQL avec RLS lorsque les migrations sont appliquées sur le projet de test, puis seulement ensuite en production. Le résultat de collecte (`complete` ou `release`) et le montant demandé sont toutefois déclarés par le navigateur ; ce mécanisme ne prouve pas un usage facturable. Avant de vendre des crédits, exécuter et constater la collecte côté serveur, puis y confirmer le débit. Les limites IA et exports historiques restent côté client ;
- les vérifications de domaine faites par le navigateur sont limitées par CORS et ne doivent pas devenir un proxy générique;
- `sessionStorage` protège contre la persistance longue, pas contre un script exécuté dans la même origine; une architecture serveur avec cookies HttpOnly reste préférable pour des données très sensibles;
- la prévisualisation de cette livraison reste sans base ; aucune isolation de comptes distante, restauration distante ou conformité de facturation n'est validée. Le correctif de quota `20261022130000_enforce_reserved_search_quota` doit être appliqué et testé sur la base dédiée avant production.
- le Checkout Stripe de test n'est utilisable que si la prévisualisation du projet Test active explicitement `STRIPE_TEST_CHECKOUT_ENABLED` avec une clé `sk_test_` ou `rk_test_`. Le navigateur ne fixe pas le prix, le succès ni les crédits. Tant que ce drapeau et les secrets de test sont absents, l'achat reste fermé. Aucun paiement réel n'a été observé.

## Backend avant réactivation

1. Pour une future application SSR/BFF, déplacer les sessions vers des cookies `Secure; HttpOnly; SameSite` gérés côté serveur.
2. Configurer SMTP, CAPTCHA et URLs de redirection dans le projet Supabase cible.
3. Garder les JWT courts : la révocation coupe les refresh tokens, mais un access token reste valable jusqu’à son expiration.
4. Étendre RLS/RBAC, ownership, quotas et crédits à chaque table métier avec une politique deny-by-default.
5. Secrets d’intégration chiffrés côté serveur et jamais renvoyés au client.
6. Stockage structuré avec chiffrement, rétention/minimisation PII, export et effacement conformes.
7. Import de domaine via service dédié: résolution DNS et blocage des réseaux privés après chaque redirection, limites de taille/temps/type.
8. Synchronisation paginée ou par objets, avec limites explicites, contrôle de concurrence et erreurs visibles; abandon du slot monolithique 300 Ko.
9. Retrait de `style-src 'unsafe-inline'` après migration des styles inline. Les scripts inline variables, s’il en reste, passeraient ensuite par des nonces.

Les anciennes données navigateur ne doivent pas être migrées automatiquement. Une migration explicite doit demander le consentement, retirer comptes/hashes/tokens/clés, valider le schéma et supprimer les anciennes clés après confirmation.
