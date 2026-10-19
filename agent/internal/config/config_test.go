package config

import (
	"errors"
	"regexp"
	"testing"
)

func TestConfigRoundTripAndFileTokenStore(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	t.Setenv("PCREADER_TOKEN_STORE", "file")

	c, err := Load()
	if err != nil || c.DeviceUUID != "" {
		t.Fatalf("fresh config: %+v %v", c, err)
	}
	id := c.EnsureDeviceUUID()
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id) {
		t.Fatalf("bad uuid %q", id)
	}
	c.ServerURL = "http://10.0.0.5:3000"
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	again, err := Load()
	if err != nil || again.DeviceUUID != id || again.EnsureDeviceUUID() != id {
		t.Fatalf("reloaded %+v %v", again, err)
	}

	store := NewTokenStore()
	if _, err := store.Get(id); !errors.Is(err, ErrNoToken) {
		t.Fatalf("expected ErrNoToken, got %v", err)
	}
	if err := store.Set(id, "pcr_secret"); err != nil {
		t.Fatal(err)
	}
	if tok, err := store.Get(id); err != nil || tok != "pcr_secret" {
		t.Fatalf("got %q %v", tok, err)
	}
}
