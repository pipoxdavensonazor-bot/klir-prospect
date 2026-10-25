# Préparation locale de restauration — 24 octobre 2026

## Mise à jour du 25 octobre

Le serveur Docker répond désormais réellement : version **29.8.0**, type **linux**, Docker Desktop. Le blocage WSL décrit ci-dessous est historique. Le premier lancement de la cible a révélé une mauvaise interprétation des arguments lors de la résolution de `supabase` par le PATH ; le lanceur invoque maintenant explicitement le binaire épinglé déjà installé. Les téléchargements des images officielles ont démarré. Le démarrage des services et la restauration ne sont pas déduits de cette réponse Docker : ils restent à contrôler séparément. Aucun accès PostgreSQL Test, support indépendant ou identité age réelle n'est fourni par cette seule étape.

Les neuf images ont ensuite été téléchargées et PostgreSQL local a atteint `healthy`. **La pile a été arrêtée sans suppression des volumes** : malgré l'option de réseau `host_binding_ipv4=127.0.0.1`, Docker inspect a rapporté le port 55432 publié sur `0.0.0.0` et `::`. Le garde-fou du lanceur refuse cette exposition. Aucune requête de vérification des données ni import n'a été exécuté après ce refus. Il reste à imposer des liaisons explicites `127.0.0.1` pour tous les ports publiés (et vérifier leur application réelle) avant toute restauration ; changer uniquement l'URL cliente vers localhost ne suffit pas. Les paramètres PostgreSQL et de stockage indépendant ne sont toujours pas enregistrés dans les emplacements contrôlés. Un assistant de saisie locale chiffrée, conservé hors dépôt, est préparé mais non exécuté avec des secrets réels.

**Outils installés, cible configurée mais non démarrée. Aucune sauvegarde réelle, aucune restauration ni connexion PostgreSQL distante exécutée.** Supabase Test et production inchangés ; achat fermé, PR en brouillon.

## Réalisé

Dossier privé hors dépôt : `../verification/recovery-preparation/` (à côté de `klir-prospect`). ACL Windows restreinte au compte local courant et SYSTEM ; aucun outil, clé ou dump ajouté à Git. Installation portable, activation limitée au terminal par `enable-tools.ps1`, sans changement du PATH système.

| Outil | Version exécutée | Origine et contrôle |
|---|---|---|
| Supabase CLI | 2.122.0 | Release officielle supabase/cli, archive Windows amd64 ; SHA256 comparé à checksums.txt publié. |
| psql | PostgreSQL 18.6 | Archive EDB Windows x64, lien proposé par PostgreSQL.org ; SHA256 local consigné, pas de signature indépendante de cette archive validée. Client seulement, aucun service PostgreSQL Windows installé. |
| age | 1.3.2 | Release officielle FiloSottile/age ; SHA256 comparé au digest de l’asset GitHub. |

Archives, versions, tailles et empreintes sont consignées dans `installation-manifest.json` privé. Un chiffrement puis déchiffrement age d’un texte **synthétique** est réussi et comparé octet par octet. Sa clé reste dans `synthetic-crypto-check/` et n’est ni la clé d’une sauvegarde réelle ni une clé indépendante.

`supabase init` a créé `isolated/supabase/config.toml` : identifiant `klir-recovery-isolated-20261024`, API 55421, PostgreSQL 55432, shadow 55430, Studio 55423, mail local 55424. Seeds, analytics et Edge runtime désactivés. Aucun fichier de liaison distante, aucune migration applicative ou copie du catalogue injectée. PostgreSQL serveur 17 est la valeur préparée ; **confirmer la version source et les extensions avant restauration**, sans supposer leur compatibilité à partir du client psql 18.6.

`tools/recovery/start-isolated.ps1 -PrivateRoot <dossier-prive>` prépare un réseau Docker dédié avec publication par défaut sur 127.0.0.1, refuse un réseau non identifié ou partagé avec un autre projet, consigne les sorties CLI en privé et contrôle les ports effectivement publiés. Une exposition hors loopback arrête seulement cette pile en conservant ses volumes. Aucun reset, suppression de volume, liaison ou restauration dans ce lanceur. La configuration réseau et les services Auth/Storage restent **non vérifiés en fonctionnement**, car le moteur ne démarre pas.

## Blocage machine confirmé

Docker Desktop est déjà installé. `docker desktop start --detach` a été tenté ; `docker info` et `supabase start --workdir <isolated>` échouent sur le canal `dockerDesktopLinuxEngine` absent. `wsl --status` indique que **le sous-système Windows pour Linux n’est pas installé**. Le lanceur isolé s’arrête bien à cette barrière, avant création de réseau, import ou restauration.

Étape système restante : activer/installer WSL 2 suivant Microsoft/Docker, depuis un terminal administrateur ; exemple de préparation sans distribution : `wsl --install --no-distribution --no-launch`. Terminer les éventuels prérequis de virtualisation et le redémarrage Windows si demandé, puis vérifier `wsl --status` et `docker info`. Aucun redémarrage, acceptation de contrat ou modification BIOS/Windows supplémentaire effectué par l’agent. Ne pas contourner l’absence de Docker par une restauration dans Test.

## Paramètres à configurer hors dépôt

Les variables de processus, utilisateur et machine ci-dessous sont absentes ; aucun pgpass standard n’est présent. Les accès API QA existants ne constituent pas un accès PostgreSQL pour exporter Auth. Aucun mot de passe réinitialisé ou demandé dans le chat.

| Paramètre | Où et quoi configurer |
|---|---|
| `KLIR_TEST_DB_URL` | Dans le terminal privé, à partir de Supabase **KlirProspect Test pwakjxjjxswdjsapsbxn → Connect → Session pooler** : hôte exact affiché, port **5432**, base `postgres`, utilisateur `postgres.pwakjxjjxswdjsapsbxn`, mot de passe PostgreSQL existant URL-encodé, `sslmode=require`. Connexion directe autorisée seulement vers `db.pwakjxjjxswdjsapsbxn.supabase.co`. Jamais le projet de production ni le pool transactionnel 6543. |
| `KLIR_RECOVERY_DB_URL` | Après démarrage réussi, lire localement `status-private.json` ; utiliser exclusivement `127.0.0.1:55432`, base et identifiants locaux. Confirmer pile vide, zéro utilisateur et absence de `workspace_states` ; le script refuse autrement. |
| `KLIR_BACKUP_AGE_RECIPIENT` | Destinataire public `age1…` fourni par le détenteur d’une identité de récupération **indépendante**. Ne pas réutiliser la clé de démonstration synthétique. |
| Archive indépendante | Désigner un support privé indépendant de cette machine et de Supabase, l’emplacement précis et son responsable. Le dossier local de préparation n’est pas une sauvegarde indépendante. Ne transférer que l’archive chiffrée et vérifier sa lecture/déchiffrement sur le support ; aucune destination n’est configurée ou facturée. |
| Identité de récupération | Fichier privé séparé de l’archive et hors dépôt, passé à `restore --identity`. Son détenteur, emplacement sécurisé et moyen d’accès restent à désigner. |

Un modèle commenté `access-private.example.ps1` est créé dans le dossier privé. Le compléter localement, le charger dans le seul terminal de travail après `enable-tools.ps1` ; ne jamais commiter, partager ou afficher ses valeurs. Les dossiers `--directory` de backup et restore doivent être neufs et distincts.

## Vérification des scripts et reprise

Trois tests hors ligne réussis via `python tools/recovery/test_recovery.py` : source Test/TLS/port session seulement ; cible locale seulement avec refus Test/production ; archive complète refusant doublons, traversée et liens symboliques. Syntaxe Python et PowerShell vérifiée. Le script valide maintenant le destinataire age **avant** export, exige les empreintes des quatre SQL obligatoires, et sépare correctement les hooks Auth multiples par un saut de ligne SQL. Ces contrôles ne valent pas un essai de dump ou restore.

Après résolution de WSL et des paramètres : activer les outils, lancer le lanceur isolé, vérifier réellement les ports et versions, fixer une fenêtre source sans écritures, puis suivre [la procédure complète](restauration-complete-procedure.md). Ne lancer `backup --quiet-window-confirmed` qu’après confirmation réelle de cette fenêtre. Comparer les empreintes, copier/vérifier l’archive indépendante, restaurer seulement vers la pile vide et contrôler Auth avec deux comptes, isolation, CRM, crédits et récupération/rejeu des reçus. La restauration de tables seule ne suffit pas. Aucun RPO/RTO mesuré à ce stade.

Sources officielles : [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), [release CLI](https://github.com/supabase/cli/releases/tag/v2.122.0), [PostgreSQL Windows](https://www.postgresql.org/download/windows/), [EDB binaires](https://www.enterprisedb.com/download-postgresql-binaries), [age](https://github.com/FiloSottile/age/releases/tag/v1.3.2), [Docker Windows/WSL](https://docs.docker.com/desktop/setup/install/windows-install/), [liaison des ports Docker](https://docs.docker.com/engine/network/drivers/bridge/).
