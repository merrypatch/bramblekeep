## Bramblekeep v0.10.0

Charts can read a series of measurements taken during the same day.

### Added

- **Group a chart by hour.** Chart view → *Group dates* → **By hour**. Until now the
  finest grouping was the day, so several readings of the same day — a temperature
  taken at 01:50, at 12:30 and at 23:00 — collapsed into a single point, hiding
  exactly what you wanted to see. Readings that fall in the same hour are still
  aggregated together (pick *Maximum* to keep the peak).
  - The hour axis deliberately does **not** fill the empty hours between readings:
    24 slots a day would drown a handful of points. It plots the hours that carry a
    row, in chronological order.
  - A date column without the *time* option is grouped at midnight.

### Fixed

- **A period without any data no longer counts as zero.** On a continuous time axis,
  a missing bucket was aggregated to `0` whatever the aggregate — so a day without a
  reading dragged the curve down to 0°C. An average, a minimum or a maximum of
  nothing does not exist: the chart now leaves a hole there. A **count** and a
  **sum** still report `0`, because no row genuinely does mean none. A cumulative or
  remaining transform treats a hole as no contribution and stays continuous.
- **The value axis no longer forces 0 into view** for an average / minimum / maximum
  of a measured column. A body temperature going from 39.1 to 40.3 was a flat line
  pinned to the top of a 0-to-40 axis. Counts, sums and transforms keep their
  zero-based axis, where it is the honest reading.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app Update
  button, which works again since 0.9.2. **Bare metal:** re-run the installer, or the
  Update button.
- Existing chart views are untouched: *By day* stays the default grouping, and only
  the empty buckets change value (from `0` to a hole) on average / min / max charts.

No migration.

### Notes

- Charts read the rows of the view they live in, filters included — filter on a person
  to get a single curve, or split into series by that column to compare several.
- A number column's *Target value (chart)* still draws its dashed reference line on
  line, area and radar charts.
