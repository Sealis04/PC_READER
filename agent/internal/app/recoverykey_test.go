package app

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

// The contract fixture carries the real hash of the sample key K7QM-2XRP-9WDF-H4TN.
func fixtureKey(t *testing.T) payload.RecoveryKey {
	t.Helper()
	b, err := os.ReadFile(contract.Fixture("events/recovery-key.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Data payload.RecoveryKey `json:"data"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m.Data
}

func TestApplyRecoveryKeySavesTheHashAndAcknowledges(t *testing.T) {
	f := newServer(t)
	s := testService(t)
	if _, err := s.Register(context.Background(), RegisterInput{ServerURL: f.URL, Key: "k", PIN: "123456", User: user()}); err != nil {
		t.Fatal(err)
	}
	old, _ := config.NewSecretHash("legacy-raw-key")
	if err := s.SetEnrollmentKeyHash(old); err != nil {
		t.Fatal(err)
	}
	rk := fixtureKey(t)
	if err := s.ApplyRecoveryKey(context.Background(), rk); err != nil {
		t.Fatal(err)
	}
	st, _ := s.Status()
	if st.RecoveryKeyVersion != 3 {
		t.Fatalf("version = %d", st.RecoveryKeyVersion)
	}
	for _, typed := range []string{"K7QM-2XRP-9WDF-H4TN", "k7qm2xrp9wdfh4tn", " k7qm 2xrp-9wdf h4tn "} {
		if !st.EnrollmentKeyHash.VerifyRecoveryKey(typed) {
			t.Fatalf("%q does not unlock", typed)
		}
	}
	if st.EnrollmentKeyHash.VerifyRecoveryKey("legacy-raw-key") {
		t.Fatal("the replaced key still unlocks")
	}
	if len(f.acks) != 1 || f.acks[0] != 3 {
		t.Fatalf("acks = %v", f.acks)
	}
	if err := contract.Validate("recovery-key-ack", payload.RecoveryKeyAck{Version: 3}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(os.Getenv("PCREADER_HOME") + "/config.json")
	if strings.Contains(strings.ToUpper(string(b)), "K7QM") {
		t.Fatal("the key itself reached config.json")
	}
}

func TestApplyRecoveryKeyRejectsABadHashAndNeedsRegistration(t *testing.T) {
	s := testService(t)
	rk := fixtureKey(t)
	if err := s.ApplyRecoveryKey(context.Background(), rk); err != ErrNotRegistered {
		t.Fatalf("unregistered: %v", err)
	}
	for _, bad := range []string{`{"algorithm":"sha1","iterations":1,"salt":"c2FtcGxlLXNhbHQtMDAwMQ==","hash":"x"}`, `{"algorithm":"pbkdf2-sha256","iterations":600000,"salt":"c2FtcGxlLXNhbHQtMDAwMQ==","hash":"c2hvcnQ="}`, `"nope"`} {
		if err := s.ApplyRecoveryKey(context.Background(), payload.RecoveryKey{Version: 2, Hash: json.RawMessage(bad)}); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestLegacyRawHashStillUnlocks(t *testing.T) {
	h, err := config.NewSecretHash("abc123def-legacy")
	if err != nil {
		t.Fatal(err)
	}
	if !h.VerifyRecoveryKey("abc123def-legacy") || h.VerifyRecoveryKey("ABC123DEF-LEGACY-x") {
		t.Fatal("raw hash check")
	}
}

func TestContactAndMissedUpdate(t *testing.T) {
	f := newServer(t)
	s := testService(t)
	now := time.Date(2026, 11, 19, 8, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	if _, err := s.Register(context.Background(), RegisterInput{ServerURL: f.URL, Key: "k", PIN: "123456", User: user()}); err != nil {
		t.Fatal(err)
	}
	st, _ := s.Status()
	if st.LastServerContactAt != "2026-11-19T08:00:00Z" {
		t.Fatalf("contact = %q", st.LastServerContactAt)
	}
	if st.MissedUpdate(now.Add(29*24*time.Hour)) || !st.MissedUpdate(now.Add(31*24*time.Hour)) {
		t.Fatal("30-day rule")
	}
	now = now.Add(31 * 24 * time.Hour)
	if err := s.RecordContact(); err != nil {
		t.Fatal(err)
	}
	st, _ = s.Status()
	if st.MissedUpdate(now) {
		t.Fatal("still missed after contact")
	}
	// No recorded contact (an install from before M7): the registration time counts.
	legacy := &Status{Registered: true, RegisteredAt: "2026-01-01T00:00:00Z"}
	if !legacy.MissedUpdate(now) {
		t.Fatal("legacy")
	}
	if (&Status{}).MissedUpdate(now) {
		t.Fatal("unregistered")
	}
}
