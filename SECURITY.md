# Sécurité et migrations requises

## Mesures immédiates

- aucun mot de passe, jeton, secret API ou PII n’est écrit dans `localStorage`;
- sessions limitées à l’onglet (`sessionStorage`) et suppression locale explicite;
- authentification, récupération, partage/RBAC, API locale et synchronisation 300 Ko désactivés;
- identifiants générés avec Web Crypto;
- imports CSV limités à 1 Mo / 1 000 lignes, texte neutralisé et formules CSV protégées;
- validation stricte des domaines, refus des IP/hôtes privés et requêtes HTTPS sans credentials ni redirections;
- CSP, HSTS et en-têtes défensifs livrés dans `dist/_headers`;
- build en liste blanche vers `dist/`, sans plug-in serveur public ni modules sensibles.

## Risques résiduels

- l’application historique construit encore certaines vues avec `innerHTML` et des gestionnaires inline. Les entrées persistées/importées sont neutralisées, mais une migration complète vers des nœuds DOM ou un framework à échappement automatique reste requise. La CSP conserve temporairement `unsafe-inline`;
- quotas, crédits, rôles et autorisations côté client ne constituent pas une frontière de sécurité. Les écrans correspondants sont uniquement démonstratifs;
- les vérifications de domaine faites par le navigateur sont limitées par CORS et ne doivent pas devenir un proxy générique;
- `sessionStorage` protège contre la persistance longue, pas contre un script exécuté dans la même origine;
- aucun déploiement de production n’a été effectué.

## Backend avant réactivation

1. Authentification serveur avec cookies `Secure; HttpOnly; SameSite=Strict`, expiration courte (≤ 24 h), rotation et révocation.
2. Mots de passe avec Argon2id (paramètres calibrés), sels aléatoires et éventuel pepper en gestionnaire de secrets.
3. Récupération à jeton opaque, à usage unique, expirant rapidement; suppression de compte ré-authentifiée et auditée.
4. RBAC, ownership, quotas et crédits vérifiés sur chaque opération serveur; politique deny-by-default.
5. Secrets d’intégration chiffrés côté serveur et jamais renvoyés au client.
6. Stockage structuré avec chiffrement, rétention/minimisation PII, export et effacement conformes.
7. Import de domaine via service dédié: résolution DNS et blocage des réseaux privés après chaque redirection, limites de taille/temps/type.
8. Synchronisation paginée ou par objets, avec limites explicites, contrôle de concurrence et erreurs visibles; abandon du slot monolithique 300 Ko.
9. Retrait de `unsafe-inline` après migration des gestionnaires et styles inline, puis CSP avec nonces/hashes.

Les anciennes données navigateur ne doivent pas être migrées automatiquement. Une migration explicite doit demander le consentement, retirer comptes/hashes/tokens/clés, valider le schéma et supprimer les anciennes clés après confirmation.
