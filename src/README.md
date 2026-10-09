# Client Klir Prospect

- `auth.js` encapsule Supabase Auth, le profil RLS, la synchronisation explicite et la suppression de compte.
- `store.js` conserve le mode démonstration dans `sessionStorage`; aucun mot de passe ni secret n’y est enregistré.
- `security.js` neutralise les entrées et protège les exports/imports.
- les autres modules contiennent les fonctionnalités historiques de démonstration.

`tools/build.mjs` regroupe `auth.js` avec `@supabase/supabase-js` et génère `dist/config.js` depuis `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY`. Ces valeurs sont publiques; une clé `service_role` ne doit jamais être fournie au build.

Une fois le compte ouvert, les recherches sont écrites dans `workspace_states` et rechargées sur un autre ordinateur. La démonstration anonyme reste dans l’onglet tant que l’utilisateur ne la copie pas vers le compte.
