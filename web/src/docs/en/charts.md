# Charts

A **Chart** view plots the rows of a database. Everything is chosen in
*Settings*, and each chart view keeps its own configuration and its own filters.

## Shapes

Bars, line, area, pie, radar, radial. Bars can be **stacked** when the chart is
split into series.

## X axis

Any of: the row **title**, a Select, a Status, a Text, a Formula, a Rollup, a
**Relation** or a Multi-select column, a **Date**, or the created / last edited
timestamps.

On a date axis, the readings are grouped **by hour, day, week or month**. The
coarser buckets fill the gaps so the timeline stays continuous; the hour bucket
plots only the hours that actually carry a row, otherwise a handful of readings
would drown in 24 slots per day.

A **relation** or **multi-select** axis puts a row in every bucket it belongs to:
a reading linked to two people appears under both.

## Values

The aggregate is **count**, or **sum / average / min / max** of a number column.

An empty bucket is not always zero: a count and a sum of nothing are honestly 0,
but an average, a minimum or a maximum of nothing does not exist. The curve shows
a **hole** there instead of diving to zero — a day without a temperature reading
is not a day at 0°C.

## Series

*Split into series* draws one curve (or one bar group) per value of a column:
Select, Status, Formula, Text, **Relation** or **Multi-select**. With a relation,
the legend shows the linked pages' titles.

A row whose cell holds several values feeds every matching series.

## Transformations

- **Cumulative** — the running total along the axis
- **Remaining** — the total minus the running total
- **Burndown** — starts at the total of all rows and decrements along the axis as
  rows reach a *done* status, with an optional dashed **ideal** line

A number column carrying a **target** adds a dashed constant line on the
continuous shapes (line, area, radar, radial).

## Sorting

By axis (chronological or alphabetical) or **by value**, on a single-series chart
without a date axis.
