# Relaciones y rollups

Una **relación** enlaza filas de dos bases. Un **rollup** trae un valor a través de
ese enlace y lo agrega. Juntos convierten un conjunto de tablas en un modelo.

## Crear una relación

Añade una columna, elige el tipo **Relación** y luego la base destino. Dos opciones
importan:

- **única** — la celda contiene como máximo una fila enlazada (una medición
  pertenece a una persona)
- **bidireccional** — la base destino recibe una columna recíproca, mantenida al
  día: enlazar A con B desde cualquier lado actualiza ambas

Una celda de relación almacena identificadores y muestra los títulos de las filas
enlazadas. Borrar una fila enlazada no deja texto fantasma: la etiqueta
desaparece.

## Rollups

Añade una columna, elige el tipo **Rollup** y responde a tres preguntas:

1. **qué relación** seguir (una columna de relación de esta base)
2. **qué columna** de las filas enlazadas leer — cualquiera, incluido su título
3. **qué agregado** aplicar: cantidad, suma, promedio, mín, máx, o *valores* (la
   lista misma, concatenada)

Ejemplos: el número de mediciones por persona, la temperatura media por persona, el
importe total de las facturas de un cliente.

Un rollup es de solo lectura y se recalcula al leer: es una lente sobre las filas
enlazadas, nunca una copia guardada que pudiera quedar desfasada.

## Úsalos en todas partes

- los **filtros** y los **ordenamientos** aceptan un rollup o una relación como
  cualquier columna
- los **gráficos** pueden separar series o agrupar el eje X por una relación,
  mostrando los títulos de las páginas enlazadas (una curva por persona, por
  ejemplo)
- la **vista de grafo** dibuja las celdas de relación como aristas
- **Exportar con relaciones (ZIP)** lleva las bases enlazadas junto con la
  principal, para que las relaciones sobrevivan a una exportación y reimportación
