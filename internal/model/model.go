package model

import (
	"fmt"
	"regexp"
)

var snowflake = regexp.MustCompile(`^[0-9]{1,20}$`)
var account = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func ValidateID(id string) error {
	if !snowflake.MatchString(id) {
		return fmt.Errorf("invalid Discord ID %q: use numeric IDs", id)
	}
	return nil
}
func ValidateAccount(s string) error {
	if !account.MatchString(s) {
		return fmt.Errorf("invalid account key")
	}
	return nil
}
func ChannelURL(server, channel string) string {
	return "https://discord.com/channels/" + server + "/" + channel
}

type Channel struct {
	ID           string `json:"id"`
	ServerID     string `json:"server_id"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	LastObserved string `json:"last_observed"`
}
type Snapshot struct {
	URL               string    `json:"url"`
	Heading           string    `json:"heading"`
	SelectedChannelID string    `json:"selected_channel_id"`
	Channels          []Channel `json:"channels"`
}
type Knowledge struct {
	Account     string       `json:"account"`
	ServerID    string       `json:"server_id"`
	Channels    []Channel    `json:"channels"`
	Exploration *Exploration `json:"exploration,omitempty"`
}
type Exploration struct {
	Status       string `json:"status"`
	Observed     int    `json:"observed"`
	Visited      int    `json:"visited"`
	LastObserved string `json:"last_observed"`
}
