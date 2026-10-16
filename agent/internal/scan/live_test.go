package scan_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/scan"
)

// TestLiveScan scans the machine it runs on. CI runs it on Windows and macOS runners
// (PCREADER_LIVE_SCAN=1); PCREADER_LIVE_SCAN_OUT saves the raw output and payload for review.
func TestLiveScan(t *testing.T) {
	if os.Getenv("PCREADER_LIVE_SCAN") != "1" {
		t.Skip("set PCREADER_LIVE_SCAN=1 to scan this machine")
	}
	raw, err := scan.CollectRaw(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s, err := scan.Parse(raw, "live-test")
	if err != nil {
		t.Fatal(err)
	}
	if dir := os.Getenv("PCREADER_LIVE_SCAN_OUT"); dir != "" {
		if err := raw.Save(filepath.Join(dir, "raw")); err != nil {
			t.Fatal(err)
		}
		b, _ := json.MarshalIndent(s, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, "payload.json"), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := contract.Validate("payload", s); err != nil {
		t.Fatalf("live payload does not match the schema: %v", err)
	}
	if len(s.CPUs) == 0 || s.Memory.TotalBytes == nil || len(s.Storage) == 0 {
		t.Fatalf("live scan is missing basics: cpus=%d memory=%v storage=%d", len(s.CPUs), s.Memory.TotalBytes, len(s.Storage))
	}
	t.Logf("%s %s, %d CPU, %d disks, %d adapters", s.System.Hostname, s.OSType, len(s.CPUs), len(s.Storage), len(s.Network.Adapters))
}
