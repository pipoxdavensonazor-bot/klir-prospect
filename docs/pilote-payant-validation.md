# Validation avant pilote payant — corrections et limites

23 octobre 2026, heure de Toronto. Branche `codex/pilot-readiness`, PR #21 en brouillon. Départ propre à `b218623`, travaux précédents préservés. Achat fermé, aucune fusion, aucune production, aucune nouvelle source/zone/secteur ni benchmark général.

## Résultat technique

- Faux Excel HTML/.xls retiré : CSV UTF-8 uniquement et libellé explicite. Aucun nouveau prestataire ni dépendance. Même périmètre exporté (résultats ou sélection explicite), 42 colonnes prospects / 48 CRM, champs vides, accents, réserves, sources/IDs/releases/licences conservés. Téléphones préfixés d’une apostrophe dans le CSV pour préserver le texte, dont zéro initial ; importer la colonne comme texte dans le tableur. Ce préfixe n’altère pas la valeur source dans la fiche/provenance. Données externes neutralisées contre les formules.
- Révision serveur de l’espace et écriture conditionnelle : un second enregistrement obsolète est refusé, pas fusionné arbitrairement. Accès direct d’écriture révoqué sur Test ; le client de prévisualisation utilise `workspace_save`. Une reprise de contenu identique ne crée pas une deuxième écriture. Erreur de conflit `PT409`, sans les reprises automatiques déclenchées par un code de sérialisation `40001`.
- Conflit ou limite : avertissement visible sur les pages du compte, copie locale/outbox conservée, téléchargement JSON de récupération. Pas de reprise automatique d’un conflit ou dépassement, pas de rebasage silencieux après reconnexion. La resynchronisation réessaie d’abord l’envoi en attente avec son ancienne révision ; elle ne doit pas remplacer la version d’une autre session.
- Limite serveur 2 097 152 octets inchangée. L’état trop gros reste en mémoire et sa file locale est conservée si le stockage de l’onglet le permet. Si le navigateur refuse lui aussi le stockage, télécharger avant fermeture : aucune garantie de persistance après fermeture dans ce cas. Pas d’augmentation cachée du quota.
- Initialisation tardive du formulaire de connexion : correction ciblée pour ne pas réinitialiser les champs lors d’un événement anonyme après le démarrage. Observation lors du contrôle bureau ; pas une fonctionnalité nouvelle.

Résolution minimale d’un conflit : ne pas fermer l’onglet perdant ; télécharger sa copie JSON privée, garder la version serveur et comparer les notes/actions. Dans une session fraîche, reporter explicitement les changements encore souhaités après revue, en conservant les deux copies tant que la résolution n’est pas confirmée. Aucun outil de fusion collaborative générale ou de remplacement automatique ajouté. Une révision globale peut produire un conflit même pour des modifications sans lien ; ce compromis est explicite.

## Preuves séparées

[Android](android-preuves.md) distingue déclaration du propriétaire sur Samsung S24 FE/Chrome, absence de capture Android jointe, et contrôles automatisés. Les nouvelles corrections ne sont pas déclarées retestées sur ce téléphone. Aucune séance U1–U5 réalisée ; publications LinkedIn/Lounge seulement déclarées faites, pas de nouvel envoi.

[Concurrence hébergée](benchmark-overture/workspace-cas-hosted.json) : deux vraies sessions Auth du même compte QA jetable, deux appels concurrents, une écriture acceptée et une refusée en HTTP 409, note/action gagnantes conservées ; reprise identique sans mutation ; payload trop grand refusé sans mutation ; tentative de PATCH direct refusée ; fixture rétablie exactement. Aucun compte utilisateur normal modifié par cet outil.

Échec initial conservé dans le bilan : première tentative hébergée expirée parce que `40001` était repris par l’API ; non comptée comme réussite. La seule action/note de fixture connue a été annulée avec contrôle de version, puis le test a été repris avec `PT409` et a réussi. Voir [Supabase : reprises de 40001 et code PT409](https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions).

[Stockage mesuré](benchmark-overture/paid-storage.json) : 257 365 683 octets, +81 920 depuis 257 283 763 ; pas de copie/import supplémentaire. Relations et marges détaillées dans [exploitation](exploitation-pilote-payant.md). Aucun octet physique récupérable précisément mesuré, aucune donnée/preuve supprimée.

## Tests et commandes réellement exécutés

| Contrôle | Résultat |
|---|---|
| `npm.cmd run check` (syntaxe, tests, construction) | 95 réussis, 0 échoué, 0 ignoré sur la campagne locale finale ; Chrome couvre plusieurs formats. |
| `node --test test/workspace-concurrency.test.mjs` | Révision, note/action concurrentes, refus de dépassement, idempotence et isolation réussis sur base locale isolée PGlite. |
| `node --test test/commercial-validation.test.mjs test/store-session.test.mjs` | 16 réussis : CSV, formules, réserves, téléphone texte, file de conflit et conservation après dépassement. |
| `node tools/verify-workspace-cas.mjs` | Première tentative : expiration, corrigée ; campagne finale hébergée réussie, fixture restaurée. |
| `python tools/recovery/backup_restore.py preflight --directory ../verification/independent-backup-pending` | Précontrôle exécuté ; accès/outils/cible manquants, aucune sauvegarde/restauration effectuée. |
| Lecture SQL `storage-inventory.sql` et recherche de `pgstattuple_approx` | Inventaire mesuré ; fonction d’analyse physique absente, aucune extension installée. |
| `docker info --format '{{.ServerVersion}}'` | Pas de version reçue avant interruption ; moteur opérationnel non confirmé. |
| Vérification de syntaxe du script Python par `ast.parse` | Réussie ; ne vaut pas exécution de sauvegarde/restauration. |
| `git diff --check`, commit et `git push origin codex/pilot-readiness` | Exécutés ; aucun push main. |

Migrations appliquées seulement à Supabase Test : `20261024030000_workspace_compare_and_swap.sql` et `20261024040000_workspace_conflict_http.sql`. La CI « Supabase Preview » est ignorée car ce projet Test indépendant n’est pas une branche Supabase de la PR ; les essais hébergés ci-dessus sont distincts de ce contrôle CI.

Ouverture réelle dans un tableur : **non exécutée** à cette étape. Excel est installé à l’emplacement Office16 ; aucune session Codex Document Control Excel n’est connectée, et le contrôle natif n’est pas disponible dans cette session. Les lectures CSV programmatiques ne sont pas présentées comme une ouverture Excel. Aucun fichier .xlsx proposé ou faussement validé.

## Sauvegarde/restauration et exploitation

[Procédure complète](restauration-complete-procedure.md), scripts sous `tools/recovery/` : inventaire Auth/espaces/notes/historiques/catalogue/revues/crédits/reçus, archive indépendante chiffrée prévue, barrière source Test / cible localhost vide, comparaison des empreintes et réconciliation. CLI Supabase, psql et age absents ; connexions PostgreSQL et cible isolée non configurées. Aucun dump indépendant ni répétition complète exécuté. Pas de réinitialisation du Test de l’utilisateur ni de changement de mot de passe.

Préparer les outils et l’environnement puis répéter la restauration reste indispensable avant paiement. Vérifier ensuite vraie connexion Auth, droits de deux comptes, suivis et reçus restaurés, absence de double débit, RPO/RTO observés. Pas de délai garanti inventé.

[Exploitation actuelle](exploitation-pilote-payant.md) : maintenance manuelle, responsabilités par rôle, seuils conservateurs 300/400/450 Mo, règles de conservation et procédure pour une future release. Scripts préparés ; pas de planification ou alertes nouvelles activées. Import encore épinglé ; véritable release amont nouvelle non testée. Aucun service payant souscrit.

## Décisions et critères encore ouverts

| Point | Statut / décision attendue |
|---|---|
| Export natif Excel | Retiré, CSV disponible ; ouverture réelle du CSV dans le tableur reste à vérifier. Aucun .xlsx ajouté. |
| Concurrence | Protection minimale et test API réussis ; revue humaine des conflits nécessaire, pas un éditeur collaboratif. |
| Sauvegarde indépendante et restauration complète | Bloquées par accès/outils/cible. Désigner emplacement chiffré, clé indépendante, responsable/fréquence et fenêtre ; exécuter la répétition avant vente. |
| Actualisation véritable de release / exploitation | Migration de release approuvée et contrôle du pic d’espace à préparer lors d’une version choisie ; automatisation d’exploitation pas activée. |
| Conditions commerciales | [Brouillon](offre-pilote-brouillon.md) prêt ; prix/devise/taxes, durée, crédits, renouvellement, annulation/remboursement, support et contact de confidentialité restent « À définir ». Validation juridique et choix de facturation/admission nécessaires. Aucun nouvel abonnement ou prestataire intégré. |
| Cinq séances | Participants, comptes et créneaux non confirmés. Mesurer utilité des candidats, suivi retrouvé, aide, difficultés et intention de réutilisation avant de conclure sur l’offre. Aucun résultat inventé. |

**Verdict : correctifs techniques ciblés livrables en prévisualisation, produit pas déclaré prêt à vendre.** L’achat reste fermé. Aucun prospect contacté, aucune fusion ni production.
