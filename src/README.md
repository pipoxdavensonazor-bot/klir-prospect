# Client Klir Prospect

- `auth.js` encapsule Supabase Auth (inscription, confirmation, connexion, récupération, déconnexion globale), le profil RLS, la migration hors démo et la suppression de compte.
- `auth-policy.js` porte les règles testables : e-mail, mot de passe, lien d’e-mail et confirmation de suppression.
- `store.js` conserve le mode démonstration dans `sessionStorage`; aucun mot de passe ni secret n’y est enregistré.
- `security.js` neutralise les entrées et protège les exports/imports.
- les autres modules contiennent les fonctionnalités historiques de démonstration.

`tools/build.mjs` regroupe `auth.js` avec `@supabase/supabase-js` et génère `dist/config.js` depuis `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY`. Ces valeurs sont publiques; une clé `service_role` ne doit jamais être fournie au build.

La migration vers Supabase reste opt-in depuis le profil : l’utilisateur choisit quand copier son état de démonstration vers `workspace_states`.
