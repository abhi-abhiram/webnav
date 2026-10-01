package store

import (
	"context"
	"path/filepath"
	"testing"

	"discord-automation/internal/model"
)

func TestObserveIsolationAndRetention(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "knowledge.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	c := model.Channel{ID: "2", ServerID: "1", Name: "general"}
	if err = s.Observe(ctx, "personal", "1", []model.Channel{c}, model.Exploration{Status: "partial", Observed: 1}); err != nil {
		t.Fatal(err)
	}
	if err = s.Observe(ctx, "personal", "1", nil, model.Exploration{Status: "partial"}); err != nil {
		t.Fatal(err)
	}
	k, err := s.Get(ctx, "personal", "1")
	if err != nil || len(k.Channels) != 1 {
		t.Fatalf("lost observed channel: %+v %v", k, err)
	}
	other, err := s.Get(ctx, "work", "1")
	if err != nil || len(other.Channels) != 0 {
		t.Fatalf("account leakage: %+v %v", other, err)
	}
	c.ServerID = "3"
	if err = s.Observe(ctx, "personal", "1", []model.Channel{c}, model.Exploration{}); err == nil {
		t.Fatal("accepted cross-server data")
	}
	if _, err = s.Get(ctx, "../bad", "1"); err == nil {
		t.Fatal("accepted invalid account")
	}
}
