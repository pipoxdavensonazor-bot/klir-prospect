# Rôle admin KlirProspect

Le rôle admin est une ligne dans `private.admins`. `public.is_admin()` en est la seule lecture exposée au compte connecté. La vue `#/admin` de l’application s’ouvre seulement quand cette fonction répond vrai. Sinon l’adresse retombe sur `#/settings`.

Cette migration n’ouvre aucune table métier. La vue admin affiche la session déjà chargée dans l’onglet. Elle ne liste pas les autres comptes.

## Apply Prod

Apply Prod = attendre OK explicite de Philippe. Ne pas appliquer automatiquement.

Ne pas lancer `supabase db push`, `supabase link` ni `psql` vers les projets distants depuis une revue de cette PR.

- Production : `cbklwmjudobqwbkbxqgy` — ne pas y appliquer cette migration.
- Test : `pwakjxjjxswdjsapsbxn` — ne pas y appliquer cette migration non plus, tant que Philippe ne l’a pas demandé pour Test.

## Ce que la migration fait

Fichier : `supabase/migrations/20261105014500_admin_role.sql`.

1. Crée `private.admins(user_id)` avec suppression en cascade du compte Auth.
2. Active et force la RLS, sans policy. `anon` et `authenticated` n’ont aucun droit sur la table.
3. Crée `public.is_admin()` en `security definer`, volatilité `stable`, `search_path` vide. Elle exécute seulement `auth.uid()` contre cette table.
4. Accorde `execute` à `authenticated` et le retire à `public` et `anon`.
5. Si `auth.users.email` existe, insère le compte dont l’adresse est exactement `contact@klirline.ca`. L’insertion est idempotente. Aucun compte n’est créé. Une adresse voisine ne correspond pas.

`public.overture_admin(...)` reste réservée à `service_role`. Ce n’est pas ce rôle utilisateur.

## Promouvoir un autre compte plus tard

Le faire dans l’éditeur SQL du tableau de bord, avec le rôle propriétaire de la base. Ne pas mettre la clé `service_role` dans l’application, dans un build, ni dans un ticket.

```sql
insert into private.admins (user_id)
select id
from auth.users
where lower(btrim(email)) = 'adresse@exemple.ca'
on conflict (user_id) do nothing;
```

Retrait :

```sql
delete from private.admins
where user_id = (
  select id from auth.users where lower(btrim(email)) = 'adresse@exemple.ca'
);
```

Il n’existe pas de fonction RPC pour s’auto-promouvoir. `public.profiles` n’a pas de colonne `role` : `profiles_update_own` ne peut pas écrire ce droit.

## Essai local

Les tests du dépôt appliquent la migration dans PGlite. Ils ne contactent ni Test ni Prod.

```bash
npm run check
```

Pour une base locale Docker seulement, après accord explicite et sans lier un projet distant :

```bash
npx supabase start
npx supabase db reset
```

Ensuite, avec un compte local déjà créé dont l’adresse est `contact@klirline.ca`, ou après l’`insert` ci-dessus sur cette base locale :

1. Se connecter dans l’application.
2. Le menu affiche « Administration » et `#/admin` ouvre la vue.
3. Un autre compte ne voit pas le lien. `#/admin` revient à `#/settings`.
4. Dans le SQL local : `select public.is_admin();` répond vrai seulement pour le compte promu.

La garde d’écran n’est pas la barrière. La barrière est l’absence de droit d’écriture sur `private.admins`.
