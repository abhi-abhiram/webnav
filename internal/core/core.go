// Package core implements Discord operations without MCP or Pi dependencies.
package core

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"discord-automation/internal/browser"
	"discord-automation/internal/guidance"
	"discord-automation/internal/model"
	"discord-automation/internal/store"
	"github.com/gofrs/flock"
)

type Core struct {
	Store    *store.Store
	Guidance guidance.Files
	Browser  browser.Browser
	LockPath string
}
type Lookup struct {
	Knowledge model.Knowledge    `json:"knowledge"`
	Guidance  guidance.Versioned `json:"guidance"`
}

func (c *Core) Lookup(ctx context.Context, account, server string) (Lookup, error) {
	k, err := c.Store.Get(ctx, account, server)
	if err != nil {
		return Lookup{}, err
	}
	g, err := c.Guidance.Get(account, server)
	if err != nil {
		return Lookup{}, err
	}
	return Lookup{Knowledge: k, Guidance: g}, nil
}
func (c *Core) resolve(ctx context.Context, account, server, target string) (model.Channel, error) {
	k, err := c.Lookup(ctx, account, server)
	if err != nil {
		return model.Channel{}, err
	}
	if id, ok := k.Guidance.Document.Aliases[target]; ok {
		target = id
	}
	var matches []model.Channel
	for _, ch := range k.Knowledge.Channels {
		if ch.ID == target {
			return ch, nil
		}
		if strings.EqualFold(ch.Name, target) {
			matches = append(matches, ch)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		return model.Channel{}, fmt.Errorf("ambiguous channel name; use its ID")
	}
	if model.ValidateID(target) == nil {
		return model.Channel{ID: target, ServerID: server, URL: model.ChannelURL(server, target)}, nil
	}
	return model.Channel{}, fmt.Errorf("unknown channel %q; explore first or use a channel ID", target)
}
func (c *Core) locked(ctx context.Context, fn func(context.Context) error) error {
	if c.Browser == nil {
		return fmt.Errorf("browser not configured")
	}
	lock := flock.New(filepath.Clean(c.LockPath))
	ok, err := lock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil {
		return err
	}
	if !ok {
		return ctx.Err()
	}
	defer lock.Unlock()
	return fn(ctx)
}

type Navigation struct {
	Status   string        `json:"status"`
	Channel  model.Channel `json:"channel"`
	Evidence string        `json:"evidence"`
}

func Verify(s model.Snapshot, ch model.Channel, mode string) (string, error) {
	// Exact URL checks prevent login redirects, wrong destinations and alternate hosts.
	if strings.TrimRight(s.URL, "/") != ch.URL {
		return "", fmt.Errorf("destination not verified: unexpected URL (login or permissions may be required)")
	}
	if s.SelectedChannelID == ch.ID {
		return "url_and_selected_channel", nil
	}
	normalize := func(v string) string {
		return strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "#")))
	}
	if mode == "selected_or_heading" && ch.Name != "" && normalize(s.Heading) == normalize(ch.Name) {
		return "url_and_known_heading", nil
	}
	return "", fmt.Errorf("destination URL reached, but channel UI identity was not verified; refresh interface helpers or check permissions")
}
func (c *Core) Navigate(ctx context.Context, account, server, target string) (Navigation, error) {
	ch, err := c.resolve(ctx, account, server, target)
	if err != nil {
		return Navigation{}, err
	}
	recipe, err := c.Guidance.Recipe()
	if err != nil {
		return Navigation{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(recipe.TimeoutSeconds)*time.Second)
	defer cancel()
	out := Navigation{Channel: ch}
	err = c.locked(ctx, func(ctx context.Context) error {
		snap, err := c.Browser.Open(ctx, ch.URL)
		if err != nil {
			return err
		}
		evidence, err := Verify(snap, ch, recipe.Verification)
		if err != nil {
			return err
		}
		out.Status = "verified"
		out.Evidence = evidence
		return nil
	})
	return out, err
}

type ExplorationResult struct {
	Status     string   `json:"status"`
	Observed   int      `json:"observed"`
	Visited    int      `json:"visited"`
	StopReason string   `json:"stop_reason"`
	Scope      string   `json:"scope"`
	Warnings   []string `json:"warnings"`
}

// Explore traverses server sidebar -> visible channel destinations. It is intentionally
// partial: hidden channels, categories and thread histories are not exhaustively indexed.
func (c *Core) Explore(ctx context.Context, account, server string, depth, maxNodes, seconds int) (ExplorationResult, error) {
	out := ExplorationResult{Status: "partial", Scope: "visible_channel_links", Warnings: []string{}}
	if err := model.ValidateAccount(account); err != nil {
		return out, err
	}
	if err := model.ValidateID(server); err != nil {
		return out, err
	}
	if depth < 1 || depth > 2 || maxNodes < 1 || maxNodes > 100 || seconds < 1 || seconds > 120 {
		return out, fmt.Errorf("depth=1..2, max_nodes=1..100, seconds=1..120 required")
	}
	requestCtx := ctx
	budget, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	err := c.locked(budget, func(ctx context.Context) error {
		seen := map[string]bool{}
		var found []model.Channel
		add := func(s model.Snapshot) {
			for _, ch := range s.Channels {
				if ch.ServerID != server || seen[ch.ID] || model.ValidateID(ch.ID) != nil {
					continue
				}
				if len(found) >= maxNodes {
					out.StopReason = "node_budget"
					break
				}
				ch.URL = model.ChannelURL(server, ch.ID)
				found = append(found, ch)
				seen[ch.ID] = true
			}
		}
		snap, err := c.Browser.Open(ctx, "https://discord.com/channels/"+server)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(snap.URL, "https://discord.com/channels/"+server+"/") && snap.URL != "https://discord.com/channels/"+server {
			return fmt.Errorf("server destination not reached; check login and permissions")
		}
		add(snap)
		if depth == 2 {
			// Queue grows from discoveries, but each ID is visited at most once.
			for i := 0; i < len(found) && i < maxNodes; i++ {
				if ctx.Err() != nil {
					out.StopReason = "time_budget"
					break
				}
				ch := found[i]
				next, openErr := c.Browser.Open(ctx, ch.URL)
				if openErr != nil {
					if ctx.Err() != nil {
						out.StopReason = "time_budget"
						break
					}
					out.Warnings = append(out.Warnings, fmt.Sprintf("channel %s: %v", ch.ID, openErr))
					continue
				}
				if _, verifyErr := Verify(next, ch, "selected_or_heading"); verifyErr != nil {
					out.Warnings = append(out.Warnings, fmt.Sprintf("channel %s: %v", ch.ID, verifyErr))
					continue
				}
				out.Visited++
				add(next)
			}
		}
		out.Observed = len(found)
		if out.StopReason == "" {
			out.StopReason = "visible_frontier_exhausted"
		}
		// Persist partial progress even when the exploration budget expired, but honor
		// cancellation of the outer request.
		saveCtx, saveCancel := context.WithTimeout(requestCtx, 5*time.Second)
		defer saveCancel()
		return c.Store.Observe(saveCtx, account, server, found, model.Exploration{Status: "partial", Observed: out.Observed, Visited: out.Visited})
	})
	return out, err
}
