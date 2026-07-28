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
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` — el relé
  de correo. Sin él, el acceso por contraseña sigue funcionando y los enlaces de
  invitación hay que pasarlos a mano.
- `DATABASE_URL`, `FILES_DIR`, `BIND_ADDR` (o `PORT` con Docker), `RUST_LOG`.

## Copia de seguridad

Tres cosas, y nada más:

- la base SQLite (`bramblekeep.db`)
- la carpeta `files/` (las subidas, direccionadas por huella de contenido)
- tu `.env`

Cópialas con el servidor parado, o usa el mecanismo de copia propio de SQLite en una
instancia en marcha. No hay ningún servicio externo que restaurar, ninguna cola que
vaciar.

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
