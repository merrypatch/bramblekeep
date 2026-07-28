# Relations et rollups

Une **relation** relie les lignes de deux bases. Un **rollup** ramène une valeur à
travers ce lien et l'agrège. Ensemble, ils transforment un ensemble de tables en
un modèle.

## Créer une relation

Ajoutez une colonne, choisissez le type **Relation**, puis la base cible. Deux
options comptent :

- **unique** — la cellule contient au plus une ligne liée (une mesure appartient à
  une personne)
- **bidirectionnelle** — la base cible reçoit une colonne réciproque, tenue à
  jour : lier A à B depuis un côté met les deux à jour

Une cellule de relation stocke des identifiants et affiche les titres des lignes
liées. Supprimer une ligne liée ne laisse pas de texte fantôme : la pastille
disparaît.

## Rollups

Ajoutez une colonne, choisissez le type **Rollup**, puis répondez à trois
questions :

1. **quelle relation** suivre (une colonne relation de cette base)
2. **quelle colonne** des lignes liées lire — n'importe laquelle, y compris leur
   titre
3. **quel agrégat** appliquer : quantité, somme, moyenne, min, max, ou *valeurs*
   (la liste elle-même, concaténée)

Exemples : le nombre de mesures par personne, la température moyenne par personne,
le montant total des factures d'un client.

Un rollup est en lecture seule et recalculé à la lecture : c'est une lentille sur
les lignes liées, jamais une copie stockée qui pourrait devenir fausse.

## À utiliser partout

- les **filtres** et les **tris** acceptent un rollup ou une relation comme
  n'importe quelle colonne
- les **graphiques** peuvent séparer les séries ou grouper l'axe X par une
  relation, en affichant les titres des pages liées (une courbe par personne, par
  exemple)
- la **vue graphe** dessine les cellules de relation comme des arêtes
- **Exporter avec les relations (ZIP)** emporte les bases liées avec la base
  principale, pour que les relations survivent à un export et un réimport ailleurs
