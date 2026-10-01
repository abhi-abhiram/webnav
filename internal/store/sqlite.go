package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"discord-automation/internal/model"
	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	// Create privately before SQLite opens it; never store browser credentials here.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	_, err = db.Exec(`
PRAGMA busy_timeout=5000;
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS channels (
 account TEXT NOT NULL, server_id TEXT NOT NULL, id TEXT NOT NULL,
 name TEXT NOT NULL, last_observed TEXT NOT NULL,
 PRIMARY KEY(account, server_id, id)
);
CREATE TABLE IF NOT EXISTS exploration (
 account TEXT NOT NULL, server_id TEXT NOT NULL, status TEXT NOT NULL,
 observed INTEGER NOT NULL, visited INTEGER NOT NULL, last_observed TEXT NOT NULL,
 PRIMARY KEY(account, server_id)
);
PRAGMA user_version=1;`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }

func validate(account, server string) error {
	if err := model.ValidateAccount(account); err != nil {
		return err
	}
	return model.ValidateID(server)
}

// Observe never interprets missing visible channels as deletion.
func (s *Store) Observe(ctx context.Context, account, server string, channels []model.Channel, progress model.Exploration) error {
	if err := validate(account, server); err != nil {
		return err
	}
	for _, c := range channels {
		if err := model.ValidateID(c.ID); err != nil {
			return err
		}
		if c.ServerID != server {
			return fmt.Errorf("cross-server observation rejected")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, c := range channels {
		_, err = tx.ExecContext(ctx, `INSERT INTO channels VALUES(?,?,?,?,?)
ON CONFLICT(account,server_id,id) DO UPDATE SET
name=CASE WHEN excluded.name='' THEN channels.name ELSE excluded.name END,
last_observed=excluded.last_observed`, account, server, c.ID, c.Name, now)
		if err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO exploration VALUES(?,?,?,?,?,?)
ON CONFLICT(account,server_id) DO UPDATE SET status=excluded.status,
observed=excluded.observed,visited=excluded.visited,last_observed=excluded.last_observed`,
		account, server, progress.Status, progress.Observed, progress.Visited, now)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) Get(ctx context.Context, account, server string) (model.Knowledge, error) {
	k := model.Knowledge{Account: account, ServerID: server, Channels: []model.Channel{}}
	if err := validate(account, server); err != nil {
		return k, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT id,name,last_observed FROM channels WHERE account=? AND server_id=? ORDER BY id", account, server)
	if err != nil {
		return k, err
	}
	for rows.Next() {
		c := model.Channel{ServerID: server}
		if err = rows.Scan(&c.ID, &c.Name, &c.LastObserved); err != nil {
			rows.Close()
			return k, err
		}
		c.URL = model.ChannelURL(server, c.ID)
		k.Channels = append(k.Channels, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return k, err
	}
	p := &model.Exploration{}
	err = s.db.QueryRowContext(ctx, "SELECT status,observed,visited,last_observed FROM exploration WHERE account=? AND server_id=?", account, server).Scan(&p.Status, &p.Observed, &p.Visited, &p.LastObserved)
	if err == sql.ErrNoRows {
		return k, nil
	}
	if err != nil {
		return k, err
	}
	k.Exploration = p
	return k, nil
}
