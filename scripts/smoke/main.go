// Smoke tests the real stdio executable using isolated storage, without Chrome.
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("usage: go run ./scripts/smoke /path/to/discord-mcp")
	}
	binary, err := filepath.Abs(os.Args[1])
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "discord-mcp-smoke-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.Command(binary, "--config-dir", filepath.Join(dir, "config"), "--data-dir", filepath.Join(dir, "data"))
	cmd.Stderr = os.Stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "stdio-smoke", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		return err
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		return err
	}
	if len(tools.Tools) != 8 {
		return fmt.Errorf("expected 8 tools; got %d", len(tools.Tools))
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "knowledge_get", Arguments: map[string]any{"account": "smoke", "server_id": "1"}})
	if err != nil {
		return err
	}
	if result.IsError {
		return fmt.Errorf("knowledge_get failed: %+v", result.Content)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "knowledge_update", Arguments: map[string]any{
		"account": "smoke", "server_id": "1", "expected_revision": "",
		"document": map[string]any{"aliases": map[string]string{"home": "2"}, "conventions": "Synthetic smoke note"},
	}})
	if err != nil {
		return err
	}
	if result.IsError {
		return fmt.Errorf("knowledge_update failed: %+v", result.Content)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "knowledge_export", Arguments: map[string]any{"account": "smoke", "server_id": "1"}})
	if err != nil {
		return err
	}
	if result.IsError {
		return fmt.Errorf("knowledge_export failed: %+v", result.Content)
	}
	fmt.Println("stdio smoke passed: 8 tools, read/update/export, isolated storage, no Chrome")
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
