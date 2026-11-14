# Plan de corrections

La commercialisation reste interdite. Aucune ligne ci-dessous n'autorise une fusion dans `main`, une migration de production, un paiement ou une recherche sur un compte réel.

Les tailles décrivent le périmètre technique, pas un délai.

## Fait dans cette supervision

1. **Test du cycle de sonde.** Branche `cursor/search-probe-cycle-2f07`, commit `6b8a554ba484038d1567b5801f1cd92212e87bd1`. Un seul fichier : `test/overture-pilot-provider.test.mjs`. Le worker et le SQL ne sont pas modifiés. Le double accepte `record_search_places` et vérifie qu'une écriture refusée reste `failed` avec un compte de 0, sans `reserve_usage` ni `settle_usage`.

## Encore bloqué, dans l'ordre

1. **Relire la pull request du test** avant de la fusionner dans `cursor/runner-cors-preview-2f07`. Dépend du commit `6b8a554`. Aucun autre fichier.
2. **Ne pas allumer davantage le moteur Test.** `jobs_enabled` est déjà vrai et la table des jobs est vide. Une recherche connectée réserverait un crédit. Elle exige une approbation nommant le compte fictif ou le compte de supervision.
3. **Prouver la clé OpenCage sans l'afficher.** Le statut admin existe. Il n'a pas été appelé, pour ne pas transporter de session. Dépend d'une lecture `configured` dont la réponse est réduite au booléen.
4. **Décider du `verify_jwt` des trois fonctions Stripe Test.** Le code signe le webhook et authentifie checkout et confirmation. Le dépôt ne déclare pas ces fonctions dans `config.toml`. Décision de configuration, sans ouvrir un paiement.
5. **Restauration fictive chiffrée.** Tant que le chiffrement du disque, du swap et du support n'est pas prouvé, aucune sauvegarde réelle. Le scénario fictif doit couvrir profils, CRM, recherches, crédits, RLS, puis une relecture après restauration.
6. **Production, en dernier.** Migrations, secrets, fonctions, drapeau encore faux, puis une autorisation qui nomme le projet `cbklwmjudobqwbkbxqgy`. Cette étape n'est pas commencée.

## Dépendances

Le correctif de test ne dépend d'aucun secret. La prévisualisation sert déjà `c2a369a` et n'a pas été redéployée. La pile `9dd1b56` reste la base. `main` (`4f4f076`) ne reçoit rien.
