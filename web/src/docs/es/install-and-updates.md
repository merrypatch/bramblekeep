# Instalación y actualizaciones

Un binario, un archivo SQLite, una carpeta de subidas. Esa es toda la instalación, y
mantenerlo así es una regla del proyecto.

## Instalar

**Un comando (Linux, Docker)**

```
curl -fsSL https://raw.githubusercontent.com/merrypatch/bramblekeep/master/install.sh | sudo bash
```

Instala el contenedor (más un acompañante Watchtower opcional para las
actualizaciones en un clic), muestra la URL que abrir, y ofrece instalar Docker si
falta. Lee `install.sh` antes de enviar nada a un shell: ese consejo vale para
todos los proyectos, incluido este.

**Docker, a mano**

```
docker run -d --name bramblekeep \
  -p 8080:8080 \
  -v bramblekeep-data:/data \
  ghcr.io/merrypatch/bramblekeep:latest
```

Hay un `docker-compose.yml` listo en el repositorio. La imagen es multiarquitectura,
Raspberry Pi de 64 bits incluida.

**Binario suelto** — descarga la release de tu plataforma, pon un `.env` al lado
(copia de `.env.example`), ejecútalo. El instalador monta un servicio systemd con
`NO_DOCKER=1`.

## Configuración

Todo son variables de entorno, leídas al arrancar:

- `PUBLIC_BASE_URL` — la URL a la que llegan realmente tus usuarios. Los enlaces de
  acceso y los de páginas públicas se construyen con ella, así que debe ser
  correcta detrás de un proxy inverso.
- `COOKIE_SECURE=true` — actívalo cuando sirvas por HTTPS.
- `SETUP_CODE` — secreto opcional exigido para crear la cuenta propietaria, para
  una instancia alcanzable antes de que hayas podido registrarte. Inerte en cuanto
  la cuenta existe.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` — el relé
  de correo. Sin él, el acceso por contraseña sigue funcionando y los enlaces de
  invitación hay que pasarlos a mano.
- `DATABASE_URL`, `FILES_DIR`, `BIND_ADDR` (o `PORT` con Docker), `RUST_LOG`.

## Copia de seguridad

Tres cosas, y nada más:

- la base SQLite (`bramblekeep.db`)
- la carpeta `files/` (las subidas, direccionadas por huella de contenido)
- tu `.env`

El propietario puede descargar la base desde **Ajustes → Espacio de trabajo →
Copia de seguridad**, sin parar nada. Pasa por el propio SQLite: la copia es
coherente incluso mientras la gente escribe.

**Nunca copies con `cp` una base en marcha.** Las escrituras recientes viven en
`bramblekeep.db-wal`, al lado, y una copia sin más atrapa el archivo a medias —
obtienes una copia a la que le faltan sus últimas transacciones, o que
directamente se niega a abrir. Usa el botón, o para el servidor.

La carpeta `files/` no está dentro de la base. Cópiala aparte, o tus páginas
vuelven sin sus imágenes.

## Restauración

**1. Para la instancia.**

```
docker compose down                 # en /opt/bramblekeep
sudo systemctl stop bramblekeep     # binario suelto
```

**2. Vuelve a poner la base — y borra los dos archivos anexos.**

`bramblekeep.db-wal` y `bramblekeep.db-shm` pertenecen a la base que estás
reemplazando. Sáltate este paso y SQLite los reproduce sobre el archivo que
acabas de restaurar: el servidor arranca sin quejarse, y te quedas con una mezcla
de las dos — las páginas que querías deshacer, ahí siguen. Es la forma más
silenciosa de creer que has restaurado algo que no.

Binario suelto:

```
rm -f bramblekeep.db-wal bramblekeep.db-shm
cp bramblekeep-backup-0.12.0-1234567890.db bramblekeep.db
```

Docker — los datos viven en un volumen, y el servicio corre con el uid `10001`:
el archivo restaurado tiene que pertenecerle o la aplicación no podrá escribir.

```
docker run --rm -v bramblekeep-data:/data -v "$PWD":/restore alpine sh -c '
  rm -f /data/bramblekeep.db-wal /data/bramblekeep.db-shm &&
  cp /restore/bramblekeep-backup-0.12.0-1234567890.db /data/bramblekeep.db &&
  chown 10001:10001 /data/bramblekeep.db'
```

**3. Restaura también `files/`** si estás recuperando las subidas. Una página cuya
imagen falta se abre igualmente — la imagen aparece simplemente como no
disponible.

**4. Arranca de nuevo.** Las migraciones se aplican al arrancar: una copia hecha
en una versión anterior abre sin problema en un binario más nuevo. Al revés no:
las migraciones solo van hacia delante, así que no restaures una copia más
reciente en un binario más antiguo.

## Comprobar una copia antes de necesitarla

Una copia que nunca has abierto es una apuesta. Esto lleva diez segundos:

```
sqlite3 bramblekeep-backup-0.12.0-1234567890.db "PRAGMA integrity_check;"
sqlite3 bramblekeep-backup-0.12.0-1234567890.db "SELECT COUNT(*) FROM items;"
```

La primera debe imprimir `ok`. La segunda debe parecerse a tu instancia.

## Deshacer una actualización fallida

Antes de aplicar sus migraciones, una actualización escribe una instantánea junto
a la base, con el nombre de la versión que abandona:

```
bramblekeep.db.bak-0.12.0
```

Restaurarla es el procedimiento de arriba con ese archivo. Reinstala también la
versión correspondiente del binario: esa base no ha pasado por las migraciones
más nuevas.

## Actualizaciones

La comprobación de actualizaciones es **opcional y explícita**: un propietario o un
admin la activa en los ajustes, y hasta entonces la instancia no hace **ninguna**
llamada saliente. Una vez activada, comprueba una vez al día y avisa cuando hay una
versión disponible.

Aplicar una actualización desde la interfaz descarga la release, verifica su
**SHA-256** y su **firma minisign** contra la clave incrustada en el binario, hace
copia del ejecutable actual, lo cambia y reinicia. Una build que falla la
verificación nunca se ejecuta.

Con Docker el cambio es trabajo de Watchtower: mismo botón, mecanismo distinto.

Las migraciones se aplican al arrancar y son solo aditivas: un binario más nuevo
abre una base más antigua sin paso de conversión.
