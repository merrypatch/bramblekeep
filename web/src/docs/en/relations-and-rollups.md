# Relations and rollups

A **relation** links rows of two databases. A **rollup** brings a value back
across that link and aggregates it. Together they are what turns a set of tables
into a model.

## Create a relation

Add a column, choose type **Relation**, then pick the target database. Two
options matter:

- **single** — the cell holds at most one linked row (a measurement belongs to one
  person)
- **bidirectional** — the target database gets a reciprocal column, kept in sync:
  linking A to B from either side updates both

A relation cell stores identifiers, and displays the linked rows' titles. Deleting
a linked row leaves no dangling text: the chip simply disappears.

## Rollups

Add a column, choose type **Rollup**, then answer three questions:

1. **which relation** to follow (a relation column of this database)
2. **which column** of the linked rows to read — any column, including their title
3. **which aggregate** to apply: count, sum, average, min, max, or *values*
   (the list itself, joined)

Examples: the number of measurements per person, the average temperature per
person, the total amount of the invoices of a client.

A rollup is read-only and recomputed on read: it is a lens over the linked rows,
never a stored copy that could go stale.

## Use them everywhere

- **filters** and **sorts** accept a rollup or a relation like any column
- **charts** can split series or group the X axis by a relation, showing the
  linked page titles (one curve per person, for instance)
- the **graph view** draws relation cells as edges
- **Export with relations (ZIP)** carries the linked databases with the main one,
  so relations survive an export and re-import elsewhere
