# Formulas

A **Formula** column computes its value from the other columns of the row. It is
read-only, recomputed as you type, and usable in filters, sorts and charts like
any other column.

## Reading a property

`prop("Column name")` returns the value of that column for the current row. The
name is the visible one, and it is case-sensitive.

```
prop("Price") * 1.2
```

## Operators

Arithmetic `+ - * / % ^`, comparisons `== != < <= > >=`. Text concatenation goes
through `concat` (see below).

## Functions

**Logic** — `if(condition, then, else)`, `and(a, b, …)`, `or(a, b, …)`, `not(x)`,
`empty(x)`.

**Numbers** — `round(n, [decimals])`, `abs(n)`, `floor(n)`, `ceil(n)`, `sqrt(n)`,
`pow(n, p)`, `min(a, b, …)`, `max(a, b, …)`, `sum(a, b, …)`, `number(x)`.

**Text** — `concat(a, b, …)`, `text(x)`, `len(s)`, `upper(s)`, `lower(s)`,
`trim(s)`, `contains(s, needle)`, `replace(s, from, to)`,
`substring(s, start, [end])`.

**Dates** — `now()`, `year(d)`, `month(d)`, `day(d)`.

## Examples

```
if(prop("Score") >= 10, "Pass", "Fail")
round(prop("Price") * 1.2, 2)
concat(prop("First name"), " ", prop("Last name"))
if(empty(prop("Notes")), "to document", "ok")
year(prop("Date"))
```

## Errors

An unknown function, a missing parenthesis or a wrong argument count is reported
where you type it, and the cell shows the error rather than a silent wrong value.
The editor lists every function with its signature and an example, so you rarely
have to remember the exact spelling.
