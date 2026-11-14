-- Limites par forfait et expiration des packs de crédits (feu vert Philippe t128).
--
-- Grille approuvée (#/tarifs, 13 nov. 2026) :
--   Gratuit : 1 utilisateur, CRM 100 fiches, IA non incluse
--   Starter : 1 utilisateur, CRM illimité, 50 messages IA par mois
--   Pro     : 2 utilisateurs, CRM illimité, 50 messages IA par mois (« Tout Starter »)
--   Équipe  : 5 utilisateurs, CRM illimité, 50 messages IA par mois (« Tout Pro »)
-- Un compte au-dessus d'une limite garde tout : seules les nouvelles
-- additions sont refusées (jamais de suppression, jamais de correction de solde).
--
-- Packs : chaque pack acheté devient un lot qui expire 12 mois après l'achat.
-- Les débits consomment d'abord les lots (le plus proche de l'expiration en
-- premier). À l'échéance, seul le reste non utilisé du lot est retiré, sans
-- jamais descendre sous zéro. Aucun lot n'est créé pour le passé.

create function private.plan_limits(p_tier text)
returns jsonb language sql immutable set search_path = '' as $$
  select case coalesce(p_tier, 'gratuit')
    when 'equipe'  then '{"seats":5,"crm_max":null,"ai_month":50}'::jsonb
    when 'pro'     then '{"seats":2,"crm_max":null,"ai_month":50}'::jsonb
    when 'starter' then '{"seats":1,"crm_max":null,"ai_month":50}'::jsonb
    else                '{"seats":1,"crm_max":100,"ai_month":0}'::jsonb
  end
$$;

create function private.user_tier(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select tier from private.billing_accounts where user_id = p_user), 'gratuit')
$$;

-- CRM : bloque seulement une hausse du nombre de fiches au-delà du plafond.
create function private.enforce_crm_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  lim integer;
  new_n integer;
  old_n integer := 0;
begin
  lim := (private.plan_limits(private.user_tier(new.user_id)) ->> 'crm_max')::integer;
  if lim is null then return new; end if;
  new_n := case when jsonb_typeof(new.payload -> 'crm') = 'array' then jsonb_array_length(new.payload -> 'crm') else 0 end;
  if new_n <= lim then return new; end if;
  if tg_op = 'UPDATE' and jsonb_typeof(old.payload -> 'crm') = 'array' then
    old_n := jsonb_array_length(old.payload -> 'crm');
  end if;
  if new_n > old_n then
    raise exception 'crm_limit' using errcode = 'PT403',
      detail = format('Le forfait Gratuit inclut %s fiches CRM. Vos fiches existantes sont conservées ; passez à Starter pour en ajouter.', lim);
  end if;
  return new;
end $$;

-- « zz » : s'exécute après le nettoyage du contenu (déclencheurs par ordre alphabétique).
create trigger workspace_states_zz_plan_limits
before insert or update on public.workspace_states
for each row execute function private.enforce_crm_limit();

-- Utilisateurs par espace : le propriétaire compte pour 1. Aucune invitation
-- n'existe encore côté application ; ce garde-fou s'applique dès qu'il y en aura.
create table private.workspace_members (
  owner_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, member_id),
  check (owner_id <> member_id)
);
revoke all on private.workspace_members from public, anon, authenticated;

create function private.enforce_seat_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  seats integer;
  used integer;
begin
  perform 1 from private.billing_accounts where user_id = new.owner_id for update;
  seats := (private.plan_limits(private.user_tier(new.owner_id)) ->> 'seats')::integer;
  select 1 + count(*) into used from private.workspace_members where owner_id = new.owner_id;
  if used + 1 > seats then
    raise exception 'seat_limit' using errcode = 'PT403',
      detail = format('Ce forfait inclut %s utilisateur(s).', seats);
  end if;
  return new;
end $$;
create trigger workspace_members_seat_limit
before insert on private.workspace_members
for each row execute function private.enforce_seat_limit();

-- Messages IA : compteur serveur par mois (heure de Toronto).
create table private.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  used integer not null default 0 check (used >= 0),
  primary key (user_id, period)
);
revoke all on private.ai_usage from public, anon, authenticated;

-- Réserve jusqu'à p_count messages ; renvoie combien sont accordés.
create function public.ai_quota_consume(p_count integer default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  lim integer;
  per text := private.toronto_period();
  cur integer;
  granted integer;
begin
  if uid is null then raise exception 'session_requise' using errcode = '28000'; end if;
  if p_count is null or p_count < 1 or p_count > 50 then raise exception 'quantite_invalide' using errcode = '22023'; end if;
  lim := (private.plan_limits(private.user_tier(uid)) ->> 'ai_month')::integer;
  insert into private.ai_usage (user_id, period) values (uid, per) on conflict do nothing;
  select used into cur from private.ai_usage where user_id = uid and period = per for update;
  granted := greatest(0, least(p_count, lim - cur));
  if granted > 0 then
    update private.ai_usage set used = used + granted where user_id = uid and period = per;
  end if;
  return jsonb_build_object('granted', granted, 'used', cur + granted, 'max', lim, 'period', per);
end $$;
revoke all on function public.ai_quota_consume(integer) from public, anon;
grant execute on function public.ai_quota_consume(integer) to authenticated;

-- Lots de crédits de packs.
create table private.credit_lots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  grant_key text not null unique references private.credit_grants(grant_key) on delete cascade,
  credits integer not null check (credits > 0),
  remaining integer not null check (remaining >= 0),
  expires_at timestamptz not null,
  expired_credits integer not null default 0 check (expired_credits >= 0),
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  check (remaining + expired_credits <= credits)
);
create index credit_lots_open on private.credit_lots (user_id, expires_at) where remaining > 0;
create index credit_lots_due on private.credit_lots (expires_at) where remaining > 0;
revoke all on private.credit_lots from public, anon, authenticated;

create or replace function private.billing_grant_pack(p_user uuid, p_key text, p_credits integer, p_offer text)
returns integer language plpgsql security definer set search_path = '' as $$
declare bal integer;
begin
  perform private.billing_ensure_account(p_user);
  select balance into bal from public.credit_accounts where user_id = p_user for update;
  insert into private.credit_grants (grant_key, user_id, reason, offer_key, requested, credits, balance_after)
  values (p_key, p_user, 'pack', p_offer, p_credits, p_credits, bal + p_credits)
  on conflict (grant_key) do nothing;
  if not found then return null; end if;
  -- Le lot d'abord : la hausse du solde ne consomme aucun lot.
  insert into private.credit_lots (user_id, grant_key, credits, remaining, expires_at)
  values (p_user, p_key, p_credits, p_credits, now() + interval '12 months');
  update public.credit_accounts set balance = bal + p_credits where user_id = p_user;
  return p_credits;
end $$;

-- Toute baisse du solde (recherche, courriel, etc.) puise d'abord dans les lots
-- les plus proches de l'expiration. Les remboursements ne recréent pas de lot :
-- les crédits rendus deviennent permanents (toujours en faveur du client).
create function private.consume_credit_lots()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  need integer := old.balance - new.balance;
  lot record;
  take integer;
begin
  if need <= 0 or coalesce(current_setting('klir.lot_expiry', true), '') = '1' then return new; end if;
  for lot in select id, remaining from private.credit_lots
              where user_id = new.user_id and remaining > 0 and expires_at > now()
              order by expires_at, id for update loop
    exit when need <= 0;
    take := least(need, lot.remaining);
    update private.credit_lots set remaining = remaining - take where id = lot.id;
    need := need - take;
  end loop;
  return new;
end $$;
create trigger credit_accounts_consume_lots
after update of balance on public.credit_accounts
for each row when (new.balance < old.balance)
execute function private.consume_credit_lots();

-- Expiration : retire le reste non utilisé des lots échus (jamais sous zéro).
create function private.expire_credit_lots(p_user uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  lot record;
  bal integer;
  cut integer;
  total integer := 0;
begin
  perform set_config('klir.lot_expiry', '1', true);
  for lot in select l.id, l.user_id, l.remaining from private.credit_lots l
              where l.remaining > 0 and l.expires_at <= now()
                and (p_user is null or l.user_id = p_user)
              order by l.user_id, l.expires_at, l.id for update loop
    select balance into bal from public.credit_accounts where user_id = lot.user_id for update;
    cut := least(lot.remaining, greatest(coalesce(bal, 0), 0));
    if cut > 0 then
      update public.credit_accounts set balance = balance - cut where user_id = lot.user_id;
    end if;
    update private.credit_lots set expired_credits = expired_credits + cut, remaining = 0, expired_at = now() where id = lot.id;
    total := total + cut;
  end loop;
  perform set_config('klir.lot_expiry', '', true);
  return total;
end $$;

revoke all on function private.plan_limits(text), private.user_tier(uuid), private.enforce_crm_limit(),
  private.enforce_seat_limit(), private.billing_grant_pack(uuid, text, integer, text),
  private.consume_credit_lots(), private.expire_credit_lots(uuid)
  from public, anon, authenticated;

-- Lecture navigateur : limites du forfait, usage, lots de packs.
create function public.plan_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  t text;
  lim jsonb;
  crm_n integer;
  ai_n integer;
  seats_n integer;
  lots jsonb;
begin
  if uid is null then raise exception 'session_requise' using errcode = '28000'; end if;
  perform private.expire_credit_lots(uid);
  t := private.user_tier(uid);
  lim := private.plan_limits(t);
  select case when jsonb_typeof(payload -> 'crm') = 'array' then jsonb_array_length(payload -> 'crm') else 0 end
    into crm_n from public.workspace_states where user_id = uid;
  select used into ai_n from private.ai_usage where user_id = uid and period = private.toronto_period();
  select 1 + count(*) into seats_n from private.workspace_members where owner_id = uid;
  select coalesce(jsonb_agg(jsonb_build_object('credits', credits, 'remaining', remaining, 'expires_at', expires_at) order by expires_at), '[]'::jsonb)
    into lots from private.credit_lots where user_id = uid and remaining > 0;
  return jsonb_build_object(
    'tier', t,
    'seats', jsonb_build_object('used', seats_n, 'max', lim -> 'seats'),
    'crm', jsonb_build_object('used', coalesce(crm_n, 0), 'max', lim -> 'crm_max'),
    'ai', jsonb_build_object('used', coalesce(ai_n, 0), 'max', lim -> 'ai_month', 'period', private.toronto_period()),
    'pack_lots', lots);
end $$;
revoke all on function public.plan_status() from public, anon;
grant execute on function public.plan_status() to authenticated;

-- Solde affiché : lots échus retirés avant lecture.
create or replace function public.billing_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  acc private.billing_accounts%rowtype;
  st private.billing_settings%rowtype;
  bal integer;
  offers jsonb := '[]'::jsonb;
  alloc integer;
begin
  if uid is null then raise exception 'session_requise'; end if;
  perform private.expire_credit_lots(uid);
  perform private.billing_refill(uid);
  select * into acc from private.billing_accounts where user_id = uid;
  select * into st from private.billing_settings where id;
  select balance into bal from public.credit_accounts where user_id = uid;
  select credits into alloc from private.billing_offers where offer_key = acc.offer_key and mode = coalesce(st.mode, 'test');
  if coalesce(st.checkout_enabled, false) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'offer', o.offer_key, 'tier', o.tier, 'kind', o.kind, 'interval', o.billing_interval,
      'amount_minor', o.amount_minor, 'credits', o.credits, 'url', o.payment_link_url) order by o.amount_minor), '[]'::jsonb)
      into offers from private.billing_offers o where o.mode = st.mode;
  end if;
  return jsonb_build_object(
    'tier', acc.tier,
    'offer', acc.offer_key,
    'status', acc.subscription_status,
    'cancel_at_period_end', acc.cancel_at_period_end,
    'current_period_end', acc.current_period_end,
    'monthly_credits', case when acc.tier = 'gratuit' then 50 else alloc end,
    'next_refill_at', acc.next_refill_at,
    'balance', bal,
    'mode', coalesce(st.mode, 'test'),
    'checkout_enabled', coalesce(st.checkout_enabled, false),
    'portal_url', case when coalesce(st.checkout_enabled, false) then st.portal_url end,
    'offers', offers);
end $$;

-- Tâche quotidienne si pg_cron est présent (sinon : expiration paresseuse via plan_status).
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    execute $c$select cron.schedule('klir-expire-credit-lots', '17 9 * * *', 'select private.expire_credit_lots()')$c$;
  end if;
end $$;
