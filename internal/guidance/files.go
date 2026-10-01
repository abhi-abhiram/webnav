package guidance

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"discord-automation/internal/model"
	"github.com/gofrs/flock"
	"go.yaml.in/yaml/v3"
)

type Document struct {
	Aliases     map[string]string `json:"aliases" yaml:"aliases"`
	Conventions string            `json:"conventions" yaml:"conventions"`
}
type Versioned struct {
	Document Document `json:"document"`
	Revision string   `json:"revision"`
}
type Files struct{ Root string }

func (f Files) path(account, server string) (string, error) {
	if err := model.ValidateAccount(account); err != nil {
		return "", err
	}
	if err := model.ValidateID(server); err != nil {
		return "", err
	}
	return filepath.Join(f.Root, "servers", account, server+".yaml"), nil
}
func revision(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func Validate(d Document) error {
	if len(d.Conventions) > 32768 || len(d.Aliases) > 500 {
		return fmt.Errorf("guidance exceeds size limits")
	}
	for alias, id := range d.Aliases {
		if strings.TrimSpace(alias) != alias || alias == "" || len(alias) > 128 {
			return fmt.Errorf("invalid alias")
		}
		if err := model.ValidateID(id); err != nil {
			return err
		}
	}
	return nil
}
func (f Files) Get(account, server string) (Versioned, error) {
	p, err := f.path(account, server)
	if err != nil {
		return Versioned{}, err
	}
	b, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return Versioned{Document: Document{Aliases: map[string]string{}}}, nil
	}
	if err != nil {
		return Versioned{}, err
	}
	if len(b) > 65536 {
		return Versioned{}, fmt.Errorf("guidance file too large")
	}
	var d Document
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err = dec.Decode(&d); err != nil {
		return Versioned{}, err
	}
	if d.Aliases == nil {
		d.Aliases = map[string]string{}
	}
	if err = Validate(d); err != nil {
		return Versioned{}, err
	}
	return Versioned{Document: d, Revision: revision(b)}, nil
}

// Update requires the revision returned by Get; an empty revision creates a new file.
func (f Files) Update(ctx context.Context, account, server, expected string, d Document) (Versioned, error) {
	if err := Validate(d); err != nil {
		return Versioned{}, err
	}
	p, err := f.path(account, server)
	if err != nil {
		return Versioned{}, err
	}
	if err = os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return Versioned{}, err
	}
	lock := flock.New(p + ".lock")
	ok, err := lock.TryLockContext(ctx, 25*time.Millisecond)
	if err != nil {
		return Versioned{}, err
	}
	if !ok {
		return Versioned{}, ctx.Err()
	}
	defer lock.Unlock()
	old, err := f.Get(account, server)
	if err != nil {
		return Versioned{}, err
	}
	if old.Revision != expected {
		return Versioned{}, fmt.Errorf("revision conflict: read current guidance before editing")
	}
	b, err := yaml.Marshal(d)
	if err != nil {
		return Versioned{}, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".guidance-*")
	if err != nil {
		return Versioned{}, err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(b); err != nil {
		tmp.Close()
		return Versioned{}, err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return Versioned{}, err
	}
	if err = tmp.Close(); err != nil {
		return Versioned{}, err
	}
	if err = os.Rename(tmp.Name(), p); err != nil {
		return Versioned{}, err
	}
	return f.Get(account, server)
}
