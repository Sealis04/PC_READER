// Package locallog is the agent's local log: a small SQLite file in the app data folder shared
// by the desktop app and the CLI. Entries wait here until the server asks for them (send_logs);
// the upload deletes only the entries the server confirms. Never put tokens or personal
// details in a message.
package locallog

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver: no CGO for the CLI
)

// Cap is how many entries are kept; the oldest are dropped past it, with a warning entry.
const Cap = 5000

// Levels and categories match the contract (logs.request).
const (
	Error   = "error"
	Warning = "warning"
	Info    = "info"

	Scan   = "scan"
	Sync   = "sync"
	Signup = "signup"
	Update = "update"
	System = "system"
)

// Entry is one log line. ID is the local_entry_id sent to the server: it only ever increases.
type Entry struct {
	ID       int64
	LoggedAt time.Time
	Level    string
	Category string
	Message  string
}

type Store struct {
	db  *sql.DB
	cap int
	now func() time.Time
	mu  sync.Mutex // serialises Add so trimming and its warning are one step
}

// DefaultFile is the log's file name inside the app data folder.
const DefaultFile = "log.db"

// Open opens (creating if needed) the log at path.
func Open(path string) (*Store, error) {
	return open(path, Cap)
}

func open(path string, limit int) (*Store, error) {
	dsn := filepath.ToSlash(path) + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection: the UI and the listener share a Store, and SQLite writers queue anyway.
	db.SetMaxOpenConns(1)
	// AUTOINCREMENT keeps ids increasing even after the newest rows are deleted.
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS entries (
		id        INTEGER PRIMARY KEY AUTOINCREMENT,
		logged_at TEXT NOT NULL,
		level     TEXT NOT NULL,
		category  TEXT NOT NULL,
		message   TEXT NOT NULL
	)`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open local log: %w", err)
	}
	return &Store{db: db, cap: limit, now: time.Now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

const maxMessage = 1000 // the contract's limit

// Add appends an entry, dropping the oldest ones (and recording a warning) when the log is full.
func (s *Store) Add(level, category, message string) error {
	if len(message) > maxMessage {
		message = message[:maxMessage]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	insert := func(level, category, message string) error {
		_, err := tx.Exec(`INSERT INTO entries (logged_at, level, category, message) VALUES (?, ?, ?, ?)`,
			s.now().UTC().Format(time.RFC3339), level, category, message)
		return err
	}
	if err := insert(level, category, message); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM entries`).Scan(&count); err != nil {
		return err
	}
	if count > s.cap {
		// Leave room for the warning so the log ends exactly at the cap.
		drop := count - s.cap + 1
		if _, err := tx.Exec(`DELETE FROM entries WHERE id IN (SELECT id FROM entries ORDER BY id LIMIT ?)`, drop); err != nil {
			return err
		}
		if err := insert(Warning, System, fmt.Sprintf("Local log was full: dropped the %d oldest entries", drop)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Next returns up to limit entries, oldest first.
func (s *Store) Next(limit int) ([]Entry, error) {
	rows, err := s.db.Query(`SELECT id, logged_at, level, category, message FROM entries ORDER BY id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		var at string
		if err := rows.Scan(&e.ID, &at, &e.Level, &e.Category, &e.Message); err != nil {
			return nil, err
		}
		e.LoggedAt, _ = time.Parse(time.RFC3339, at)
		out = append(out, e)
	}
	return out, rows.Err()
}

// Delete removes the entries with these ids (the ones the server confirmed).
func (s *Store) Delete(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, id := range ids {
		if _, err := tx.Exec(`DELETE FROM entries WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) Count() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM entries`).Scan(&n)
	return n, err
}
