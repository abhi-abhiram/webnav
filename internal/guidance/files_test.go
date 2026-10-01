package guidance

import (
	"context"
	"testing"
)

func TestRevisionCheckedUpdates(t *testing.T) {
	f := Files{Root: t.TempDir()}
	ctx := context.Background()
	first, err := f.Get("personal", "1")
	if err != nil || first.Revision != "" {
		t.Fatal(first, err)
	}
	d := Document{Aliases: map[string]string{"general": "2"}, Conventions: "Do not send messages."}
	saved, err := f.Update(ctx, "personal", "1", "", d)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision == "" || saved.Document.Conventions != d.Conventions {
		t.Fatal(saved)
	}
	if _, err = f.Update(ctx, "personal", "1", "", d); err == nil {
		t.Fatal("accepted stale revision")
	}
	d.Conventions = "New note"
	if _, err = f.Update(ctx, "personal", "1", saved.Revision, d); err != nil {
		t.Fatal(err)
	}
	if _, err = f.Get("personal", "../escape"); err == nil {
		t.Fatal("path traversal accepted")
	}
	if _, err = f.Update(ctx, "personal", "1", "", Document{Aliases: map[string]string{"bad": "javascript:alert(1)"}}); err == nil {
		t.Fatal("invalid alias target accepted")
	}
}
