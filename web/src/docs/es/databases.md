# Bases de datos

Una base de datos es una página cuyos hijos son sus filas. Cada fila es una página
real: puedes abrirla y escribir dentro, con el mismo editor que en cualquier otro
sitio. Las columnas son las propiedades de la fila, y una **vista** es una manera
de mirarlas.

## Crear una

**Añadir → Base de datos** en la barra lateral crea una base a página completa.
Dentro de una página, `/` ofrece tres variantes:

- **Base de datos** — una base como subpágina, referenciada por una tarjeta
- **Base en línea** — mostrada directamente en la página que escribes
- **Enlazar una base existente** — la misma base mostrada en un segundo lugar

## Tipos de columna

Texto, Número, Casilla, Selección, Selección múltiple, Estado, Fecha, Teléfono,
Correo, URL, Archivos y medios, Relación, Rollup, Fórmula.

Cuatro más se calculan a partir del propio elemento y son de solo lectura: **Fecha
de creación**, **Creado por**, **Última modificación**, **Modificado por**.

Algunas particularidades útiles:

- **Estado** lleva grupos (por hacer / en curso / hecho), y eso es lo que hace
  posibles el tablero y el gráfico burndown
- **Fecha** admite inicio, fin y hora
- **Número** admite un valor objetivo, dibujado con línea discontinua en los
  gráficos
- **Selección** y **Estado** tienen opciones con color, reutilizadas por el
  tablero y los gráficos

## Vistas

Seis, cada una con sus filtros, su orden y su búsqueda:

- **Tabla** — la hoja de cálculo, con un pie por columna que calcula un valor
  (cantidad, vacíos, únicos, suma, promedio, mín, máx, porcentajes)
- **Tablero (kanban)** — agrupado por una columna Selección o Estado, arrastra una
  tarjeta para cambiar su valor
- **Calendario** — por una columna Fecha, en modo mes, semana o día
- **Galería** — tarjetas, para filas cuya imagen importa
- **Gráfico** — ver el capítulo *Gráficos*
- **Grafo (relaciones)** — ver el capítulo *Vista de grafo*

Las filas se reordenan a mano en la vista de tabla (arrastra el asa), y las
columnas se redimensionan y reordenan igual.

## Filtros

Un filtro es un grupo de condiciones combinadas con **y** / **o**, y los grupos se
anidan. Los operadores dependen del tipo: contiene, es, no es, está vacío, no está
vacío para texto; las comparaciones para números; alguna de / ninguna de para
selecciones; antes / después / es para fechas.

Los filtros existen en dos niveles: en la **base** (se aplica en todas partes) y en
la **vista** (solo en esa vista).

## Una base incrustada lee su página anfitriona

Una base incrustada en una página puede filtrar según la página en la que está: el
valor de una condición puede referenciar el título o una propiedad de la **página
anfitriona**. El mismo bloque colocado en dos páginas distintas muestra entonces
dos subconjuntos distintos: una base, una definición, varias lecturas
contextuales.

## Filas

Al pulsar una fila se abre como página. Una fila tiene además un **panel de
propiedades** para sus columnas, y puedes ojearla sin salir de la vista.

Una base puede definir **plantillas**: una fila nueva empieza rellenada, con
columnas y contenido.

## Importar

**Importar CSV** asocia cada columna del CSV a una columna existente, a una nueva
columna, o la ignora, y añade las filas sin tocar las existentes.
