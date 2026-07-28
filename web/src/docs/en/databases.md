# Databases

A database is a page whose children are its rows. Each row is a real page: you
can open it and write inside it, with the same editor as anywhere else. Columns
are the row's properties, and a **view** is a way of looking at them.

## Create one

**Add → Database** in the sidebar creates a full-page database. Inside a page,
`/` offers three variants:

- **Database** — a sub-page database, referenced by a card
- **Inline database** — rendered directly in the page you are writing
- **Link an existing database** — the same database displayed in a second place

## Column types

Text, Number, Checkbox, Select, Multi-select, Status, Date, Phone, Email, URL,
Files & media, Relation, Rollup, Formula.

Four more are computed from the item itself and are read-only: **Created time**,
**Created by**, **Last edited time**, **Last edited by**.

A few specifics worth knowing:

- **Status** carries groups (to do / in progress / done), which is what makes a
  board and a burndown chart possible
- **Date** can hold a start, an end and a time
- **Number** accepts a target value, drawn as a dashed line on charts
- **Select** and **Status** options have colours, reused by the board and the
  charts

## Views

Six, each with its own filters, its own sort and its own search:

- **Table** — the spreadsheet, with a footer per column that computes a value
  (count, empty, unique, sum, average, min, max, percentages)
- **Board** — kanban grouped by a Select or Status column, drag a card to change
  its value
- **Calendar** — by a Date column, in month, week or day mode
- **Gallery** — cards, for rows whose cover image matters
- **Chart** — see the *Charts* chapter
- **Graph** — see the *Graph view* chapter

Rows can be reordered by hand in the table view (drag the handle), and columns
resized and reordered the same way.

## Filters

A filter is a group of conditions, combined with **and** / **or**, and groups can
be nested. Operators depend on the column type: contains, is, is not, is empty,
is not empty for text; the comparisons for numbers; any of / none of for selects;
before / after / is for dates.

Filters live at two levels: on the **database** (applies everywhere) and on the
**view** (applies to that view only).

## An embedded database reads its host page

A database embedded in a page can filter on the page it sits in: a condition's
value can reference the **host page's** title or one of its properties. The same
block dropped in two different pages then shows two different subsets — one
database, one definition, many contextual readings.

## Rows

Clicking a row opens it as a page. A row also has a **properties panel** for its
columns, and you can peek at a row without leaving the view.

A database can define **templates**: a new row starts pre-filled, columns and
content included.

## Import

**Import CSV** maps each CSV column onto an existing column, a new column, or
ignores it, and appends the rows without touching the existing ones.
