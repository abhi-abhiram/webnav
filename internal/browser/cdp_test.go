package browser

import "testing"

func TestTargetBoundaries(t *testing.T) {
	for _, target := range []string{"https://discord.com/login", "https://discord.com/channels/../1", "https://discord.com/channels/1/2?redirect=evil", "https://user@discord.com/channels/1/2", "https://discord.com/channels/1/2/3", "https://evil.com/channels/1/2"} {
		if validateTarget(target) == nil {
			t.Fatalf("accepted target %s", target)
		}
	}
	for _, target := range []string{"https://discord.com/channels/1", "https://discord.com/channels/1/2"} {
		if err := validateTarget(target); err != nil {
			t.Fatal(err)
		}
	}
}
func TestEndpointBoundaries(t *testing.T) {
	for _, endpoint := range []string{"https://localhost:9222", "http://example.com:9222", "file:///tmp/chrome", "http://user:secret@localhost:9222"} {
		if _, err := New(endpoint); err == nil {
			t.Fatalf("accepted endpoint %s", endpoint)
		}
	}
	if _, err := New("http://127.0.0.1:9222"); err != nil {
		t.Fatal(err)
	}
}
