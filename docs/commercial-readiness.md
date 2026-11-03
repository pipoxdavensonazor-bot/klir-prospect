# Préparation du pilote KlirProspect

Cette livraison corrige le parcours de préparation d'une recherche. Elle ne
constitue ni une autorisation de commercialisation ni une validation de production.
Base de travail : `bf72b5f97d39535f7c05e8da2f3989993830988a` sur `main`.

## Corrections livrées

- Quantité maximale entre 10 et 40, par défaut 40, conformément à la collecte OSM.
- Paramètres normalisés communs au formulaire, au devis, à l'appel OSM et à l'historique.
- Le texte saisi initialise les paramètres avancés. Les modifications avancées
  actualisent le récapitulatif et le tarif, même si le panneau est ensuite masqué.
- Une recherche enregistrée est relancée avec ses paramètres sauvegardés. Les
  anciennes quantités supérieures à 40 sont plafonnées avant réservation des crédits.
- Une taille absente reste absente. Une emprise de Montréal n'est pas utilisée à Laval.
- Les nombres désignant une année ou une taille d'entreprise ne sont plus pris
  automatiquement pour une quantité de prospects.
- Le tableau de bord de démonstration explique le parcours et l'absence de recherches réelles.
- Les textes publics précisent le maximum, l'absence de volume garanti et le rôle
  de préparation des suivis. Aucune donnée de démonstration ni source supplémentaire ajoutée.

## Validation automatisée réellement exécutée

Commande : `KLIR_ENV=preview npm run check`.

- Syntaxe des scripts, tests et build : succès.
- 80 tests : 79 réussis, 1 ignoré, aucun échec.
- Les 9 nouveaux tests exécutent notamment `runSearch` avec une source et un
  registre simulés : devis avancé, réservation et quantité OSM concordants,
  relance sauvegardée, plafond, solde insuffisant, partiel, vide, erreur et double clic.
- La suite existante couvre aussi les exports, les sessions et les migrations/RLS
  dans une base PGlite locale. Cela ne vérifie pas la configuration du projet distant.
- Le build de prévisualisation termine avec `environment=preview` et `supabase=absent` :
  il n'est connecté à aucune base réelle.

Le contrôle visuel responsive existant est ignoré faute de binaire Chrome. Le
téléchargement du navigateur Playwright a échoué (archive invalide) et le navigateur
distant interdit le protocole `file:` pour la copie locale. Aucun succès visuel
sur cette livraison n'est donc déclaré.

## À valider avant un pilote payant

1. Sur une prévisualisation isolée avec sa base de test, effectuer trois recherches
   représentatives. Relever durée, pertinence, doublons, coordonnées publiées,
   état de collecte et crédits. Ne jamais remplir une donnée manquante par génération.
2. Parcourir recherche → sélection → dossier/CRM → note → export. Comparer le
   récapitulatif, l'historique et les colonnes des fichiers exportés.
3. Vérifier la conservation après déconnexion et sur un autre navigateur. Avec deux
   comptes de test, vérifier l'interdiction de lire/modifier les données de l'autre.
4. Rejouer les cas de crédits avec le registre distant de test : complet, vide,
   partiel, erreur, double clic, solde insuffisant et interruption réseau.
5. Contrôler le rendu desktop et téléphone, le panneau avancé masqué/affiché,
   l'évolution du prix et les messages d'erreur. Ne pas confondre test simulé et collecte réelle.
6. Faire définir par Klirline : prix CAD, durée, prestation incluse, limites,
   renouvellement/résiliation/remboursement, canal et délai de support, contact de
   confidentialité, politique de conservation/suppression, moyen de facturation et
   lien de réservation de démonstration. Ces valeurs ne sont pas inventées dans le code.
7. Revoir les risques résiduels de `SECURITY.md` et les réglages réels du projet cible.
   Une migration testée localement ne prouve pas qu'elle est appliquée en production.
8. Après revue et accord distinct, publier puis vérifier la page `#/version` et
   les fichiers servis. Aucun déploiement ni changement de base distante n'est inclus ici.

## Critère de lancement

Démonstrations accompagnées quand le parcours réel est reproductible. Pilote
payant limité seulement après les validations techniques et la définition de
l'offre. Abonnement public après validation du parcours d'achat, d'accès et de support.
