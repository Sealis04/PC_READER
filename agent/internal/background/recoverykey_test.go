package background

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/contract"
)

func TestPushedRecoveryKeyIsSavedAndAcknowledged(t *testing.T) {
	g := startRig(t)
	g.waitStatus(t, StatusConnected)
	raw, err := os.ReadFile(contract.Fixture("events/recovery-key.json"))
	if err != nil {
		t.Fatal(err)
	}
	// The fixture is {"event": ..., "data": {...}}; the stream carries the data object.
	var m struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	_ = json.Compact(&compact, m.Data)
	g.f.push <- "event: recovery_key\ndata: " + compact.String() + "\n\n"
	waitFor(t, "the ack", func() bool { g.f.mu.Lock(); defer g.f.mu.Unlock(); return len(g.f.acks) == 1 })
	if g.f.acks[0] != 3 {
		t.Fatalf("acks %v", g.f.acks)
	}
	cfg, _ := config.Load()
	if cfg.RecoveryKeyVersion != 3 || !cfg.EnrollmentKeyHash.VerifyRecoveryKey("k7qm-2xrp-9wdf-h4tn") {
		t.Fatalf("config %+v", cfg)
	}
	if cfg.LastServerContactAt == "" {
		t.Fatal("contact not recorded on connect")
	}
	entries, _ := g.store.Next(100)
	var text []string
	for _, e := range entries {
		text = append(text, e.Message)
	}
	joined := strings.Join(text, "\n")
	if !strings.Contains(joined, "Recovery key updated to version 3") || strings.Contains(joined, "ntHNGDo") {
		t.Fatalf("log: %s", joined)
	}
}
