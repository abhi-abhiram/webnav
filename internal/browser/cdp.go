package browser

import (
	"context"
	_ "embed"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"discord-automation/internal/model"
	"github.com/chromedp/chromedp"
)

//go:embed helpers/observe.js
var observeJS string

type Browser interface {
	Open(context.Context, string) (model.Snapshot, error)
	Close()
}

// CDP attaches lazily and creates its own tab; it never launches Chrome.
type CDP struct {
	Endpoint        string
	mu              sync.Mutex
	tab             context.Context
	cancelTab       context.CancelFunc
	cancelAllocator context.CancelFunc
}

func New(endpoint string) (*CDP, error) {
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "ws") || u.User != nil ||
		(u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") {
		return nil, fmt.Errorf("CDP endpoint must be a local http:// or ws:// endpoint")
	}
	return &CDP{Endpoint: endpoint}, nil
}
func (b *CDP) Open(ctx context.Context, target string) (model.Snapshot, error) {
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "https" || u.Host != "discord.com" || !strings.HasPrefix(u.Path, "/channels/") {
		return model.Snapshot{}, fmt.Errorf("only Discord channel URLs are allowed")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.tab == nil {
		allocator, cancel := chromedp.NewRemoteAllocator(context.Background(), b.Endpoint)
		b.cancelAllocator = cancel
		b.tab, b.cancelTab = chromedp.NewContext(allocator)
	}
	// Keep the tab across operations, but cancel the current CDP action with the caller.
	op, cancel := context.WithCancel(b.tab)
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	var snap model.Snapshot
	err = chromedp.Run(op, chromedp.Navigate(target),
		chromedp.WaitReady("body", chromedp.ByQuery),
		chromedp.Poll(observeJS, &snap, chromedp.WithPollingInterval(250000000)))
	// Poll above yields the observation immediately. Core verifies UI with repeated reads below.
	if err == nil {
		err = chromedp.Run(op, chromedp.Poll(
			`(() => { const s = `+observeJS+`; return s.selected_channel_id || s.heading ? s : false; })()`,
			&snap, chromedp.WithPollingInterval(250000000)))
	}
	if err != nil {
		return snap, fmt.Errorf("Chrome observation failed (check login, permissions and CDP): %w", err)
	}
	return snap, nil
}
func (b *CDP) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancelTab != nil {
		b.cancelTab()
	}
	if b.cancelAllocator != nil {
		b.cancelAllocator()
	}
	b.tab = nil
}
