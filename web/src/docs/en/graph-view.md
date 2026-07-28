# Graph view

The **Graph** view answers a question a table cannot: how is this connected to
that? It exists in two places, with the same interface.

## In a database

Nodes are the rows of the database, plus the rows they point at in related
databases. Edges come from two sources:

- **relation cells** — a link you declared
- **page references** — an `@` mention or a page card inside a row's content

So a graph shows both the structure you designed and the connections your writing
created.

The legend tells the two kinds of node apart: rows of this database, and linked
rows living elsewhere.

## In All pages

Nodes are your pages and your databases, edges are the references between them.
Pages are drawn as **circles**, databases as **rounded squares** — a shape rather
than a shade, so the distinction holds in both themes and for colour-blind
readers. The legend states it.

## Interacting

- **click** a node to highlight it and its direct neighbours, dimming the rest
- **click again** (or elsewhere) to clear the highlight
- **drag** a node to pin it where you want it
- the **spacing** slider spreads the layout out or packs it tight
- **+ / − / fit** zoom, and the view auto-fits the graph when it settles
- a node's size grows with its number of connections
- **double-click** a node to open the page or the row (a single click only
  highlights, so exploring never navigates away by accident)

The layout is a force simulation computed in the browser: nodes repel each other,
edges pull like springs, a mild gravity keeps everything centred. Nothing is
sent anywhere to draw it.
