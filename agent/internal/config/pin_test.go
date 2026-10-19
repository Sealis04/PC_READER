package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinHashVerifyAndFormat(t *testing.T) {
	if PinIterations < 100_000 {
		t.Fatalf("PinIterations = %d, want at least 100000", PinIterations)
	}
	old := PinIterations
	PinIterations = 1000
	defer func() { PinIterations = old }()

	h, err := NewPinHash("123456")
	if err != nil {
		t.Fatal(err)
	}
	if !h.Verify("123456") || h.Verify("123457") || h.Verify("") {
		t.Fatal("verify gave the wrong answer")
	}
	other, _ := NewPinHash("123456")
	if other.Salt == h.Salt || other.Hash == h.Hash {
		t.Fatal("two hashes of the same PIN share a salt")
	}
	for _, bad := range []string{"", "123", "123456789", "12ab", "12 34"} {
		if _, err := NewPinHash(bad); err == nil {
			t.Errorf("accepted PIN %q", bad)
		}
	}
	var nilHash *PinHash
	if nilHash.Verify("1234") {
		t.Fatal("nil hash verified")
	}
}

func TestPinNeverInConfigFile(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	PinIterations = 1000
	defer func() { PinIterations = 600_000 }()

	c := &Config{ServerURL: "http://10.0.0.5:3000"}
	var err error
	if c.ITPin, err = NewPinHash("987654"); err != nil {
		t.Fatal(err)
	}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	dir, _ := Dir()
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "987654") {
		t.Fatalf("PIN in config.json:\n%s", raw)
	}
	again, err := Load()
	if err != nil || !again.ITPin.Verify("987654") {
		t.Fatalf("PIN did not survive a reload: %+v %v", again, err)
	}
}
