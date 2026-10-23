# Recette du pilote KlirProspect

## Décision du 22 octobre 2026

Prix, devise, durée, crédits inclus, support et contact de confidentialité : **à définir**, selon la décision du propriétaire. L'achat reste fermé. Aucun abonnement, encaissement ou recrutement de clients n'est déclenché par cette livraison.

Le guide public `#/guide` explique la première recherche, les limites de la source, les crédits, le CRM et l'export. Il ne remplace pas les conditions de vente ni une politique de confidentialité.

## État vérifiable

| Domaine | Preuve disponible | Ce qui reste à faire |
|---|---|---|
| Corrections de recherche | Intégrées dans le code ; tests avec source et registre simulés | Recette sur une prévisualisation connectée à la base de test |
| Compte, historique, crédits | Tests locaux, dont migrations et RLS dans PGlite | Connexion réelle, deux comptes et appels directs à la base distante |
| Export | Tests de sélection, accents, neutralisation des formules et attribution/licence OSM dans CSV et Excel | Export après recherche réelle et contrôle du fichier reçu |
| Téléphone et bureau | Test Chrome de navigation sur 360, 390, 412, 430, 768, 1280 et 1440 px | Refaire la recette sur la prévisualisation publiée |
| Clés navigateur | Le build refuse les clés privées modernes et les JWT service_role avant config.js | Configurer uniquement les clés publiques sur les builds appropriés |
| Cloudflare | Prévisualisation de codex/pilot-readiness publiée ; commit fb36980 et environnement preview confirmés sur #/version | Configurer la base de test puis exécuter la recette réelle |
| Commercialisation | Achat fermé | Offre, mentions, confidentialité, support, facturation et validation des pilotes |

La revue a reproduit un dépassement du quota dans l'ancien schéma : onze réservations ouvertes pouvaient être confirmées. La migration `20261022130000_enforce_reserved_search_quota.sql` corrige les nouvelles réservations et protège la confirmation des anciennes réservations excédentaires. Deux tests de régression passent localement ; cette migration doit être appliquée à la base de test, puis vérifiée avant toute publication de production. Les réservations restées ouvertes doivent être réconciliées ; elles occupent une place tant qu'elles ne sont pas confirmées ou libérées.

Le build Cloudflare `b8081d32-df97-430b-b46c-145106ba5ddd` consulté le 22 octobre relance encore `03ed079`. Il échoue pendant l'installation, car la configuration publique Supabase ne peut pas être récupérée. **Réessayer ce build ne teste pas le code corrigé.** Ne pas déclarer la synchronisation Cloudflare réussie sur cette base.

La branche de cette livraison déclenche bien ses propres builds : `5909ca3b-6ac9-4c0c-9f62-ccaccb9324a2` a publié `e24a570` sur `https://codex-pilot-readiness.klirprospect.klirline.ca/`. La page `#/version` confirme `preview` et « base non configurée ». Accueil, guide, démonstration et devis ont été parcourus : 30 restaurants à Laval donnent un maximum de 30 et 8 crédits ; le passage à 20 dans les paramètres avancés affiche 7 crédits, même après fermeture du panneau. Aucun appel réel à OpenStreetMap ni débit distant n'est validé par ce parcours.

Le job GitHub `validate` définit désormais `KLIR_ENV=preview` dès `npm ci`. La validation ne récupère donc plus sa configuration sur le site public. Les environnements de contrôle `ci` n'empruntent pas non plus la configuration de production.

## Avant la recette distante

1. Vérifier que le nouveau commit est servi par la prévisualisation. Le build de branche est opérationnel ; une confirmation GitHub reste affichée pour gérer l'installation, mais n'a pas été nécessaire pour publier cette branche.
2. Utiliser une branche de prévisualisation et une base de test distincte. La référence historique `pwakjxjjxswdjsapsbxn` est inaccessible au compte connecté ; son propriétaire doit confirmer son accès ou désigner un autre projet de test. Ne pas utiliser les projets Core visibles ni connecter les essais à la production.
3. Définir `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY` sur le build de prévisualisation. Les clés privées restent hors du build statique.
4. Vérifier les URL de redirection Auth et l'origine autorisée de `delete-account` pour cette prévisualisation. Vérifier la restriction du pilote, notamment Cloudflare Access si retenu ; elle n’est pas actuellement prouvée. Tester toutes les adresses publiques et alternatives, et les accès directs aux services.
5. Vérifier `#/version` : commit testé, environnement preview et hôte de la base de test. Garder la référence de la version de production précédente pour un retour arrière.

## Trois recherches réelles

À effectuer depuis un compte de test autorisé, puis compléter les cases avec les résultats observés. Aucune ligne ci-dessous n'est présentée comme exécutée.

| Cas | Paramètres | Durée / état | Fiches utiles / doublons | Crédits avant / après | Export / historique |
|---|---|---|---|---|---|
| A | Montréal, restauration, maximum 10 | À relever | À relever | À relever | À relever |
| B | Laval, construction, maximum 30 | À relever | À relever | À relever | À relever |
| C | Québec, santé, maximum 40 | À relever | À relever | À relever | À relever |

Pour chaque cas : comparer formulaire, récapitulatif, réservation, source appelée et historique. Enregistrer deux fiches utiles, retirer une sélection, ajouter un lead, une note et une prochaine action datée. Préparer un brouillon sans l'envoyer. Exporter la sélection, vérifier noms, accents, coordonnées manquantes, attribution et licence. Se déconnecter, puis retrouver le travail sur une nouvelle session du même compte.

Rejouer les cas de résultat vide, partiel, erreur, double clic et solde insuffisant sur la base de test. Attendre la résolution de la réservation avant de comparer le solde et le quota. Une collecte complète avec fiches confirme le débit ; les autres états doivent libérer la réservation. Conserver les identifiants de réservation pour diagnostiquer un écart.

## Isolation et exploitation

- Avec les comptes A et B, vérifier que B ne peut ni lire ni modifier le workspace, les notes et les crédits de A, y compris via des requêtes directes sous la session de B.
- Vérifier l'accès anonyme, la déconnexion, la récupération du mot de passe et la conservation après reconnexion.
- Tester la suppression uniquement sur un compte de test explicitement désigné comme jetable et autorisé à supprimer.
- Tester sauvegarde et restauration sur une copie isolée ; ne pas restaurer des données de test dans la production.
- Préparer une procédure d'incident : suspendre le parcours affecté, conserver les preuves sans secrets, identifier les comptes concernés, corriger, vérifier et documenter le rétablissement. Définir un responsable avant le pilote payant.

## Démonstration accompagnée de 15 minutes

1. Minutes 0–3 : comprendre le client visé et sa méthode de prospection actuelle.
2. Minutes 3–7 : choisir une recherche, vérifier le périmètre et lire des fiches réelles.
3. Minutes 7–11 : sélectionner, enregistrer une note et préparer une prochaine action.
4. Minutes 11–13 : exporter et expliquer crédits, limites et brouillons.
5. Minutes 13–15 : relever la valeur perçue, les difficultés et les conditions d'un pilote, sans annoncer de prix encore indéfini.

Invitations et messages externes nécessitent une demande explicite du propriétaire. Recruter cinq entreprises n'est pas une action effectuée ici.

Pour chaque démonstration, relever : première recherche terminée, fiches jugées utiles, difficultés, retour d'utilisation, intérêt pour le pilote et temps de support. Une intention de payer ne compte pas comme un paiement.

## Conditions de passage

**Démonstration** : parcours réellement présenté reproductible et limites expliquées.

**Pilote payant** : recette distante terminée, comptes isolés, règles et contacts publiés, offre approuvée, facturation et support prêts.

**Abonnement public** : pilotes concluants, paiement/échec/renouvellement/annulation testés et droits attribués côté serveur ; surveillance, restauration et procédure d'incident opérationnelles.

## Dernière preuve publiée

Le commit fb3698019659f59dc7faeaf46f65c37975db3797 passe la CI GitHub (run 39872470078) et le build Cloudflare 7608bd9a-7c2b-4581-960f-c0053bf0a3e2. La page Version confirme ce commit, preview et base non configurée. Les 84 tests locaux passent, sans échec ni test ignoré. Le contrôle Supabase Preview est ignoré car aucune branche Supabase n’est associée.
