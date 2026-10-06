# Migration progressive du mode démo

1. L’utilisateur peut continuer sans compte; l’état reste dans `sessionStorage`.
2. Après inscription et confirmation e-mail, le profil est créé par trigger.
3. Le bouton « Migrer mes données démo » nettoie l’état, vérifie la limite de 2 Mo puis l’écrit dans `workspace_states`.
4. Les connexions suivantes chargent cet état sous RLS (`user_id = auth.uid()`).
5. La suppression du compte révoque les refresh tokens, supprime `auth.users`, puis les tables applicatives sont supprimées par cascade.

La migration ne copie ni mot de passe, ni jeton, ni clé API. Elle ne doit jamais être automatique : le consentement explicite évite d’associer par surprise des données locales au mauvais compte.
