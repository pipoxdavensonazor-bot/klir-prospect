# Sauvegarde indépendante et restauration complète — procédure préparée

**État : non exécutée.** Cette livraison prépare les scripts ; elle ne prétend pas avoir créé une sauvegarde indépendante ni restauré Supabase/Auth. Le retour du catalogue déjà mesuré ne couvre pas cette procédure. Ne jamais réinitialiser le projet Test utilisé par le propriétaire, ni utiliser la production comme cible.

## Inventaire à protéger

| Ensemble | Protection prévue | Limites distinctes |
|---|---|---|
| Auth : utilisateurs, identités, hachages et relations | Dump des données Auth et contrôle des tables `auth.users`/`auth.identities` dans l’archive. Inventaire par table/empreinte. | Un export de liste d’utilisateurs par l’API admin ne remplace pas la base Auth. Configurations fournisseur, SMTP, redirections, secrets de signature/chiffrement et sessions nécessitent la procédure propre à Supabase. |
| Profils, espaces et CRM | `public.profiles`, `workspace_states`, révision, notes, actions/dates, historiques et objets originaux stockés dans les espaces. | Conserver les copies locales non encore synchronisées séparément ; elles ne sont pas dans un dump serveur. |
| Catalogue et annotations | Tables privées actives, settings, copies de catalogue, revues et preuves/licences/versions. | Ne pas supprimer les copies conservées pour accélérer la sauvegarde. |
| Crédits et reçus | Accounts, holds, receipts, operations et corps de résultats encore conservés. | Comparer exactement au manifeste ; les anciens resets de comptes QA rendent incorrecte une règle naïve « solde = 200 moins reçus ». |
| Droits et fonctions | Rôles, schémas applicatifs, RLS forcée, fonctions serveur, triggers Auth personnalisés et historique des migrations s’il existe. | Une base PostgreSQL vide n’est pas une pile Supabase/Auth opérationnelle. |
| Hors base | Code/commit, configuration Auth/URL, secrets dans stockage séparé, fonctions Edge (dont suppression de compte), DNS/hébergement ; objets Storage si présents. | Les dumps ne recréent pas les services ni les objets Storage. Aucun secret dans Git, les rapports ou les captures. |

## Outils et barrières

`tools/recovery/backup_restore.py` : `preflight` par défaut explicite, `backup` depuis le seul projet Test nommé et `restore` vers **localhost uniquement**. Refus de restaurer vers Test ou production ; pas de `db reset`. Refus d’une cible contenant des comptes/app. Archive chiffrée avec age, empreintes SHA-256 des fichiers et inventaire des tables. Les sorties et clés doivent être hors dépôt ; utiliser un support privé chiffré pour le staging et un emplacement indépendant pour l’archive, avec identité age séparée.

Prérequis : Supabase CLI, Docker fonctionnel, psql, age ; accès PostgreSQL Test en variable d’environnement privée `KLIR_TEST_DB_URL` ; destinataire public age `KLIR_BACKUP_AGE_RECIPIENT`. La restauration utilise une autre connexion `KLIR_RECOVERY_DB_URL` vers une pile Supabase locale vide et une identité de déchiffrement hors dépôt. Ne pas coller ces secrets dans le chat ; ne pas réinitialiser un mot de passe existant pour cette livraison.

Contrôle réellement exécuté ici : CLI Supabase, psql et age introuvables ; binaire Docker présent, mais `docker info` n’a pas fourni de version avant interruption. Connexions source et cible non configurées. Aucune pile de restauration isolée utilisable n’est confirmée. **Blocages précis : outils manquants, accès PostgreSQL de sauvegarde, destination chiffrée/clé indépendante à désigner, pile isolée locale à rendre disponible.** Aucun service payant souscrit pour les contourner.

## Exécution à préparer avec le responsable

1. Convenir d’une fenêtre sans écritures ni changements de schéma ; ne pas interrompre automatiquement le Test partagé. Inventorier avant export, versions Postgres/Supabase et extensions, usage de Vault/chiffrement, hooks Auth, fonctions Edge et Storage.
2. Exécuter le précontrôle. Après fourniture sécurisée des accès, lancer `backup` avec un dossier privé neuf et `--quiet-window-confirmed`. Le script exporte rôles, schémas applicatifs, données incluant Auth, hooks et migrations si présentes. Il refuse une archive sans Auth ou si les empreintes source ont changé entre avant/après.
3. Conserver l’archive chiffrée sur un support indépendant et vérifier sa lecture/déchiffrement avec une clé distincte. Le script retire seulement ses propres fichiers temporaires après chiffrement réussi ; en cas d’erreur, conserver le staging en privé pour diagnostic, sans le publier.
4. Préparer une pile Supabase locale vide avec version Postgres et extensions compatibles. SMTP sortant désactivé, réception locale seulement ; aucune notification à un utilisateur réel. Configurer les services Auth et fonctions Edge nécessaires dans cet environnement isolé.
5. Lancer `restore --empty-local-confirmed` avec archive, identité hors dépôt et dossier privé neuf. Restauration transactionnelle, arrêt sur erreur ; aucun écrasement d’une base existante. Le script compare les tables/empreintes et lance `reconcile.sql`. Une divergence arrête la validation ; ne pas la contourner en désactivant arbitrairement la RLS.
6. Vérifier réellement deux comptes dans Auth et l’application isolés : reconnexion, absence d’accès croisé, notes/actions/historiques, révisions et tailles, soldes/reçus/holds comparés au manifeste. Rejouer un reçu terminé et confirmer l’absence de nouveau débit/quota ; tester une réservation expirée libérée une fois. Les tests de la source ne valent pas ces tests de la restauration.
7. Vérifier hooks d’inscription/suppression, droits des fonctions, liens de redirection et désactivation des achats. Les anciennes sessions peuvent exiger une reconnexion lorsque les clés du nouvel environnement diffèrent. Ne pas copier les URL ou clés de restauration dans le site de production.
8. Consigner début/fin de sauvegarde, transfert, restauration, contrôles Auth et reprise applicative. RPO observé = écart avec la dernière sauvegarde indépendante vérifiée ; RTO observé = durée jusqu’au parcours applicatif restauré et contrôlé. **Aucun RPO/RTO chiffré garanti tant que cet exercice n’est pas réalisé.** Objectifs et fréquence finale à définir avant pilote payant.

Commandes préparées (ne contiennent pas de secrets) :

```powershell
python tools/recovery/backup_restore.py preflight --directory <dossier-prive-neuf>
python tools/recovery/backup_restore.py backup --directory <dossier-prive-neuf> --quiet-window-confirmed
python tools/recovery/backup_restore.py restore --directory <dossier-prive-neuf> --archive <archive.age> --identity <cle-privee-age> --empty-local-confirmed
```

Automatisation : scripts préparés, aucune tâche de sauvegarde/alerte activée. Avant paiement, désigner le responsable, fréquence, emplacement/chiffrement, clé de récupération séparée, procédure d’accès et durée de conservation des archives. La vérification complète reste bloquante pour le pilote payant.

Références officielles consultées : [Supabase — sauvegarde/restauration CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [restauration vers une pile auto-hébergée et limites Auth](https://supabase.com/docs/guides/self-hosting/restore-from-platform), [restauration locale d’une sauvegarde téléchargée](https://supabase.com/docs/guides/local-development/restoring-downloaded-backup). Les scripts sont préparés à partir de cette méthode ; leur précontrôle et syntaxe ne constituent pas une répétition de restauration.
