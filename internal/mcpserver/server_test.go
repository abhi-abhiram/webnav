package mcpserver

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"discord-automation/internal/core"
	"discord-automation/internal/guidance"
	"discord-automation/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "knowledge.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	g := guidance.Files{Root: filepath.Join(dir, "guidance")}
	if err = g.Init(); err != nil {
		t.Fatal(err)
	}
	srv := New(&core.Core{Store: db, Guidance: g})
	st, ct := mcp.NewInMemoryTransports()
	ss, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 8 {
		t.Fatalf("expected 8 tools, got %d", len(tools.Tools))
	}
	call := func(name string, args map[string]any) *mcp.CallToolResult {
		t.Helper()
		out, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	scope := map[string]any{"account": "personal", "server_id": "1"}
	if out := call("knowledge_get", scope); out.IsError {
		t.Fatal(out)
	}
	if out := call("knowledge_update", map[string]any{
		"account": "personal", "server_id": "1", "expected_revision": "", "document": map[string]any{"aliases": map[string]string{"home": "2"}, "conventions": "User note"},
	}); out.IsError {
		t.Fatal(out)
	}
	if out := call("knowledge_update", map[string]any{
		"account": "personal", "server_id": "1", "expected_revision": "", "document": map[string]any{"aliases": map[string]string{}, "conventions": ""},
	}); !out.IsError {
		t.Fatal("stale revision accepted")
	}
	if out := call("knowledge_import", map[string]any{
		"account": "personal", "server_id": "1", "expected_revision": "", "yaml": "unknown_field: true",
	}); !out.IsError {
		t.Fatal("invalid YAML accepted")
	}
	if out := call("discord_navigate", map[string]any{"account": "personal", "server_id": "1", "channel": "home"}); !out.IsError {
		t.Fatal("missing browser not reported")
	}
	if out := call("knowledge_get", map[string]any{"account": "../escape", "server_id": "1"}); !out.IsError {
		t.Fatal("invalid account accepted")
	}
}
