# Brouillon d’offre pilote — non ouvert à la vente

Document de travail, sans validation juridique et sans engagement. Achat fermé, prévisualisation et Supabase Test uniquement. Aucune activation de production autorisée. Ce brouillon décrit le parcours disponible ; les tests techniques ne suffisent pas à le déclarer commercialement prêt.

## Offre à discuter

Un essai accompagné de repérage et d’organisation de candidats restaurants/cafés : recherche authentifiée et bornée, lecture des réserves, sélection, CRM avec note/action/date, récupération après connexion et export CSV UTF-8 attribué. Les unités affichées restent des unités de test. Les cinq séances de quinze minutes visent à observer l’utilité et les difficultés, pas à engager un abonnement.

Segment : restaurants et cafés accueillant du public, restauration rapide comprise. Trois cercles de 2,2 km, pas les villes entières : Montréal (45.5017, −73.5673), Laval (45.6066, −73.7124), Québec (46.8139, −71.2080). Maximum 40 par recherche. Source Overture figée 2026-10-21.0, révision de ciblage trial-restaurants-v2. Catégories publiées et annotations conservées ; champs absents non complétés par génération. Taille, indépendance et besoin commercial inconnus. Aucune garantie de précision, exhaustivité, actualité, délivrabilité, intérêt commercial ou chiffre d’affaires.

Disponibles : recherche → sélection → CRM → suivi → CSV. Indisponibles dans cette offre : qualification commerciale automatique, filtres taille/site vérifiés, enrichissement, campagnes/envoi, Excel natif. Une fiche « à revoir » reste ambiguë, une fiche sans revue concluante reste non vérifiée. Aucun appel ni courriel à une entreprise pendant les séances. L’accompagnement futur payant et son niveau de support restent à définir.

## Conditions à décider

| Condition | Valeur |
|---|---|
| Prix | À définir |
| Devise | À définir |
| Taxes et traitement fiscal | À définir |
| Durée du pilote payant | À définir |
| Crédits inclus / règles de recharge | À définir |
| Renouvellement | À définir |
| Annulation / remboursement | À définir |
| Support : canal, contact, horaires et délai | À définir |
| Contact de confidentialité | À définir |
| Identité juridique de la partie contractante | À définir |
| Accompagnement inclus au pilote payant | À définir |

Les règles de test actuellement implémentées (5 + plafond quantité/10, aucun débit pour vide/partiel/erreur) décrivent le prototype et ne fixent pas les conditions d’une vente future.

## Rubriques des conditions à faire valider

Parties et admission des comptes ; description exacte du service et version ; durée et sortie du pilote ; prix/devise/taxes/facture et échéance ; crédits et restitution technique ; renouvellement ; annulation/remboursement ; accompagnement/support ; disponibilité et incidents ; responsabilités liées aux données publiées et réserves ; usages autorisés et absence de promesse de résultats ; exports/provenance/licences ; confidentialité ; restitution/suppression des données ; modification du périmètre ; suspension et règlement des différends. La juridiction, les formulations et les obligations applicables ne sont pas arrêtées par ce brouillon.

## Rubriques de confidentialité à faire valider

- Responsable et contact : À définir. Finalités : authentification, espace de travail, suivi CRM, règlement des unités, récupération des opérations et diagnostic d’incidents.
- Données réellement traitées : compte Auth (courriel et données d’authentification gérées par Supabase), profil, préférences, recherches, fiches publiques/provenances, notes/actions/dates saisies, historiques, quotas/crédits/reçus et journaux techniques. Ne pas saisir de données sensibles inutiles dans les notes.
- Prestataires du parcours : Supabase pour Auth/base, Cloudflare pour l’hébergement de prévisualisation. GitHub pour le code public/CI : aucune donnée privée de compte n’y est publiée. Régions, sous-traitants, transferts éventuels et durées de journaux des prestataires à confirmer dans les configurations/contrats réels ; ne pas promettre que tous les traitements restent au Canada.
- Session applicative : stockage de session dans l’onglet, file locale de récupération et copies téléchargées sous la responsabilité de l’utilisateur ; avertissement en cas de conflit/limite. Une copie JSON peut contenir les notes du compte : la conserver en privé.
- Données de source : Overture et fournisseurs, identifiants, release et licences conservés ; provenance publique ≠ autorisation générale de contacter une personne.
- Durées : cache valide 10 min et nettoyage >24 h ; corps de résultats par reçu 90 jours ; métadonnées de reçus conservées pendant la prévisualisation ; notes/suivis pendant les séances puis revue de conservation 90 jours après la dernière. Règles manuelles et limites opérationnelles documentées ; politique finale avant paiement à définir.
- Demandes d’accès/correction/suppression/export et vérification d’identité, contact, délai, incidents et notification, mesures d’accès/RLS, sauvegardes indépendantes et suppression des copies : procédure et engagements à valider. Ne pas présenter le retour de catalogue comme une restauration complète.
- Relevés U1–U5 pseudonymisés, identités hors rapport partagé, accord pour observations. Aucun nouveau traceur analytique ni prestataire de facturation intégré dans cette livraison.

## Options minimales de facturation — étude, aucune activation

| Option | Fonctionnement proposé | Décisions / limites |
|---|---|---|
| Facture établie manuellement + paiement externe déjà accepté par l’entreprise | Émettre la facture après accord sur les conditions, recevoir le paiement via un moyen choisi par le responsable, rapprocher la référence et vérifier le compte avant toute admission. | Moyen, prix, taxes, coordonnées, délais et responsable à définir. Pas d’abonnement technique ajouté. Pas de facture réelle émise ici. |
| Facture hébergée sans code chez un prestataire choisi | Exemple étudié : Stripe Invoicing, qui permet un flux de facture sans intégration de l’application. | Prestataire, frais, vérification du compte et contrats à décider ; aucun compte créé, aucune clé ni intégration ajoutée. |
| Lien de paiement ponctuel | Exemple étudié : Payment Links ; lien vers un paiement hébergé, sans abonnement requis si l’offre est ponctuelle. | Le lien ne remplace pas les conditions, la facture appropriée ou le contrôle d’accès. Ne pas créer de lien avant décision. |

Pour un premier pilote, la facture manuelle et un paiement externe sont l’option à discuter en premier, car le propriétaire n’a pas choisi de nouveau prestataire. Ceci n’est pas une décision de paiement ni un conseil fiscal.

**Paiement et admission restent séparés.** Aucun retour de navigateur, reçu fourni par un client, champ user_metadata ou simple paiement ne doit créer des droits. Procédure future : rapprochement par un responsable autorisé → identité du compte vérifiée → admission serveur explicitement approuvée → trace de la décision. Aucun webhook d’ouverture d’accès n’est installé. Le mécanisme définitif d’admission au pilote payant reste à décider et à vérifier avant ouverture ; l’inscription au Test ne vaut pas contrat commercial.

Sources officielles consultées pour la comparaison de capacités : [Stripe : comparaison Invoicing / Payment Links / Checkout](https://support.stripe.com/questions/choosing-between-stripe-checkout-uis-or-invoicing?locale=en-GB), [Payment Links](https://docs.stripe.com/payment-links). Aucun tarif ou taux de taxe supposé dans cette étude.
