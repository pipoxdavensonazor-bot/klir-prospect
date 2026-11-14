-- Correctif : l'enregistrement direct de l'espace (upsert par la session
-- authentifiée) échouait avec « permission denied for schema private », car le
-- déclencheur private.sanitize_workspace() s'exécutait avec les droits de
-- l'appelant et appelait private.strip_secrets(). On l'exécute avec les droits
-- de son propriétaire (search_path vide déjà fixé). Aucun droit sur le schéma
-- private n'est accordé à authenticated.
alter function private.sanitize_workspace() security definer;
alter function private.sanitize_workspace() set search_path = '';
revoke all on function private.sanitize_workspace() from public, anon, authenticated;
