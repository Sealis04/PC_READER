package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecretHashVerifyAndFormat(t *testing.T) {
	if HashIterations < 100_000 {
		t.Fatalf("HashIterations = %d, want at least 100000", HashIterations)
	}
	old := HashIterations
	HashIterations = 1000
	defer func() { HashIterations = old }()

	key := "Zk3-long.random/enrollment+key=="
	h, err := NewSecretHash(key)
	if err != nil {
		t.Fatal(err)
	}
	if !h.Verify(key) || !h.Verify("  "+key+"\n") || h.Verify(key+"x") || h.Verify("") {
		t.Fatal("verify gave the wrong answer")
	}
	other, _ := NewSecretHash(key)
	if other.Salt == h.Salt || other.Hash == h.Hash {
		t.Fatal("two hashes of the same secret share a salt")
	}
	for _, bad := range []string{"", "   ", strings.Repeat("k", MaxSecretLength+1)} {
		if _, err := NewSecretHash(bad); err == nil {
			t.Errorf("accepted secret %q", bad)
		}
	}
	var nilHash *SecretHash
	if nilHash.Verify("1234") {
		t.Fatal("nil hash verified")
	}
}

func TestEnrollmentKeyNeverInConfigFile(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	HashIterations = 1000
	defer func() { HashIterations = 600_000 }()

	c := &Config{ServerURL: "http://10.0.0.5:3000"}
	var err error
	if c.EnrollmentKeyHash, err = NewSecretHash("my-enrollment-key"); err != nil {
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
	if strings.Contains(string(raw), "my-enrollment-key") {
		t.Fatalf("enrollment key in config.json:\n%s", raw)
	}
	again, err := Load()
	if err != nil || !again.EnrollmentKeyHash.Verify("my-enrollment-key") {
		t.Fatalf("hash did not survive a reload: %+v %v", again, err)
	}
}

func TestOldITPinIsDroppedOnLoad(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	dir, _ := Dir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	old := `{"server_url":"http://10.0.0.5:3000","device_id":"dev-1","it_pin":{"algorithm":"pbkdf2-sha256","iterations":1,"salt":"AA==","hash":"AA=="}}`
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.ServerURL != "http://10.0.0.5:3000" || c.DeviceID != "dev-1" || c.EnrollmentKeyHash != nil {
		t.Fatalf("loaded %+v", c)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "it_pin") {
		t.Fatalf("old PIN hash still on disk:\n%s", raw)
	}
}
