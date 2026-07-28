# Compartir y permisos

Dos capas independientes: tu **rol** en el espacio, y lo que se te **comparte**
página por página. El servidor decide ambas, en cada petición y en cada mensaje de
sincronización; la interfaz solo lo refleja.

## Roles

- **Propietario** — uno por instancia. Todo lo que puede un admin, más promover y
  degradar admins, desactivar miembros y transferir la propiedad.
- **Admin** — invita y desactiva miembros, renombra el espacio, cambia la política
  de registro.
- **Miembro** — trabaja en sus propias páginas y en lo que se le comparte.

Ajustes → Miembros lista a todo el mundo, con un recordatorio desplegable de lo que
puede hacer cada rol.

## Compartir una página

Abre una página y usa **Compartir**. Cuatro niveles, de menor a mayor:

- **lectura** — puede abrirla
- **edición** — puede modificar su contenido
- **creación** — puede además crear subpáginas dentro
- **admin** — puede además borrar

Un compartir se **hereda en todo el subárbol**: compartir una madre comparte todo
lo que está debajo. Puedes invitar a alguien que aún no tiene cuenta: recibe un
enlace, y el compartir se aplica en cuanto inicia sesión.

## Supervisión

Un propietario ve el contenido de cada miembro y admin; un admin ve el contenido de
los miembros, no el de sus pares admins. Esto existe para que una instancia sea
administrable: las páginas de quien se va no deben volverse inaccesibles. Cada
acción supervisada queda en el historial de la página, así que es auditable.

## Publicar en la web

**Compartir → Publicar** crea un enlace público, legible **sin ninguna cuenta**.
Opcionalmente, todo el subárbol de la página va con ella.

- lo que se sirve es la proyección de solo lectura del contenido, nunca un
  documento editable
- despublicar la raíz elimina toda la publicación; quitar una sola subpágina quita
  solo esa
- mover una página **dentro** de un subárbol publicado la hace pública, moverla
  **fuera** la retira: se te pregunta antes, en ambos sentidos
- el enlace contiene un token imposible de adivinar. Es una capacidad: quien lo
  tenga puede leer, trátalo como la dirección pública que es.

## Política de registro

Ajustes → Espacio: **solo por invitación** (por defecto) o **abierto**. Solo por
invitación significa que un correo desconocido no recibe ningún enlace de acceso,
pida lo que pida.
