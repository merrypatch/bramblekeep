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

Le propriétaire télécharge les trois en un seul `.zip` depuis **Réglages →
Espace de travail → Sauvegarde**, sans rien arrêter. La base qu'il contient passe
par SQLite lui-même : elle est cohérente même pendant que des gens écrivent, et
les envois voyagent avec.

```
backup.json      ce qu'est l'archive : format, versions, décomptes
bramblekeep.db   la base
files/<hash>     une entrée par fichier envoyé
```

**Ne copiez jamais une base en marche avec `cp`.** Les écritures récentes vivent
dans `bramblekeep.db-wal`, à côté, et une copie brute attrape le fichier en plein
milieu — vous obtenez une sauvegarde amputée de ses dernières transactions, ou qui
refuse tout simplement de s'ouvrir. Utilisez le bouton, ou arrêtez le serveur.

Rangez l'archive ailleurs que sur la machine qui l'a produite. Une sauvegarde
posée sur le disque qui lâche n'en est pas une.

## Restauration

**Depuis l'interface.** Réglages → Espace de travail → Sauvegarde → *Restaurer
depuis une sauvegarde*. Choisir une archive l'envoie et la vérifie — la base
qu'elle contient est extraite et ouverte sur-le-champ, donc une archive abîmée
est refusée pendant que vous avez encore l'écran sous les yeux. Rien n'est
remplacé avant confirmation ; ensuite l'instance redémarre et fait l'échange en
remontant, parce qu'une base ne peut pas être remplacée sous la connexion qui
sert la requête.

**Depuis le serveur**, qui est le chemin qui marche encore quand l'instance ne
démarre plus :

```
docker compose down                 # dans /opt/bramblekeep
sudo systemctl stop bramblekeep     # binaire nu

bramblekeep restore bramblekeep-backup-0.12.0-1234567890.zip
```

Sous Docker, le binaire est le point d'entrée de l'image : lancez-le sur le même
volume — ce qui fait aussi que les fichiers restaurés appartiennent au compte de
service et non à root :

```
docker run --rm -v bramblekeep-data:/data -v "$PWD":/backup \
  ghcr.io/merrypatch/bramblekeep:latest \
  restore /backup/bramblekeep-backup-0.12.0-1234567890.zip --yes
```

Dans les deux cas : l'archive est vérifiée avant qu'on touche à quoi que ce soit,
celle que ce binaire est trop ancien pour lire est refusée, la base remplacée est
conservée sous `bramblekeep.db.before-restore-<horodatage>`, et les envois sont
fusionnés — un fichier déjà présent est déjà le bon, puisque son nom est
l'empreinte de son contenu.

`--yes` saute la confirmation, pour une reprise scriptée.

## Restaurer à la main

Uniquement si vous ne pouvez pas lancer le binaire du tout. Les étapes que la
commande fait pour vous :

```
unzip bramblekeep-backup-0.12.0-1234567890.zip -d restore/
rm -f bramblekeep.db-wal bramblekeep.db-shm
cp restore/bramblekeep.db bramblekeep.db
cp -r restore/files/. files/
```

**Supprimer `bramblekeep.db-wal` et `bramblekeep.db-shm` est l'étape qui
compte.** Ils appartiennent à la base que vous remplacez. Sautez-la et SQLite les
rejoue par-dessus le fichier que vous venez de restaurer : le serveur démarre sans
broncher, et vous vous retrouvez avec un mélange des deux — les pages que vous
vouliez annuler, toujours là. C'est la manière la plus silencieuse de croire avoir
restauré quelque chose qui ne l'est pas.

Sous Docker, ajoutez `chown -R 10001:10001` sur ce que vous avez copié : le
service ne tourne pas en root et ne peut pas écrire des fichiers qui le sont.

Les migrations s'appliquent au démarrage : une sauvegarde prise sur une version
plus ancienne s'ouvre sans problème sur un binaire plus récent. L'inverse non, et
la commande le refuse plutôt que de vous le laisser découvrir.

## Vérifier une sauvegarde avant d'en avoir besoin

Une sauvegarde qu'on n'a jamais ouverte est un pari. Ça prend dix secondes :

```
unzip -t bramblekeep-backup-0.12.0-1234567890.zip
unzip -p bramblekeep-backup-0.12.0-1234567890.zip backup.json
unzip -p bramblekeep-backup-0.12.0-1234567890.zip bramblekeep.db > /tmp/check.db
sqlite3 /tmp/check.db "PRAGMA integrity_check;"
sqlite3 /tmp/check.db "SELECT COUNT(*) FROM items;"
```

`unzip -t` ne doit signaler aucune erreur, `integrity_check` doit afficher `ok`,
et le décompte doit ressembler à votre instance. `backup.json` vous dit de quelle
version et de quel schéma vient l'archive.

## Annuler une mise à jour ratée

Avant d'appliquer ses migrations, une mise à jour écrit un instantané à côté de la
base, nommé d'après la version qu'elle quitte :

```
bramblekeep.db.bak-0.12.0
```

Celui-là est une base nue, pas une archive : les migrations ne touchent que la
base, et les envois sont immuables — il n'y a rien d'autre à annuler. Sautez
l'étape de décompression et mettez-le en place exactement comme ci-dessus.
Réinstallez aussi la version correspondante du binaire : cette base n'a pas subi
les migrations plus récentes.

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
