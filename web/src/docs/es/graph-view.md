# Vista de grafo

La vista **Grafo** responde a una pregunta que una tabla no sabe plantear: ¿qué
está conectado con qué? Existe en dos lugares, con la misma interfaz.

## En una base de datos

Los nodos son las filas de la base, más las filas a las que apuntan en bases
relacionadas. Las aristas vienen de dos fuentes:

- las **celdas de relación** — un enlace que declaraste
- las **referencias de página** — una mención `@` o una tarjeta de página en el
  contenido de una fila

Así que un grafo muestra tanto la estructura que diseñaste como las conexiones que
creó tu escritura.

La leyenda distingue los dos tipos de nodo: filas de esta base, y filas enlazadas
que viven en otro sitio.

## En «Todas las páginas»

Los nodos son tus páginas y tus bases, las aristas las referencias entre ellas. Las
páginas son **círculos**, las bases **cuadrados redondeados**: una forma en lugar
de un matiz, para que la distinción se sostenga en ambos temas y para un lector
con daltonismo. La leyenda lo recuerda.

## Interactuar

- **pulsa** un nodo para resaltarlo con sus vecinos directos, el resto se atenúa
- **pulsa de nuevo** (o en otro sitio) para volver a encenderlo todo
- **arrastra** un nodo para fijarlo donde quieras
- el deslizador de **espaciado** extiende o comprime la disposición
- **+ / − / ajustar** para el zoom, y la vista encuadra el grafo automáticamente
  cuando se estabiliza
- el tamaño de un nodo crece con su número de conexiones
- un **doble clic** abre la página o la fila (una sola pulsación solo resalta,
  así que explorar nunca te saca de la vista por accidente)

La disposición es una simulación de fuerzas calculada en el navegador: los nodos se
repelen, las aristas tiran como resortes, una gravedad suave mantiene todo
centrado. No se envía nada a ninguna parte para dibujarla.
