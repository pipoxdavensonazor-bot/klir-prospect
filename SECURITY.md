# Sécurité et migrations requises

## Mesures immédiates

- aucun mot de passe, jeton, secret API ou PII n’est écrit dans `localStorage`;
- sessions Supabase limitées à l’onglet (`sessionStorage`), PKCE, rotation et déconnexion globale;
- confirmation e-mail et récupération par `token_hash`, échangé seulement après un clic, avec sessions PKCE limitées à l’onglet;
- profil RLS, horodatage de sortie du mode démo écrit par trigger, et suppression réelle après ressaisie du mot de passe;
- migration des données démo volontaire, limitée à 2 Mo, nettoyée des secrets et protégée par RLS;
- identifiants générés avec Web Crypto;
- imports CSV limités à 1 Mo / 1 000 lignes, texte neutralisé et formules CSV protégées;
- validation stricte des domaines, refus des IP/hôtes privés et requêtes HTTPS sans credentials ni redirections;
- CSP, HSTS et en-têtes défensifs livrés dans `dist/_headers`;
- build en liste blanche vers `dist/`, sans plug-in serveur public ni modules sensibles.

## Risques résiduels

- l’application historique construit encore certaines vues avec `innerHTML` et des gestionnaires inline. Les entrées persistées/importées sont neutralisées, mais une migration complète vers des nœuds DOM ou un framework à échappement automatique reste requise. La CSP conserve temporairement `unsafe-inline`;
- quotas, crédits et fonctions métier historiques restent démonstratifs côté client; seuls le profil et l’état migré sont actuellement protégés par PostgreSQL/RLS;
- les vérifications de domaine faites par le navigateur sont limitées par CORS et ne doivent pas devenir un proxy générique;
- `sessionStorage` protège contre la persistance longue, pas contre un script exécuté dans la même origine; une architecture serveur avec cookies HttpOnly reste préférable pour des données très sensibles;
- aucun déploiement de production n’a été effectué.

## Backend avant réactivation

1. Pour une future application SSR/BFF, déplacer les sessions vers des cookies `Secure; HttpOnly; SameSite` gérés côté serveur.
2. Configurer SMTP, CAPTCHA et URLs de redirection dans le projet Supabase cible.
3. Garder les JWT courts : la révocation coupe les refresh tokens, mais un access token reste valable jusqu’à son expiration.
4. Étendre RLS/RBAC, ownership, quotas et crédits à chaque table métier avec une politique deny-by-default.
5. Secrets d’intégration chiffrés côté serveur et jamais renvoyés au client.
6. Stockage structuré avec chiffrement, rétention/minimisation PII, export et effacement conformes.
7. Import de domaine via service dédié: résolution DNS et blocage des réseaux privés après chaque redirection, limites de taille/temps/type.
8. Synchronisation paginée ou par objets, avec limites explicites, contrôle de concurrence et erreurs visibles; abandon du slot monolithique 300 Ko.
9. Retrait de `unsafe-inline` après migration des gestionnaires et styles inline, puis CSP avec nonces/hashes.

Les anciennes données navigateur ne doivent pas être migrées automatiquement. Une migration explicite doit demander le consentement, retirer comptes/hashes/tokens/clés, valider le schéma et supprimer les anciennes clés après confirmation.
