# Migration Next.js + Postgres (Klir Prospect → produit réel)

Le MVP Perchance actuel est une **maquette fonctionnelle locale** (données démo, localStorage).
Pour un vrai SaaS multi-tenant, migrer vers :

## Stack cible
Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui · API Routes · Prisma + PostgreSQL · BullMQ + Redis (jobs) · NextAuth (orgs/memberships) · LLM tool-calling (mêmes `TOOL_DEFS` que `src/app.js` : read=auto, write/external=approbation).

## Schéma SQL (extrait)
```sql
CREATE TABLE organizations(id uuid PK, name text, plan text DEFAULT 'Free');
CREATE TABLE memberships(user_id uuid, org_id uuid REFERENCES organizations, role text);
CREATE TABLE companies(id uuid PK, org_id uuid, name text, normalized_name text, domain text, website text, industry text, city text, province text, country text, phone text, public_email text, source text, source_url text, dq int, rel int, conf int, last_verified_at date);
CREATE TABLE contacts(id uuid PK, org_id uuid, company_id uuid REFERENCES companies, role text, public_email text, source text);
CREATE TABLE prospects(id uuid PK, org_id uuid, company_id uuid, status text, notes text, owner_id uuid);
CREATE TABLE searches(id uuid PK, org_id uuid, label text, params jsonb, status text, progress int);
CREATE TABLE approvals(id uuid PK, org_id uuid, tool text, payload jsonb, status text, requested_by uuid, decided_by uuid);
CREATE TABLE drafts(id uuid PK, campaign_id uuid, prospect_id uuid, text text, status text);
CREATE TABLE audit_logs(id uuid PK, org_id uuid, actor uuid, action text, entity text, at timestamptz);
CREATE INDEX ON companies(org_id, normalized_name); CREATE INDEX ON companies(org_id, domain);
-- RLS : chaque requête filtre org_id du membership ; jamais de cross-org.
```

## Correspondance MVP → cible
| MVP local | Cible |
|---|---|
| `KlirData` + `genProspects` (démo) | `SourceConnector` adapters (search/fetch/normalize/healthCheck) + file d'attente |
| `runSearch` simulé | `POST /api/prospect-searches` → job BullMQ, progression temps réel (SSE) |
| `approvals[]` localStorage | table `approvals` + gate `User→AI→Tool→Auth→Risk→Execute` |
| brouillons `drafts` + Review | ` drafts` + UI revue + envoi via provider configuré + opt-out |
| CSV/XLS blob | export serveur (ExcelJS), colonnes configurables |
| `LIMITS` Free/Pro/Business | Stripe + table `usage` mensuelle |

## Ordre
1. Auth + orgs + RLS. 2. Companies/prospects/searches CRUD + pagination. 3. 1er connecteur réel + normalizer/dedup (tests : noms similaires, même domaine, cross-org). 4. Jobs async + progression. 5. Approvals + outreach. 6. Billing.

## Comptes & accès partagé (module `src/team.js` → cible)
MVP local : annuaire `klir_directory_v1` + miroir kv, invitations par code dans le coffre du propriétaire, rôles + permissions dans `team.members`, routage d'écriture vers le coffre partagé. Limite assumée : même appareil uniquement.
Cible : `users`, `invites(code, org_id, role, expires_at, used_by)`, `memberships(user_id, org_id, role, perms jsonb)` + RLS stricte (jamais de cross-org sauf membership actif) ; chaque `guard()` MVP devient un check `can(perm)` serveur ; la révocation doit invalider les sessions (table `sessions`).
