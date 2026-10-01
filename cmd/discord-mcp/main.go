package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"discord-automation/internal/browser"
	"discord-automation/internal/core"
	"discord-automation/internal/guidance"
	"discord-automation/internal/mcpserver"
	"discord-automation/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func defaultDirs() (string, string, error) {
	config, err := os.UserConfigDir()
	if err != nil {
		return "", "", err
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", "", err
		}
		data = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(config, "discord-automation"), filepath.Join(data, "discord-automation"), nil
}
func run() error {
	configDefault, dataDefault, err := defaultDirs()
	if err != nil {
		return err
	}
	config := flag.String("config-dir", configDefault, "Editable guidance directory")
	data := flag.String("data-dir", dataDefault, "Persistent SQLite and browser lock directory; share across clients")
	endpoint := flag.String("cdp-endpoint", "http://127.0.0.1:9222", "Existing Chrome local CDP HTTP or WebSocket endpoint")
	version := flag.Bool("version", false, "Print version and exit")
	flag.Parse()
	if *version {
		fmt.Println("discord-mcp 0.1.0")
		return nil
	}
	if err = os.MkdirAll(*data, 0700); err != nil {
		return err
	}
	g := guidance.Files{Root: *config}
	if err = g.Init(); err != nil {
		return err
	}
	s, err := store.Open(filepath.Join(*data, "knowledge.db"))
	if err != nil {
		return err
	}
	defer s.Close()
	b, err := browser.New(*endpoint)
	if err != nil {
		return err
	}
	defer b.Close()
	c := &core.Core{Store: s, Guidance: g, Browser: b, LockPath: filepath.Join(*data, "browser.lock")}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("discord-automation ready; config=%s data=%s (Chrome connects on demand)", *config, *data)
	err = mcpserver.New(c).Run(ctx, &mcp.StdioTransport{})
	if ctx.Err() != nil {
		return nil
	}
	return err
}
func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
