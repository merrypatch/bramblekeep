# Vue graphe

La vue **Graphe** répond à une question qu'un tableau ne sait pas poser : qu'est-ce
qui est relié à quoi ? Elle existe à deux endroits, avec la même interface.

## Dans une base de données

Les nœuds sont les lignes de la base, plus les lignes qu'elles pointent dans les
bases liées. Les arêtes viennent de deux sources :

- les **cellules de relation** — un lien que vous avez déclaré
- les **références de page** — une mention `@` ou une carte de page dans le
  contenu d'une ligne

Un graphe montre donc à la fois la structure que vous avez conçue et les liens que
votre écriture a créés.

La légende distingue les deux sortes de nœuds : les lignes de cette base, et les
lignes liées qui vivent ailleurs.

## Dans « Toutes les pages »

Les nœuds sont vos pages et vos bases, les arêtes les références entre elles. Les
pages sont des **cercles**, les bases des **carrés arrondis** — une forme plutôt
qu'une nuance, pour que la distinction tienne dans les deux thèmes et pour un
lecteur daltonien. La légende le rappelle.

## Interagir

- **cliquez** un nœud pour le mettre en évidence avec ses voisins directs, le
  reste s'estompe
- **cliquez à nouveau** (ou ailleurs) pour tout rallumer
- **glissez** un nœud pour l'épingler où vous voulez
- le curseur **espacement** étale ou resserre la disposition
- **+ / − / ajuster** pour le zoom, et la vue cadre automatiquement le graphe
  quand il se stabilise
- la taille d'un nœud croît avec son nombre de connexions
- un **double-clic** ouvre la page ou la ligne (un clic simple ne fait que
  mettre en évidence, donc explorer ne vous fait jamais quitter la vue par
  accident)

La disposition est une simulation de forces calculée dans le navigateur : les
nœuds se repoussent, les arêtes tirent comme des ressorts, une gravité douce garde
l'ensemble centré. Rien n'est envoyé ailleurs pour la dessiner.
