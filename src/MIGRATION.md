# Migration progressive du mode démo

1. L’utilisateur peut continuer sans compte; l’état reste dans `sessionStorage` et le mode démo reste forcé.
2. Après inscription, l’e-mail de confirmation ouvre `#/auth/callback` avec un `token_hash`. Le profil est créé par trigger.
3. Le bouton « Migrer mes données démo » nettoie l’état, retire le profil local, vérifie la limite de 2 Mo, puis l’écrit dans `workspace_states`. Un trigger serveur retire les secrets et enregistre `demo_migrated_at`.
4. Le compte quitte alors le mode démo. Les connexions suivantes chargent cet état sous RLS (`user_id = auth.uid()`), et les enregistrements suivants sont resynchronisés.
5. La suppression demande le mot de passe et `SUPPRIMER`, révoque les sessions, supprime `auth.users`, puis les tables applicatives sont supprimées par cascade.

La migration ne copie ni mot de passe, ni jeton, ni clé API. Elle ne doit jamais être automatique : le consentement explicite évite d’associer par surprise des données locales au mauvais compte.
