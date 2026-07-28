# Comptes et connexion

Deux chemins d'entrée, volontairement. Un **mot de passe** ne dépend de rien
d'extérieur. Un **lien magique** exige un relais mail qui fonctionne mais rien à
retenir. Une instance peut utiliser les deux, et le second est ce qui vous sauve
quand le premier est indisponible.

## Le premier compte

Une instance neuve n'a aucun compte : le premier visiteur crée le
**propriétaire** avec un email et un mot de passe, et entre directement. Aucun
SMTP nécessaire — c'est tout l'intérêt.

Entre le premier démarrage et ce moment, quiconque atteint l'instance peut la
revendiquer. Créez le propriétaire juste après avoir lancé le serveur, et
n'exposez pas le port publiquement avant.

Si vous ne pouvez pas le garantir — un VPS avec un port ouvert, un conteneur
lancé par quelqu'un d'autre — démarrez l'instance avec **`SETUP_CODE`** défini à
n'importe quelle chaîne secrète. Créer le propriétaire l'exige alors, et l'écran
de connexion affiche un champ de plus. Ça ne protège rien d'autre : dès que le
compte existe, le code devient inerte, et la route d'inscription est de toute
façon fermée à tout le monde.

## Se connecter ensuite

- **avec un mot de passe** — toujours disponible si le compte en a un
- **avec un lien** — saisissez votre email, recevez un lien à usage unique valable
  15 minutes

Sans relais mail configuré, les liens ne peuvent pas être livrés : ils sont
affichés dans la console du serveur, ce qui est un secours de développement, pas
un mode de fonctionnement.

## Sessions

Une session dure 30 jours et tient dans un jeton opaque aléatoire, en cookie
`HttpOnly` — il n'y a pas de JWT, donc se déconnecter ou révoquer révoque
vraiment. Changer son mot de passe ferme **toutes vos autres sessions**.

## Votre mot de passe

Réglages → Compte → Mot de passe : le définir, le changer (l'actuel est exigé), ou
le supprimer pour revenir aux liens seuls. 12 caractères minimum.

Le supprimer est refusé si aucun relais mail n'est configuré : le compte n'aurait
plus aucun accès.

## Inviter des personnes

Réglages → Membres → inviter par email. Avec un relais, la personne reçoit un
lien. **Sans relais**, rien n'est envoyé et l'interface vous remet le lien
d'invitation à transmettre vous-même — ce lien n'est proposé que pour une adresse
qui n'a pas encore de compte.

## Récupérer un accès

- un propriétaire ou un admin peut **réinitialiser le mot de passe d'un membre** :
  il est supprimé, ses sessions sont fermées, et un nouveau lien de connexion lui
  est envoyé si un relais existe. Aucun identifiant n'est jamais remis à
  l'administrateur.
- avec un accès shell au serveur : `bramblekeep set-password <email>`. Le mot de
  passe est lu sur l'entrée standard (un argument serait visible par `ps` et
  finirait dans l'historique du shell), et sur une instance sans aucun compte la
  commande crée le propriétaire. C'est l'issue de secours quand personne ne peut
  plus se connecter.

## Langue et profil

Réglages → Général : langue de l'interface (anglais, français, espagnol), thème,
couleur d'accent, grille de fond. Réglages → Compte : nom affiché et avatar.
