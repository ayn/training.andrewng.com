CREATE TABLE events (
  uid TEXT NOT NULL,
  recurrence_id TEXT NOT NULL DEFAULT '',
  component TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (uid, recurrence_id)
);
CREATE TABLE timezones (
  tzid TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE snapshots (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  first_seen INTEGER NOT NULL
);
CREATE TABLE status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_success INTEGER,
  last_attempt INTEGER,
  last_error TEXT
);
