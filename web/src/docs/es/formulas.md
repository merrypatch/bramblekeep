# Fórmulas

Una columna **Fórmula** calcula su valor a partir de las demás columnas de la fila.
Es de solo lectura, se recalcula mientras escribes, y se usa en filtros,
ordenamientos y gráficos como cualquier otra columna.

## Leer una propiedad

`prop("Nombre de columna")` devuelve el valor de esa columna para la fila actual. El
nombre es el visible, y distingue mayúsculas.

```
prop("Precio") * 1.2
```

## Operadores

Aritmética `+ - * / % ^`, comparaciones `== != < <= > >=`. La concatenación de
texto pasa por `concat` (más abajo).

## Funciones

**Lógica** — `if(condición, entonces, si_no)`, `and(a, b, …)`, `or(a, b, …)`,
`not(x)`, `empty(x)`.

**Números** — `round(n, [decimales])`, `abs(n)`, `floor(n)`, `ceil(n)`, `sqrt(n)`,
`pow(n, p)`, `min(a, b, …)`, `max(a, b, …)`, `sum(a, b, …)`, `number(x)`.

**Texto** — `concat(a, b, …)`, `text(x)`, `len(s)`, `upper(s)`, `lower(s)`,
`trim(s)`, `contains(s, aguja)`, `replace(s, de, a)`,
`substring(s, inicio, [fin])`.

**Fechas** — `now()`, `year(d)`, `month(d)`, `day(d)`.

## Ejemplos

```
if(prop("Nota") >= 10, "Aprobado", "Suspenso")
round(prop("Precio") * 1.2, 2)
concat(prop("Nombre"), " ", prop("Apellido"))
if(empty(prop("Notas")), "por documentar", "ok")
year(prop("Fecha"))
```

## Errores

Una función desconocida, un paréntesis que falta o un número de argumentos erróneo
se señala donde escribes, y la celda muestra el error en lugar de un valor
silenciosamente equivocado. El editor lista cada función con su firma y un ejemplo,
así que rara vez hay que recordar la ortografía exacta.
