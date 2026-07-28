# Graphiques

Une vue **Graphique** trace les lignes d'une base. Tout se choisit dans
*Paramètres*, et chaque vue graphique garde sa configuration et ses filtres.

## Formes

Barres, courbe, aires, secteurs, radar, radial. Les barres peuvent être
**empilées** quand le graphique est séparé en séries.

## Axe X

Au choix : le **titre** de la ligne, une colonne Sélection, État, Texte, Formule,
Rollup, **Relation** ou Multi-sélection, une **Date**, ou les dates de création /
dernière modification.

Sur un axe de dates, les relevés sont groupés **par heure, jour, semaine ou
mois**. Les regroupements larges comblent les trous pour garder une frise
continue ; le regroupement par heure ne trace que les heures qui portent
réellement une ligne, sinon quelques relevés se noieraient dans 24 créneaux par
jour.

Un axe **relation** ou **multi-sélection** place une ligne dans chaque bucket
auquel elle appartient : un relevé lié à deux personnes apparaît sous les deux.

## Valeurs

L'agrégat est **quantité**, ou **somme / moyenne / min / max** d'une colonne
numérique.

Un bucket vide ne vaut pas toujours zéro : une quantité et une somme de rien font
honnêtement 0, mais une moyenne, un minimum ou un maximum de rien n'existent pas.
La courbe montre alors un **trou** au lieu de plonger à zéro — un jour sans relevé
de température n'est pas un jour à 0 °C.

## Séries

*Séparer en séries* trace une courbe (ou un groupe de barres) par valeur d'une
colonne : Sélection, État, Formule, Texte, **Relation** ou **Multi-sélection**.
Avec une relation, la légende affiche les titres des pages liées.

Une ligne dont la cellule contient plusieurs valeurs alimente chaque série
correspondante.

## Transformations

- **Cumulatif** — le total courant le long de l'axe
- **Restant** — le total moins le total courant
- **Burndown** — part du total de toutes les lignes et décroît le long de l'axe à
  mesure que des lignes atteignent un état *terminé*, avec une ligne **idéale**
  en pointillés en option

Une colonne numérique porteuse d'une **cible** ajoute une ligne constante en
pointillés sur les formes continues (courbe, aires, radar, radial).

## Tri

Par axe (chronologique ou alphabétique) ou **par valeur**, sur un graphique à une
seule série sans axe de dates.
