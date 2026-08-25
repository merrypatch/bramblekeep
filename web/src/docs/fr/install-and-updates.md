# Installation et mises à jour

Un binaire, un fichier SQLite, un dossier d'envois. C'est toute l'installation, et
le rester est une règle du projet.

## Installer

**Une commande (Linux, Docker)**

```
curl -fsSL https://raw.githubusercontent.com/merrypatch/bramblekeep/master/install.sh | sudo bash
```

Elle installe le conteneur (plus un compagnon Watchtower optionnel pour les mises
à jour en un clic), affiche l'URL à ouvrir, et propose d'installer Docker s'il
manque. Lisez `install.sh` avant d'envoyer quoi que ce soit dans un shell — ce
conseil vaut pour tous les projets, celui-ci compris.

**Docker, à la main**

```
docker run -d --name bramblekeep \
  -p 8080:8080 \
  -v bramblekeep-data:/data \
  ghcr.io/merrypatch/bramblekeep:latest
```

Un `docker-compose.yml` prêt à l'emploi est dans le dépôt. L'image est multi-arch,
Raspberry Pi 64 bits inclus.

**Binaire nu** — téléchargez la release de votre plateforme, posez un `.env` à
côté (copie de `.env.example`), lancez-le. C'est un service systemd que
l'installeur met en place avec `NO_DOCKER=1`.

## Configuration

Tout passe par des variables d'environnement, lues au démarrage :

- `PUBLIC_BASE_URL` — l'URL que vos utilisateurs atteignent réellement. Les liens
  de connexion et les liens de pages publiques sont construits dessus : elle doit
  être juste derrière un reverse proxy.
- `COOKIE_SECURE=true` — à activer quand vous servez en HTTPS.
- `SETUP_CODE` — secret optionnel exigé pour créer le compte propriétaire, pour
  une instance joignable avant que vous ayez pu vous inscrire. Inerte dès que le
  compte existe.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` — le
  relais mail. Sans lui, la connexion par mot de passe fonctionne toujours et les
  liens d'invitation doivent être transmis à la main.
- `DATABASE_URL`, `FILES_DIR`, `BIND_ADDR` (ou `PORT` sous Docker), `RUST_LOG`.

## Sauvegarde

Trois choses, et rien d'autre :

- la base SQLite (`bramblekeep.db`)
- le dossier `files/` (les envois, adressés par empreinte de contenu)
- votre `.env`

Le propriétaire peut télécharger la base depuis **Réglages → Espace de travail →
Sauvegarde**, sans rien arrêter. Elle passe par SQLite lui-même : la copie est
cohérente même pendant que des gens écrivent.

**Ne copiez jamais une base en marche avec `cp`.** Les écritures récentes vivent
dans `bramblekeep.db-wal`, à côté, et une copie brute attrape le fichier en plein
milieu — vous obtenez une sauvegarde amputée de ses dernières transactions, ou qui
refuse tout simplement de s'ouvrir. Utilisez le bouton, ou arrêtez le serveur.

Le dossier `files/` n'est pas dans la base. Sauvegardez-le à part, sinon vos pages
reviennent sans leurs images.

## Restauration

**1. Arrêtez l'instance.**

```
docker compose down                 # dans /opt/bramblekeep
sudo systemctl stop bramblekeep     # binaire nu
```

**2. Remettez la base en place — et supprimez les deux fichiers annexes.**

`bramblekeep.db-wal` et `bramblekeep.db-shm` appartiennent à la base que vous
remplacez. Sautez cette étape et SQLite les rejoue par-dessus le fichier que vous
venez de restaurer : le serveur démarre sans broncher, et vous vous retrouvez avec
un mélange des deux — les pages que vous vouliez annuler, toujours là. C'est la
manière la plus silencieuse de croire avoir restauré quelque chose qui ne l'est
pas.

Binaire nu :

```
rm -f bramblekeep.db-wal bramblekeep.db-shm
cp bramblekeep-backup-0.12.0-1234567890.db bramblekeep.db
```

Docker — les données vivent dans un volume, et le service tourne sous l'uid
`10001` : le fichier restauré doit lui appartenir, sinon l'application ne peut
pas écrire.

```
docker run --rm -v bramblekeep-data:/data -v "$PWD":/restore alpine sh -c '
  rm -f /data/bramblekeep.db-wal /data/bramblekeep.db-shm &&
  cp /restore/bramblekeep-backup-0.12.0-1234567890.db /data/bramblekeep.db &&
  chown 10001:10001 /data/bramblekeep.db'
```

**3. Restaurez aussi `files/`** si vous récupérez les envois. Une page dont
l'image manque s'ouvre quand même — l'image s'affiche simplement comme
indisponible.

**4. Redémarrez.** Les migrations s'appliquent au démarrage : une sauvegarde prise
sur une version plus ancienne s'ouvre sans problème sur un binaire plus récent.
L'inverse, non : les migrations ne vont que vers l'avant, ne restaurez pas une
sauvegarde plus récente dans un binaire plus ancien.

## Vérifier une sauvegarde avant d'en avoir besoin

Une sauvegarde qu'on n'a jamais ouverte est un pari. Ça prend dix secondes :

```
sqlite3 bramblekeep-backup-0.12.0-1234567890.db "PRAGMA integrity_check;"
sqlite3 bramblekeep-backup-0.12.0-1234567890.db "SELECT COUNT(*) FROM items;"
```

La première doit afficher `ok`. La seconde doit ressembler à votre instance.

## Annuler une mise à jour ratée

Avant d'appliquer ses migrations, une mise à jour écrit un instantané à côté de la
base, nommé d'après la version qu'elle quitte :

```
bramblekeep.db.bak-0.12.0
```

Le restaurer, c'est la procédure ci-dessus avec ce fichier. Réinstallez aussi la
version correspondante du binaire : cette base n'a pas subi les migrations plus
récentes.

## Mises à jour

La vérification des mises à jour est **sur consentement** : un propriétaire ou un
admin l'active dans les réglages, et tant que ce n'est pas fait, l'instance
n'émet **aucun** appel sortant. Une fois activée, elle vérifie une fois par jour
et prévient quand une version est disponible.

Appliquer une mise à jour depuis l'interface télécharge la release, vérifie son
**SHA-256** et sa **signature minisign** contre la clé intégrée au binaire,
sauvegarde l'exécutable courant, l'échange et redémarre. Une build qui échoue à la
vérification n'est jamais exécutée.

Sous Docker, l'échange est le travail de Watchtower — même bouton, mécanisme
différent.

Les migrations s'appliquent au démarrage et sont uniquement additives : un binaire
plus récent ouvre une base plus ancienne sans étape de conversion.
