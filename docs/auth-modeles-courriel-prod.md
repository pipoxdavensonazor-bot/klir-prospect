# Courriels Auth en production : constat et correctif prêt

Test réel du 14 nov. 2026 (adresse externe `philippe-test@mail.grokbot.com`, compte jetable supprimé ensuite) :

| Étape | Résultat Prod |
|---|---|
| Confirmation d'adresse obligatoire | oui (`mailer_autoconfirm = false`) |
| Courriel d'inscription | reçu en 1 s, expéditeur `KlirProspect <noreply@klirline.ca>` (SMTP Cloudflare) |
| Langue / modèle | **anglais, modèle Supabase par défaut** (« Confirm your email address ») ; lien `/auth/v1/verify?token=…` |
| Confirmation via le lien | OK (303 vers le site, `email_confirmed_at` renseigné) |
| Mot de passe oublié | courriel reçu en < 1 s, **anglais** ; lien valide ; nouveau mot de passe accepté ; ancien refusé |

Problème : l'application est en PKCE avec stockage par onglet (`sessionStorage`). Avec le modèle par défaut, le lien de
récupération ouvert depuis la messagerie (nouvel onglet) ne trouve pas le vérificateur PKCE : l'application affiche
« Ce lien doit être ouvert dans l'onglet et le navigateur où vous avez demandé la récupération ». Le parcours prévu
par le dépôt (modèles `supabase/templates/*.html`, lien `?token_hash=…&type=…` puis `verifyOtp`) n'est pas appliqué en Prod.
Il a été vérifié côté serveur sur le projet Test : `POST /auth/v1/verify {type:"signup", token_hash}` renvoie une session.
Le français est aussi attendu (Loi 96).

## Correctif (Prod, à autoriser) — Dashboard → Authentication → Emails → Templates

| Modèle | Objet | Corps |
|---|---|---|
| Confirm signup | `Confirmez votre compte Klir Prospect` | contenu de `supabase/templates/confirmation.html` |
| Reset password | `Réinitialisez votre mot de passe Klir Prospect` | contenu de `supabase/templates/recovery.html` |

Recommandé aussi : Magic link, Change email, Invite en français (même style), et appliquer les mêmes modèles au projet Test.
Vérification après : nouvelle inscription jetable → courriel en français, lien `?token_hash=` → bouton de confirmation
dans l'app → compte confirmé ; mot de passe oublié ouvert dans un autre navigateur → nouveau mot de passe accepté.
