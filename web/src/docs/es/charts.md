# Gráficos

Una vista **Gráfico** traza las filas de una base. Todo se elige en *Ajustes*, y
cada vista de gráfico guarda su configuración y sus filtros.

## Formas

Barras, línea, áreas, sectores, radar, radial. Las barras pueden **apilarse**
cuando el gráfico se separa en series.

## Eje X

A elegir: el **título** de la fila, una columna Selección, Estado, Texto, Fórmula,
Rollup, **Relación** o Selección múltiple, una **Fecha**, o las fechas de creación
/ última modificación.

En un eje de fechas, las lecturas se agrupan **por hora, día, semana o mes**. Los
agrupamientos amplios rellenan los huecos para mantener una línea temporal
continua; el agrupamiento por hora traza solo las horas que realmente tienen una
fila, porque si no unas pocas lecturas se ahogarían entre 24 huecos al día.

Un eje de **relación** o de **selección múltiple** coloca una fila en cada grupo al
que pertenece: una lectura enlazada a dos personas aparece en ambos.

## Valores

El agregado es **cantidad**, o **suma / promedio / mín / máx** de una columna
numérica.

Un grupo vacío no siempre vale cero: una cantidad y una suma de nada son
honestamente 0, pero un promedio, un mínimo o un máximo de nada no existen. La
curva muestra un **hueco** ahí en lugar de caer a cero: un día sin lectura de
temperatura no es un día a 0 °C.

## Series

*Separar en series* traza una curva (o un grupo de barras) por valor de una
columna: Selección, Estado, Fórmula, Texto, **Relación** o **Selección múltiple**.
Con una relación, la leyenda muestra los títulos de las páginas enlazadas.

Una fila cuya celda contiene varios valores alimenta cada serie correspondiente.

## Transformaciones

- **Acumulado** — el total corriente a lo largo del eje
- **Restante** — el total menos el total corriente
- **Burndown** — parte del total de todas las filas y decrece a lo largo del eje a
  medida que las filas alcanzan un estado *hecho*, con una línea **ideal**
  discontinua opcional

Una columna numérica con un **objetivo** añade una línea constante discontinua en
las formas continuas (línea, áreas, radar, radial).

## Orden

Por eje (cronológico o alfabético) o **por valor**, en un gráfico de una sola serie
sin eje de fechas.
