package core

import (
	"context"
	"path/filepath"
	"testing"

	"discord-automation/internal/guidance"
	"discord-automation/internal/model"
	"discord-automation/internal/store"
)

type fakeBrowser struct {
	snapshots map[string]model.Snapshot
	calls     []string
}

func (b *fakeBrowser) Open(_ context.Context, url string) (model.Snapshot, error) {
	b.calls = append(b.calls, url)
	return b.snapshots[url], nil
}
func (*fakeBrowser) Close() {}
func setup(t *testing.T) (*Core, *fakeBrowser) {
	t.Helper()
	root := t.TempDir()
	s, err := store.Open(filepath.Join(root, "knowledge.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	g := guidance.Files{Root: filepath.Join(root, "guidance")}
	if err = g.Init(); err != nil {
		t.Fatal(err)
	}
	b := &fakeBrowser{snapshots: map[string]model.Snapshot{}}
	return &Core{Store: s, Guidance: g, Browser: b, LockPath: filepath.Join(root, "browser.lock")}, b
}
func TestExploreThenNavigateAlias(t *testing.T) {
	c, b := setup(t)
	ctx := context.Background()
	ch := model.Channel{ID: "2", ServerID: "1", Name: "general", URL: model.ChannelURL("1", "2")}
	other := model.Channel{ID: "3", ServerID: "1", Name: "random", URL: model.ChannelURL("1", "3")}
	b.snapshots["https://discord.com/channels/1"] = model.Snapshot{URL: ch.URL, Channels: []model.Channel{ch}}
	b.snapshots[ch.URL] = model.Snapshot{URL: ch.URL, SelectedChannelID: "2", Channels: []model.Channel{ch, other}}
	b.snapshots[other.URL] = model.Snapshot{URL: other.URL, SelectedChannelID: "3"}
	out, err := c.Explore(ctx, "personal", "1", 2, 10, 5)
	if err != nil {
		t.Fatal(err)
	}
	if out.Observed != 2 || out.Visited != 2 || out.Status != "partial" {
		t.Fatal(out)
	}
	_, err = c.Guidance.Update(ctx, "personal", "1", "", guidance.Document{Aliases: map[string]string{"home": "2"}})
	if err != nil {
		t.Fatal(err)
	}
	nav, err := c.Navigate(ctx, "personal", "1", "home")
	if err != nil || nav.Status != "verified" {
		t.Fatal(nav, err)
	}
	b.snapshots[ch.URL] = model.Snapshot{URL: "https://discord.com/login", SelectedChannelID: "2"}
	if _, err = c.Navigate(ctx, "personal", "1", "home"); err == nil {
		t.Fatal("accepted login redirect")
	}
}
func TestBudgetAndUntrustedObservations(t *testing.T) {
	c, b := setup(t)
	b.snapshots["https://discord.com/channels/1"] = model.Snapshot{URL: "https://discord.com/channels/1/2", Channels: []model.Channel{
		{ID: "2", ServerID: "1"}, {ID: "3", ServerID: "1"}, {ID: "4", ServerID: "9"}, {ID: "bad", ServerID: "1"},
	}}
	out, err := c.Explore(context.Background(), "personal", "1", 1, 1, 5)
	if err != nil {
		t.Fatal(err)
	}
	if out.Observed != 1 || out.StopReason != "node_budget" {
		t.Fatal(out)
	}
	if _, err = c.Explore(context.Background(), "personal", "1", 99, 1, 5); err == nil {
		t.Fatal("invalid depth accepted")
	}
}
func TestVerification(t *testing.T) {
	ch := model.Channel{ID: "2", ServerID: "1", Name: "general", URL: model.ChannelURL("1", "2")}
	if _, err := Verify(model.Snapshot{URL: ch.URL, Heading: "#general"}, ch, "selected_or_heading"); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(model.Snapshot{URL: ch.URL, Heading: "general"}, ch, "selected_only"); err == nil {
		t.Fatal("weak evidence accepted")
	}
	if _, err := Verify(model.Snapshot{URL: ch.URL, Heading: "random"}, ch, "selected_or_heading"); err == nil {
		t.Fatal("wrong heading accepted")
	}
}
