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

Copiez-les serveur arrêté, ou utilisez le mécanisme de sauvegarde propre à SQLite
sur une instance en marche. Il n'y a aucun service externe à restaurer, aucune
file d'attente à vider.

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
