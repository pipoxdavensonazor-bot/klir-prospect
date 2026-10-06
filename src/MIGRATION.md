# Migration progressive du mode démo

1. L’utilisateur peut continuer sans compte; l’état reste dans `sessionStorage`.
2. Après inscription et confirmation e-mail, le profil est créé par trigger.
3. Le bouton « Migrer hors du mode démo » retire comptes, jetons et clés, vérifie la limite de 2 Mo, puis écrit `workspace_states`. Un trigger pose `profiles.demo_migrated_at` ; le client ne peut pas l’écrire.
4. Les connexions suivantes chargent cet état sous RLS (`user_id = auth.uid()`) et quittent le mode démo. Sans cet horodatage serveur, l’onglet reste en démonstration.
5. La suppression redemande le mot de passe, révoque toutes les sessions, supprime `auth.users`, puis les tables applicatives partent en cascade.

La migration ne copie ni mot de passe, ni jeton, ni clé API. Elle ne doit jamais être automatique : le consentement explicite évite d’associer par surprise des données locales au mauvais compte.
