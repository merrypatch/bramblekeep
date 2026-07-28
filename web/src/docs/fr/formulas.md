# Formules

Une colonne **Formule** calcule sa valeur à partir des autres colonnes de la
ligne. Elle est en lecture seule, recalculée à la frappe, et utilisable dans les
filtres, les tris et les graphiques comme n'importe quelle colonne.

## Lire une propriété

`prop("Nom de colonne")` renvoie la valeur de cette colonne pour la ligne
courante. Le nom est celui affiché, et il est sensible à la casse.

```
prop("Prix") * 1.2
```

## Opérateurs

Arithmétique `+ - * / % ^`, comparaisons `== != < <= > >=`. La concaténation de
texte passe par `concat` (voir plus bas).

## Fonctions

**Logique** — `if(condition, alors, sinon)`, `and(a, b, …)`, `or(a, b, …)`,
`not(x)`, `empty(x)`.

**Nombres** — `round(n, [décimales])`, `abs(n)`, `floor(n)`, `ceil(n)`, `sqrt(n)`,
`pow(n, p)`, `min(a, b, …)`, `max(a, b, …)`, `sum(a, b, …)`, `number(x)`.

**Texte** — `concat(a, b, …)`, `text(x)`, `len(s)`, `upper(s)`, `lower(s)`,
`trim(s)`, `contains(s, aiguille)`, `replace(s, de, vers)`,
`substring(s, début, [fin])`.

**Dates** — `now()`, `year(d)`, `month(d)`, `day(d)`.

## Exemples

```
if(prop("Note") >= 10, "Admis", "Recalé")
round(prop("Prix") * 1.2, 2)
concat(prop("Prénom"), " ", prop("Nom"))
if(empty(prop("Notes")), "à documenter", "ok")
year(prop("Date"))
```

## Erreurs

Une fonction inconnue, une parenthèse manquante ou un nombre d'arguments erroné
est signalé là où vous écrivez, et la cellule affiche l'erreur plutôt qu'une
valeur fausse silencieuse. L'éditeur liste chaque fonction avec sa signature et un
exemple, ce qui évite de retenir l'orthographe exacte.
