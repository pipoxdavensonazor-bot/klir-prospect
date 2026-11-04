\set ON_ERROR_STOP on
-- Completely synthetic; not the Supabase Auth schema.
create role klir_socket_fixture nologin nosuperuser nobypassrls;
create schema auth;
create table auth.users(id uuid primary key);
insert into auth.users values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
create table public.workspace_states(user_id uuid primary key references auth.users, payload jsonb not null);
insert into public.workspace_states values
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','{"crm":[{"name":"Synthetic A","note":"fiction","next_action":"2030-01-01"}]}'),
 ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','{"crm":[{"name":"Synthetic B"}]}');
alter table public.workspace_states enable row level security;
alter table public.workspace_states force row level security;
create policy fixture_owner on public.workspace_states to klir_socket_fixture
 using(user_id = current_setting('klir.fixture_user')::uuid)
 with check(user_id = current_setting('klir.fixture_user')::uuid);
grant usage on schema public to klir_socket_fixture;
grant select,insert,update on public.workspace_states to klir_socket_fixture;
create table public.credit_accounts(user_id uuid primary key references auth.users,balance integer not null check(balance>=0));
insert into public.credit_accounts values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',191),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',200);
create table public.credit_receipts(user_id uuid references auth.users,receipt text,amount integer,primary key(user_id,receipt));
insert into public.credit_receipts values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','synthetic_receipt',9);
