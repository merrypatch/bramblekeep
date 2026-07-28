# Bases de données

Une base de données est une page dont les enfants sont ses lignes. Chaque ligne
est une vraie page : vous pouvez l'ouvrir et écrire dedans, avec le même éditeur
que partout ailleurs. Les colonnes sont les propriétés de la ligne, et une **vue**
est une façon de les regarder.

## En créer une

**Ajouter → Base de données** dans la barre latérale crée une base pleine page.
Dans une page, `/` propose trois variantes :

- **Base de données** — une base en sous-page, référencée par une carte
- **Base en ligne** — rendue directement dans la page que vous écrivez
- **Lier une base existante** — la même base affichée à un second endroit

## Types de colonnes

Texte, Nombre, Case à cocher, Sélection, Multi-sélection, État, Date, Téléphone,
E-mail, URL, Fichiers & médias, Relation, Rollup, Formule.

Quatre autres sont calculées depuis l'item lui-même et en lecture seule : **Date de
création**, **Créé par**, **Dernière modification**, **Modifié par**.

Quelques spécificités utiles :

- **État** porte des groupes (à faire / en cours / terminé), ce qui rend possibles
  le kanban et le graphique burndown
- **Date** accepte un début, une fin et une heure
- **Nombre** accepte une valeur cible, tracée en pointillés sur les graphiques
- **Sélection** et **État** ont des options colorées, réutilisées par le tableau
  et les graphiques

## Vues

Six, chacune avec ses propres filtres, son tri et sa recherche :

- **Table** — le tableur, avec un pied par colonne qui calcule une valeur
  (quantité, vides, uniques, somme, moyenne, min, max, pourcentages)
- **Tableau (kanban)** — groupé par une colonne Sélection ou État, glissez une
  carte pour changer sa valeur
- **Calendrier** — par une colonne Date, en mode mois, semaine ou jour
- **Grille (galerie)** — des cartes, pour les lignes dont l'image compte
- **Graphique** — voir le chapitre *Graphiques*
- **Graphe (relations)** — voir le chapitre *Vue graphe*

Les lignes se réordonnent à la main dans la vue table (glissez la poignée), et les
colonnes se redimensionnent et se réordonnent de la même façon.

## Filtres

Un filtre est un groupe de conditions combinées par **et** / **ou**, et les
groupes s'imbriquent. Les opérateurs dépendent du type : contient, est, n'est pas,
est vide, n'est pas vide pour du texte ; les comparaisons pour les nombres ;
l'une de / aucune de pour les sélections ; avant / après / est pour les dates.

Les filtres existent à deux niveaux : sur la **base** (s'applique partout) et sur
la **vue** (cette vue seulement).

## Une base intégrée lit sa page hôte

Une base intégrée dans une page peut filtrer selon la page où elle se trouve : la
valeur d'une condition peut référencer le titre ou une propriété de la **page
hôte**. Le même bloc déposé dans deux pages différentes affiche alors deux
sous-ensembles différents — une base, une définition, plusieurs lectures
contextuelles.

## Lignes

Cliquer une ligne l'ouvre comme une page. Une ligne a aussi un **panneau de
propriétés** pour ses colonnes, et vous pouvez la consulter en aperçu sans quitter
la vue.

Une base peut définir des **modèles** : une nouvelle ligne démarre préremplie,
colonnes et contenu compris.

## Import

**Importer un CSV** associe chaque colonne du CSV à une colonne existante, à une
nouvelle colonne, ou l'ignore, et ajoute les lignes sans toucher aux existantes.
