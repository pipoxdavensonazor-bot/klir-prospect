# Migration progressive du mode démo

1. L’utilisateur peut continuer sans compte; l’état reste dans `sessionStorage`.
2. Après inscription et confirmation e-mail, le profil est créé par trigger.
3. Une connexion ouvre l’espace du compte. S’il existe déjà dans `workspace_states`, il est chargé. La démonstration anonyme de l’onglet n’est pas copiée toute seule : elle reste de côté jusqu’au bouton « Copier les recherches démo », qui ajoute les recherches absentes sans remplacer celles déjà enregistrées.
4. Chaque enregistrement fait pendant que le compte est ouvert écrit `workspace_states` (recherches, prospects, CRM), après retrait des secrets et dans la limite de 2 Mo. Un trigger pose `profiles.demo_migrated_at` ; le client ne peut pas l’écrire. Le même compte sur un autre ordinateur recharge cet état sous RLS (`user_id = auth.uid()`).
5. La suppression redemande le mot de passe, révoque toutes les sessions, supprime `auth.users`, puis les tables applicatives partent en cascade.

La copie ne contient ni mot de passe, ni jeton, ni clé API. La démonstration anonyme n’est pas associée automatiquement à un compte.
