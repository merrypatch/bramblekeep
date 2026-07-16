-- Databases (spec C1-C5, §5.1 #5): a database = a collection of pages +
-- a property schema + views. No separate engine.
--
-- An item is a DATABASE if `db_schema` is non-NULL (JSON: typed columns).
-- A database ROW is a child page (parent_item_id = the db) — it opens
-- like a full page (C5) and inherits access. Its property values live
-- in `properties` (JSON), metadata edited outside the CRDT (like title/icon/cover).
-- Both columns are opaque JSON on the server side; the structure (columns,
-- text/number/select/date/checkbox/relation types) is managed by the front-end.
ALTER TABLE items ADD COLUMN db_schema TEXT;
ALTER TABLE items ADD COLUMN properties TEXT;
