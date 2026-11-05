-- Rôle admin distinct du compte. private.admins n'est pas exposée au
-- navigateur : aucune policy, aucun grant pour anon ni authenticated.
-- public.is_admin() est la seule lecture. Elle ne prend aucun argument
-- et ne regarde que auth.uid(). Un client authentifié ne peut pas
-- s'inscrire lui-même. Ce n'est pas une colonne de public.profiles :
-- profiles_update_own ne doit pas pouvoir changer un rôle.

create table if not exists private.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table private.admins enable row level security;
alter table private.admins force row level security;

revoke all on table private.admins from public, anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.admins
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

comment on table private.admins is
  'Comptes admin. Écriture réservée au rôle propriétaire de la migration. Pas d''accès client.';
comment on function public.is_admin() is
  'Vrai seulement si auth.uid() est dans private.admins. Lecture seule, sans argument.';

-- Promotion idempotente. Ne crée aucun utilisateur Auth. N'écrit rien si
-- la colonne email est absente (bancs locaux) ou si l'adresse n'existe pas.
-- SQL dynamique : le INSERT n'est pas planifié quand la colonne manque.
do $seed$
begin
  if exists (
    select 1
    from pg_attribute as attribute
    join pg_class as relation on relation.oid = attribute.attrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'auth'
      and relation.relname = 'users'
      and attribute.attname = 'email'
      and attribute.attnum > 0
      and not attribute.attisdropped
  ) then
    execute $sql$
      insert into private.admins (user_id)
      select id
      from auth.users
      where lower(btrim(email)) = 'contact@klirline.ca'
      on conflict (user_id) do nothing
    $sql$;
  end if;
end
$seed$;
