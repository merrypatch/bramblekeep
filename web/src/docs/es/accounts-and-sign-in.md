# Cuentas y acceso

Dos vías de entrada, a propósito. Una **contraseña** no depende de nada externo. Un
**enlace mágico** necesita un relé de correo que funcione pero nada que recordar.
Una instancia puede usar ambas, y la segunda es la que te salva cuando la primera
no está disponible.

## La primera cuenta

Una instancia nueva no tiene ninguna cuenta: el primer visitante crea el
**propietario** con un correo y una contraseña, y entra directamente. Sin SMTP: de
eso se trata.

Entre el primer arranque y ese momento, quien llegue a la instancia puede
reclamarla. Crea el propietario justo después de arrancar el servidor, y no
expongas el puerto públicamente antes.

## Iniciar sesión después

- **con contraseña** — siempre disponible si la cuenta tiene una
- **con un enlace** — escribe tu correo y recibe un enlace de un solo uso válido
  15 minutos

Sin relé de correo configurado, los enlaces no pueden entregarse: se imprimen en la
consola del servidor, lo cual es un recurso de desarrollo, no una forma de
trabajar.

## Sesiones

Una sesión dura 30 días y es un token opaco aleatorio en una cookie `HttpOnly`: no
hay JWT, así que cerrar sesión o revocar revoca de verdad. Cambiar tu contraseña
cierra **todas tus otras sesiones**.

## Tu contraseña

Ajustes → Cuenta → Contraseña: definirla, cambiarla (se exige la actual), o
eliminarla para volver solo a enlaces. Mínimo 12 caracteres.

Eliminarla se rechaza mientras no haya relé de correo configurado: la cuenta se
quedaría sin ninguna vía de entrada.

## Invitar a personas

Ajustes → Miembros → invitar por correo. Con un relé, la persona recibe un enlace.
**Sin relé**, no se envía nada y la interfaz te entrega el enlace de invitación para
que lo pases tú — ese enlace solo se ofrece para una dirección que aún no tiene
cuenta.

## Recuperar un acceso

- un propietario o un admin puede **restablecer la contraseña de un miembro**: se
  elimina, se cierran sus sesiones, y se le envía un nuevo enlace de acceso si hay
  relé. Nunca se entrega ninguna credencial al administrador.
- con acceso shell al servidor: `bramblekeep set-password <email>`. La contraseña
  se lee de la entrada estándar (un argumento sería visible con `ps` y acabaría en
  el historial del shell), y en una instancia sin ninguna cuenta el comando crea el
  propietario. Es la salida de emergencia cuando nadie puede entrar.

## Idioma y perfil

Ajustes → General: idioma de la interfaz (inglés, francés, español), tema, color de
acento, cuadrícula de fondo. Ajustes → Cuenta: nombre mostrado y avatar.
