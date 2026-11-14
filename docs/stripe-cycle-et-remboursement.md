# Cycle de facturation Stripe : preuves, échec de paiement, annulation, remboursement

## Simulation isolée (14 nov. 2026)

`private.stripe_handle_event` rejoué sur une restauration locale de la sauvegarde Prod (jamais Test ni Prod),
avec des événements Stripe synthétiques. Script : `ops/stripe-sim/stripe-lifecycle-sim.sql` (transaction annulée à la fin).

| # | Événement | Résultat | Forfait | Statut | Solde |
|---|---|---|---|---|---|
| 1 | checkout.session.completed (Starter) | subscription_started | starter | active | 800 |
| 2 | invoice.paid du 1er paiement | duplicate | starter | active | 800 |
| 3 | invoice.paid subscription_cycle (renouvellement) | plan_granted | starter | active | 1 200 (plafond 2 × 600) |
| 4 | même facture rejouée | duplicate | starter | active | 1 200 |
| 5 | invoice.payment_failed | ignored_type | starter | active | 1 200 |
| 6 | customer.subscription.updated past_due | tier_starter | starter | past_due | 1 200 |
| 7 | subscription.updated cancel_at_period_end | tier_starter | starter | active (annulation programmée) | 1 200 |
| 8 | customer.subscription.deleted | tier_gratuit | gratuit | — | 1 200 |
| 9 | charge.refunded | logged_refund_manual_review | gratuit | — | 1 200 |
| 10 | autre produit : checkout.session.completed | ignored_foreign_link | | | |
| 11 | autre produit : invoice.paid | ignored_unknown_subscription | | | |
| 12 | autre produit : subscription.deleted | ignored_unknown_subscription | | | |
| 13 | événement test sur base live | ignored_mode | | | |

Constats :
- **Échec de paiement** : `invoice.payment_failed` n'est pas nécessaire. Stripe envoie `customer.subscription.updated`
  (`past_due`), qui est traité ; le client garde son forfait pendant les relances Stripe, puis passe en Gratuit à
  `customer.subscription.deleted` (ou `unpaid`). Aucun crédit n'est accordé sans `invoice.paid`.
- **Annulation** : fin de période respectée ; Gratuit à la suppression ; les crédits déjà accordés restent (règle à
  écrire dans les conditions).
- **Remboursement** : aucun traitement automatique ; l'événement n'est d'ailleurs pas abonné sur le webhook live.

## Ce qui reste à prouver dans Stripe (mode test)

Aucune clé secrète Stripe **test** n'est disponible sur la machine d'exploitation et le connecteur Stripe n'a qu'un accès
live. Pour exécuter le scénario horloge de test, il faut l'un des deux :
1. une clé restreinte test (`rk_test_…`) avec droits Customers, Subscriptions, Test clocks, Invoices, Refunds en écriture ; ou
2. réautoriser le connecteur Stripe en mode test.

Scénario prêt (projet Test `pwakjxjjxswdjsapsbxn`, webhook test) :
1. `POST /v1/test_helpers/test_clocks` (frozen_time = maintenant) ; client rattaché à l'horloge, carte `pm_card_visa`.
2. Abonnement Starter test avec `metadata[app]=klirprospect`, `metadata[project]=test` → attendre `plan_granted`.
3. Avancer l'horloge de 1 mois → `invoice.paid` `subscription_cycle` → `plan_granted`.
4. Remplacer la carte par `pm_card_chargeCustomerFail`, avancer de 1 mois → `past_due` → après relances `subscription.deleted`.
5. Nouvel abonnement, `cancel_at_period_end=true` via le portail test → avancer → Gratuit.
6. Remboursement test complet d'une facture → vérifier `logged_refund_manual_review` si l'événement est ajouté au webhook test.

## Procédure de remboursement (manuelle, live)

1. Tableau de bord Stripe → Paiements → paiement du client → Rembourser (total ou partiel), motif noté.
2. Si l'abonnement doit s'arrêter : Abonnements → Annuler immédiatement (ou fin de période).
3. Crédits : aucun retrait automatique. Décider au cas par cas (LPC) ; une correction de solde demande l'accord écrit de Philippe.
4. Consigner la date, le montant, le motif et la référence `re_…` dans le registre de support.
