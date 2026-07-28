# Partage et permissions

Deux couches indépendantes : votre **rôle** dans l'espace, et ce qui vous est
**partagé** page par page. Le serveur tranche les deux, à chaque requête et à
chaque message de synchronisation — l'interface ne fait que le refléter.

## Rôles

- **Propriétaire** — un par instance. Tout ce qu'un admin peut faire, plus
  promouvoir et rétrograder les admins, désactiver des membres et transférer la
  propriété.
- **Admin** — invite et désactive des membres, renomme l'espace, change la
  politique d'inscription.
- **Membre** — travaille sur ses propres pages et sur ce qui lui est partagé.

Réglages → Membres liste tout le monde, avec un rappel dépliable de ce que chaque
rôle peut faire.

## Partager une page

Ouvrez une page et utilisez **Partager**. Quatre niveaux, du plus faible au plus
fort :

- **lecture** — peut l'ouvrir
- **édition** — peut modifier son contenu
- **création** — peut en plus créer des sous-pages dedans
- **admin** — peut en plus supprimer

Un partage est **hérité par tout le sous-arbre** : partager un parent partage tout
ce qui est dessous. Vous pouvez inviter quelqu'un qui n'a pas encore de compte :
il reçoit un lien, et le partage s'applique dès sa première connexion.

## Supervision

Un propriétaire voit le contenu de chaque membre et admin ; un admin voit le
contenu des membres, pas celui de ses pairs admins. Cela existe pour qu'une
instance reste administrable — les pages d'un collaborateur qui part ne doivent pas
devenir inaccessibles. Chaque action supervisée est inscrite dans l'historique de
la page, donc auditable.

## Publier sur le web

**Partager → Publier** crée un lien public, lisible **sans aucun compte**. En
option, tout le sous-arbre de la page part avec elle.

- ce qui est servi est la projection en lecture seule du contenu, jamais un
  document éditable
- dépublier la racine supprime toute la publication ; retirer une seule sous-page
  ne retire que celle-là
- déplacer une page **dans** un sous-arbre publié la rend publique, la déplacer
  **hors** la retire — la question vous est posée dans les deux sens
- le lien contient un jeton indevinable. C'est une capacité : quiconque le détient
  peut lire, traitez-le comme l'adresse publique qu'il est.

## Politique d'inscription

Réglages → Espace : **sur invitation** (par défaut) ou **ouverte**. Sur
invitation, un email inconnu ne reçoit aucun lien de connexion, quoi qu'il
demande.
