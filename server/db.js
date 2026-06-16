const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    pr_title TEXT NOT NULL,
    head_branch TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    original_content TEXT,
    dirty INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_id, file_path),
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS file_visits (
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    visited_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, file_path),
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
`;

// Create a database connection with the schema applied. Pass ':memory:' for an
// isolated in-memory database (used by tests); a file path is created on disk.
function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  // Migration: add original_content column to existing tables.
  try { db.exec('ALTER TABLE file_edits ADD COLUMN original_content TEXT'); } catch {}
  return db;
}

module.exports = createDb;
