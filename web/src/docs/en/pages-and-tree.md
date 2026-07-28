# Pages and tree

A page can live at the root of your workspace or inside another page. Nothing
else: there are no notebooks, no folders, no special containers.

## Create a sub-page

Two ways, and they produce the same thing:

- inside a page, type `/` and choose **Sub-page** — the new page is referenced by
  a card at that spot in the text
- in the sidebar, open a page's menu (**…** or right-click) and choose **Add a
  sub-page** — no card is inserted, the page simply appears in the tree

A card left behind by the first method is a plain reference: it keeps pointing at
the page even after you move it elsewhere, and turns grey if the page becomes
unavailable to you.

## Move and reorder

- **drag a page** in the sidebar: dropping it on the upper edge of another page
  reorders it among that page's siblings, dropping it in the middle makes it a
  sub-page
- the dashed strip at the bottom of the tree pulls a page back out to the root
- **Move to…** in the page menu does the same from a phone or the keyboard

Two moves are refused, and the cursor says so: into the page's own descendance
(the branch would detach from every root) and into a database, since a page
parented to a database is one of its rows.

Moving a page in or out of a **published** subtree changes what is public. You
are asked first, in both directions.

## Find things again

- the **search field** at the top of the sidebar looks inside the content of your
  pages, not only their titles
- a **star** pins a page to Favourites — personal, invisible to others
- **Recents** keeps the last pages you opened
- **All pages** lists everything you can reach, with a search box, bulk actions
  (duplicate, favourite, delete) and a **graph** of how pages reference each other

## Links between pages

Type `@` in any page to mention another page or a database row. The mention is a
live chip: it follows the target's title.

Every mention is also read the other way round — open a page and its **backlinks**
panel lists what points at it. That is what makes the graph view meaningful.

## Icon, cover, title

Above the title, **Add an icon** takes an emoji, a Lucide icon or an image, and
**Add a cover** takes an upload, a URL or an Unsplash search (the photographer's
credit is kept and displayed). A cover can be reframed by dragging it.

## Duplicate, export, import

The page menu offers:

- **Duplicate** — the page and its whole subtree, including database rows
- **Export to Markdown**, **Export to PDF** (through the print dialog)
- for a database: **Export to CSV**, and **Export with relations (ZIP)**, which
  carries the linked databases along so the relations survive the round trip
- **Import CSV** into an existing database, **Import with relations** for a ZIP
  produced above

## Deleting is reversible

Deleting a page moves it, with its subtree, to the **Trash** (Settings → Trash).
It stays there **30 days**, then a background task destroys it for good. From the
trash you can restore a page or purge it immediately.

Each page also keeps a **history**: open the page menu → *Change history* to see
what changed, when, and by whom.
