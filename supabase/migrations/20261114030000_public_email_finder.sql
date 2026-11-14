-- Extraction des courriels publics (feu vert Philippe t120u, phase 2).
-- Sur demande seulement. Le résultat va sur la fiche du propriétaire (public.search_job_places),
-- jamais dans le catalogue partagé. Coût : 1 crédit par courriel trouvé, remboursé sinon.
-- La réservation passe par public.usage_holds (même garde-fou private.check_search_rate),
-- le règlement par private.apply_usage_outcome. Appels réservés au rôle service (fonction Edge).

alter table public.usage_holds drop constraint if exists usage_holds_label_known;
alter table public.usage_holds add constraint usage_holds_label_known
  check (label = any (array['Recherche'::text, 'Scan Radar'::text, 'Courriel'::text]));
alter table public.usage_holds drop constraint if exists usage_holds_receipt_shape;
alter table public.usage_holds add constraint usage_holds_receipt_shape
  check (receipt ~ '^(debit|radar|email)_[0-9a-f]{24}$');

alter table public.search_job_places
  add column if not exists email text,
  add column if not exists email_source text,
  add column if not exists email_found_at timestamptz,
  add column if not exists email_checked_at timestamptz;
alter table public.search_job_places drop constraint if exists search_job_places_email_chk;
alter table public.search_job_places add constraint search_job_places_email_chk
  check (email is null or (length(email) <= 254 and email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$'));
alter table public.search_job_places drop constraint if exists search_job_places_email_source_chk;
alter table public.search_job_places add constraint search_job_places_email_source_chk
  check (email_source is null or (length(email_source) <= 300 and email_source ~* '^https?://'));

-- Retraits (opt-out) : domaine de courriel ou de site à ne plus jamais extraire.
create table if not exists private.email_optouts (
  domain text primary key check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,24}$' and length(domain) <= 253),
  created_at timestamptz not null default now()
);
revoke all on table private.email_optouts from public, anon, authenticated;

create or replace function private.email_domain_opted_out(p_value text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1 from private.email_optouts o
    where lower(coalesce(p_value, '')) = o.domain
       or lower(coalesce(p_value, '')) like '%.' || o.domain
  )
$$;
revoke all on function private.email_domain_opted_out(text) from public, anon, authenticated;

-- Le règlement d'un courriel ne compte pas comme une recherche (searches_used inchangé).
CREATE OR REPLACE FUNCTION private.apply_usage_outcome(p_user uuid, p_receipt text, p_outcome text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  period text := private.toronto_period();
  account public.credit_accounts%rowtype;
  hold public.usage_holds%rowtype;
begin
  if p_user is null then
    raise exception 'session_requise';
  end if;
  if p_outcome is null or p_outcome not in ('complete', 'release') then
    raise exception 'recu_invalide';
  end if;

  select * into hold
  from public.usage_holds
  where user_id = p_user and receipt = p_receipt
  for update;

  if not found then
    raise exception 'recu_invalide';
  end if;

  select * into account
  from public.credit_accounts
  where user_id = p_user
  for update;

  if account.usage_period is distinct from period then
    update public.credit_accounts
    set usage_period = period, searches_used = 0
    where user_id = p_user
    returning * into account;
  end if;

  if p_outcome = 'complete' then
    if hold.status = 'complete' then
      return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'complete');
    end if;
    if hold.status <> 'open' then
      raise exception 'recu_invalide';
    end if;
    update public.usage_holds
    set status = 'complete'
    where user_id = p_user and receipt = p_receipt;
    if hold.label <> 'Courriel' then
      update public.credit_accounts
      set searches_used = account.searches_used + 1
      where user_id = p_user
      returning * into account;
    end if;
    insert into public.credit_receipts (user_id, receipt, amount, label)
    values (p_user, p_receipt, hold.amount, hold.label);
    return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'complete');
  end if;

  if hold.status = 'released' then
    return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'released');
  end if;
  if hold.status <> 'open' then
    raise exception 'recu_invalide';
  end if;

  update public.credit_accounts
  set balance = account.balance + hold.amount
  where user_id = p_user
  returning * into account;
  update public.usage_holds
  set status = 'released'
  where user_id = p_user and receipt = p_receipt;
  return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'released');
end;
$function$;
revoke all on function private.apply_usage_outcome(uuid, text, text) from public, anon, authenticated;

-- Début : choisit au plus 25 fiches du propriétaire avec un site, réserve 1 crédit par fiche.
-- p_refs : [{"id": uuid}] ou [{"job_id": uuid, "name": text}] (fiches anciennes sans id local).
create or replace function public.email_finder_begin(p_user uuid, p_receipt text, p_refs jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
set statement_timeout to '5s'
set lock_timeout to '2s'
as $$
declare
  period text := private.toronto_period();
  account public.credit_accounts%rowtype;
  hold public.usage_holds%rowtype;
  stale record;
  targets jsonb;
  done jsonb;
  n integer;
begin
  if p_user is null then raise exception 'session_requise'; end if;
  if p_receipt is null or p_receipt !~ '^email_[0-9a-f]{24}$' then raise exception 'recu_invalide'; end if;
  if p_refs is null or jsonb_typeof(p_refs) <> 'array' or jsonb_array_length(p_refs) < 1 or jsonb_array_length(p_refs) > 25 then
    raise exception 'selection_invalide';
  end if;

  select * into hold from public.usage_holds where user_id = p_user and receipt = p_receipt;
  if found then raise exception 'recu_invalide'; end if;

  -- Réservations de courriel restées ouvertes (fonction interrompue) : remboursées.
  for stale in
    select receipt from public.usage_holds
    where user_id = p_user and label = 'Courriel' and status = 'open' and created_at < now() - interval '5 minutes'
  loop
    perform private.apply_usage_outcome(p_user, stale.receipt, 'release');
  end loop;

  with refs as (
    select
      case when r ? 'id' and (r->>'id') ~ '^[0-9a-f-]{36}$' then (r->>'id')::uuid end as id,
      case when r ? 'job_id' and (r->>'job_id') ~ '^[0-9a-f-]{36}$' then (r->>'job_id')::uuid end as job_id,
      left(r->>'name', 160) as name
    from jsonb_array_elements(p_refs) r
  ), matched as (
    select distinct on (p.id) p.id, p.job_id, p.name, p.website, p.email, p.email_source, p.email_checked_at
    from refs
    join public.search_job_places p
      on p.user_id = p_user
     and ((refs.id is not null and p.id = refs.id)
          or (refs.id is null and refs.job_id is not null and p.job_id = refs.job_id and p.name = refs.name))
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('id', id, 'job_id', job_id, 'name', name, 'website', website)) filter (
      where website is not null and email_checked_at is null), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('id', id, 'job_id', job_id, 'name', name, 'email', email, 'source', email_source, 'checked_at', email_checked_at, 'website', website)) filter (
      where website is null or email_checked_at is not null), '[]'::jsonb)
  into targets, done
  from matched;

  n := jsonb_array_length(targets);
  if n > 25 then raise exception 'selection_invalide'; end if;
  if n = 0 then
    return jsonb_build_object('status', 'nothing', 'targets', targets, 'done', done, 'amount', 0);
  end if;

  insert into public.credit_accounts (user_id, balance, usage_period, searches_used)
  values (p_user, 200, period, 0)
  on conflict (user_id) do nothing;
  select * into account from public.credit_accounts where user_id = p_user for update;

  perform private.check_search_rate(p_user);
  if account.balance < n then raise exception 'credits_insuffisants'; end if;

  update public.credit_accounts set balance = account.balance - n where user_id = p_user returning * into account;
  insert into public.usage_holds (user_id, receipt, amount, label, status)
  values (p_user, p_receipt, n, 'Courriel', 'open');

  return jsonb_build_object('status', 'reserved', 'targets', targets, 'done', done, 'amount', n, 'balance', account.balance);
end
$$;
revoke all on function public.email_finder_begin(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.email_finder_begin(uuid, text, jsonb) to service_role;

-- Fin : enregistre les courriels trouvés sur les fiches réservées, facture 1 crédit par courriel,
-- rembourse le reste. p_results : [{"id": uuid, "email": text|null, "source": url|null}].
create or replace function public.email_finder_finish(p_user uuid, p_receipt text, p_results jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
set statement_timeout to '5s'
set lock_timeout to '2s'
as $$
declare
  hold public.usage_holds%rowtype;
  found_count integer := 0;
  item jsonb;
  v_id uuid;
  v_email text;
  v_source text;
  v_rows integer;
  outcome jsonb;
  saved jsonb := '[]'::jsonb;
begin
  if p_user is null then raise exception 'session_requise'; end if;
  select * into hold from public.usage_holds where user_id = p_user and receipt = p_receipt and label = 'Courriel' for update;
  if not found then raise exception 'recu_invalide'; end if;
  if hold.status <> 'open' then raise exception 'recu_invalide'; end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) > hold.amount then
    raise exception 'resultats_invalides';
  end if;

  for item in select * from jsonb_array_elements(p_results) loop
    if (item->>'id') !~ '^[0-9a-f-]{36}$' then continue; end if;
    v_id := (item->>'id')::uuid;
    v_email := lower(nullif(trim(item->>'email'), ''));
    v_source := nullif(trim(item->>'source'), '');
    if v_email is not null and (
         length(v_email) > 254
      or v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$'
      or private.email_domain_opted_out(split_part(v_email, '@', 2))
      or v_source is null or length(v_source) > 300 or v_source !~* '^https?://') then
      v_email := null;
    end if;
    if v_email is null then v_source := null; end if;
    update public.search_job_places p
    set email = v_email,
        email_source = v_source,
        email_found_at = case when v_email is not null then now() end,
        email_checked_at = now()
    where p.id = v_id and p.user_id = p_user and p.website is not null and p.email_checked_at is null
      and not private.email_domain_opted_out(substring(p.website from '^https?://(?:www\.)?([^/:?#]+)'));
    get diagnostics v_rows = row_count;
    if v_rows = 1 then
      saved := saved || jsonb_build_array(jsonb_build_object('id', v_id, 'email', v_email, 'source', v_source));
      if v_email is not null then found_count := found_count + 1; end if;
    end if;
  end loop;

  found_count := least(found_count, hold.amount);
  if found_count = 0 then
    outcome := private.apply_usage_outcome(p_user, p_receipt, 'release');
  else
    if found_count < hold.amount then
      update public.credit_accounts set balance = balance + (hold.amount - found_count) where user_id = p_user;
      update public.usage_holds set amount = found_count where user_id = p_user and receipt = p_receipt;
    end if;
    outcome := private.apply_usage_outcome(p_user, p_receipt, 'complete');
  end if;
  return jsonb_build_object('status', outcome->>'status', 'charged', found_count, 'refunded', hold.amount - found_count,
    'balance', (outcome->>'balance')::integer, 'saved', saved);
end
$$;
revoke all on function public.email_finder_finish(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.email_finder_finish(uuid, text, jsonb) to service_role;
