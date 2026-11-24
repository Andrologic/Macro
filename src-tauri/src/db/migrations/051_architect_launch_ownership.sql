CREATE TABLE architect_launch_database (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    path TEXT NOT NULL
);
