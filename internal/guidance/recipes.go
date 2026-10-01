package guidance

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"go.yaml.in/yaml/v3"
)

type Recipe struct {
	Version        int    `yaml:"version"`
	Verification   string `yaml:"verification"`
	TimeoutSeconds int    `yaml:"timeout_seconds"`
}

const defaultRecipe = "version: 1\nverification: selected_or_heading\ntimeout_seconds: 15\n"

// Recipes choose reviewed behavior, never executable code from a knowledge file.
func (f Files) Init() error {
	dir := filepath.Join(f.Root, "recipes")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(dir, "open-channel.yaml"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = file.WriteString(defaultRecipe)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func (f Files) Recipe() (Recipe, error) {
	var r Recipe
	b, err := os.ReadFile(filepath.Join(f.Root, "recipes", "open-channel.yaml"))
	if err != nil {
		return r, err
	}
	if len(b) > 4096 {
		return r, fmt.Errorf("recipe too large")
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err = dec.Decode(&r); err != nil {
		return r, err
	}
	if r.Version != 1 || (r.Verification != "selected_or_heading" && r.Verification != "selected_only") || r.TimeoutSeconds < 1 || r.TimeoutSeconds > 60 {
		return r, fmt.Errorf("unsupported recipe: version=1, verification=selected_or_heading|selected_only, timeout_seconds=1..60 required")
	}
	return r, nil
}
