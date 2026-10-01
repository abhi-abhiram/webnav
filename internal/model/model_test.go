package model

import "testing"

func TestIdentifiers(t *testing.T) {
	for _, id := range []string{"", "../1", "1/2", "javascript:1", "123456789012345678901"} {
		if ValidateID(id) == nil {
			t.Fatalf("accepted %q", id)
		}
	}
	if ValidateID("123456789012345678") != nil {
		t.Fatal("valid ID rejected")
	}
	if ChannelURL("1", "2") != "https://discord.com/channels/1/2" {
		t.Fatal("wrong route")
	}
}
