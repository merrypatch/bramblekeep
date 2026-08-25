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

El propietario descarga las tres cosas en un solo `.zip` desde **Ajustes →
Espacio de trabajo → Copia de seguridad**, sin parar nada. La base que contiene
pasa por el propio SQLite: es coherente incluso mientras la gente escribe, y las
subidas viajan con ella.

```
backup.json      qué es el archivo: formato, versiones, recuentos
bramblekeep.db   la base
files/<hash>     una entrada por archivo subido
```

**Nunca copies con `cp` una base en marcha.** Las escrituras recientes viven en
`bramblekeep.db-wal`, al lado, y una copia sin más atrapa el archivo a medias —
obtienes una copia a la que le faltan sus últimas transacciones, o que
directamente se niega a abrir. Usa el botón, o para el servidor.

Guarda el archivo en otro sitio que la máquina que lo produjo. Una copia sobre
el disco que falla no es una copia.

## Restauración

Para la instancia, ejecuta el comando, arranca de nuevo.

```
docker compose down                 # en /opt/bramblekeep
sudo systemctl stop bramblekeep     # binario suelto

bramblekeep restore bramblekeep-backup-0.12.0-1234567890.zip
```

Con Docker el binario es el punto de entrada de la imagen: ejecútalo sobre el
mismo volumen — lo que además hace que los archivos restaurados pertenezcan a la
cuenta de servicio y no a root:

```
docker run --rm -v bramblekeep-data:/data -v "$PWD":/backup \
  ghcr.io/merrypatch/bramblekeep:latest \
  restore /backup/bramblekeep-backup-0.12.0-1234567890.zip --yes
```

El comando comprueba el archivo antes de tocar nada, rechaza el que este binario
es demasiado antiguo para leer, se niega a ejecutarse mientras la instancia siga
en marcha, conserva la base que reemplaza como
`bramblekeep.db.before-restore-<marca de tiempo>`, e imprime el único comando que
lo deshace. Las subidas se fusionan: un archivo que ya está en disco ya es el
correcto, porque su nombre es la huella de su contenido.

`--yes` se salta la confirmación, para una recuperación con scripts.

## Restaurar a mano

Solo si no puedes ejecutar el binario en absoluto. Los pasos que el comando hace
por ti:

```
unzip bramblekeep-backup-0.12.0-1234567890.zip -d restore/
rm -f bramblekeep.db-wal bramblekeep.db-shm
cp restore/bramblekeep.db bramblekeep.db
cp -r restore/files/. files/
```

**Borrar `bramblekeep.db-wal` y `bramblekeep.db-shm` es el paso que importa.**
Pertenecen a la base que estás reemplazando. Sáltatelo y SQLite los reproduce
sobre el archivo que acabas de restaurar: el servidor arranca sin quejarse, y te
quedas con una mezcla de las dos — las páginas que querías deshacer, ahí siguen.
Es la forma más silenciosa de creer que has restaurado algo que no.

Con Docker, añade `chown -R 10001:10001` sobre lo que hayas copiado: el servicio
no corre como root y no puede escribir archivos que sí lo sean.

Las migraciones se aplican al arrancar: una copia hecha en una versión anterior
abre sin problema en un binario más nuevo. Al revés no, y el comando lo rechaza en
vez de dejar que lo descubras.

## Comprobar una copia antes de necesitarla

Una copia que nunca has abierto es una apuesta. Esto lleva diez segundos:

```
unzip -t bramblekeep-backup-0.12.0-1234567890.zip
unzip -p bramblekeep-backup-0.12.0-1234567890.zip backup.json
unzip -p bramblekeep-backup-0.12.0-1234567890.zip bramblekeep.db > /tmp/check.db
sqlite3 /tmp/check.db "PRAGMA integrity_check;"
sqlite3 /tmp/check.db "SELECT COUNT(*) FROM items;"
```

`unzip -t` no debe señalar ningún error, `integrity_check` debe imprimir `ok`, y
el recuento debe parecerse a tu instancia. `backup.json` te dice de qué versión y
de qué esquema viene el archivo.

## Deshacer una actualización fallida

Antes de aplicar sus migraciones, una actualización escribe una instantánea junto
a la base, con el nombre de la versión que abandona:

```
bramblekeep.db.bak-0.12.0
```

Esa es una base pelada, no un archivo comprimido: las migraciones solo tocan la
base, y las subidas son inmutables — no hay nada más que deshacer. Sáltate el
paso de descompresión y ponla en su sitio igual que arriba. Reinstala también la
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
