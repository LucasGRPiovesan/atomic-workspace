/**
 * Versioned schema for <project>/.atomic/memory.db.
 * MIGRATIONS[i] upgrades schema_version i → i+1. Never edit a shipped entry; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE files (
    path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    lang TEXT NOT NULL,
    loc INTEGER NOT NULL,
    size INTEGER NOT NULL,
    is_test INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE symbols (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    exported INTEGER NOT NULL DEFAULT 0,
    signature TEXT,
    parent TEXT
  );
  CREATE INDEX idx_symbols_path ON symbols(path);
  CREATE INDEX idx_symbols_name ON symbols(name COLLATE NOCASE);

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    from_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    specifier TEXT NOT NULL,
    resolved TEXT,
    names TEXT NOT NULL DEFAULT '[]',
    external INTEGER NOT NULL DEFAULT 0,
    line INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_imports_from ON imports(from_path);
  CREATE INDEX idx_imports_resolved ON imports(resolved);

  CREATE TABLE routes (
    rowid_ INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    line INTEGER NOT NULL,
    method TEXT NOT NULL,
    pattern TEXT NOT NULL,
    framework TEXT NOT NULL,
    handler TEXT,
    handler_symbol_id TEXT
  );
  CREATE INDEX idx_routes_path ON routes(path);
  CREATE INDEX idx_routes_id ON routes(id);

  -- scope 'file' = extracted from a source file (replaced with it); 'schema' = project-level (setSchemaEntities)
  CREATE TABLE entities (
    rowid_ INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    fields TEXT NOT NULL DEFAULT '[]',
    relations TEXT NOT NULL DEFAULT '[]',
    scope TEXT NOT NULL DEFAULT 'file'
  );
  CREATE INDEX idx_entities_path ON entities(path);
  CREATE INDEX idx_entities_scope ON entities(scope);
  CREATE INDEX idx_entities_name ON entities(name);

  CREATE TABLE tests (
    rowid_ INTEGER PRIMARY KEY,
    path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    line INTEGER NOT NULL,
    name TEXT NOT NULL,
    framework TEXT
  );
  CREATE INDEX idx_tests_path ON tests(path);

  CREATE TABLE env_vars (
    name TEXT NOT NULL,
    path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    PRIMARY KEY (name, path)
  );

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT,
    data TEXT,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    anchors TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    author TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_nodes_kind ON nodes(kind);
  CREATE INDEX idx_nodes_origin ON nodes(origin);
  CREATE INDEX idx_nodes_status ON nodes(status);

  -- denormalised anchor paths so "nodes anchored on path" is an index lookup
  CREATE TABLE node_anchors (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    path TEXT NOT NULL
  );
  CREATE INDEX idx_node_anchors_path ON node_anchors(path);
  CREATE INDEX idx_node_anchors_node ON node_anchors(node_id);

  CREATE TABLE edges (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    rel TEXT NOT NULL,
    origin TEXT NOT NULL,
    UNIQUE (from_id, to_id, rel)
  );
  CREATE INDEX idx_edges_to ON edges(to_id);
  CREATE INDEX idx_edges_origin ON edges(origin);

  CREATE TABLE changes (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX idx_changes_at ON changes(at);

  -- FTS5 (standalone tables; rowid mirrors the content table rowid)
  CREATE VIRTUAL TABLE nodes_fts USING fts5(title, summary, body, tags, tokenize = 'unicode61 remove_diacritics 2');
  CREATE VIRTUAL TABLE symbols_fts USING fts5(name, path, signature, tokenize = 'unicode61 remove_diacritics 2');

  CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, title, summary, body, tags)
    VALUES (new.rowid, new.title, new.summary, coalesce(new.body, ''),
            coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), ''));
  END;
  CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
    DELETE FROM nodes_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
    DELETE FROM nodes_fts WHERE rowid = old.rowid;
    INSERT INTO nodes_fts(rowid, title, summary, body, tags)
    VALUES (new.rowid, new.title, new.summary, coalesce(new.body, ''),
            coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), ''));
  END;
  `,
];
