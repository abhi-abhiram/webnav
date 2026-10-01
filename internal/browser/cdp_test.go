package browser

import "testing"

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
