package scan_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	"github.com/sealis04/pc_reader/agent/internal/scan/darwin"
	"github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
	"github.com/sealis04/pc_reader/agent/internal/scan/windows"
)

// The raw fixtures must parse into exactly the matching payload fixture.
func TestParsersMatchPayloadFixtures(t *testing.T) {
	cases := []struct {
		raw, want string
		parse     func(rawdata.Set, string) (*payload.Scan, error)
	}{
		{"raw/windows", "payload/windows-desktop.json", windows.Parse},
		{"raw/macos", "payload/macos-apple-silicon.json", darwin.Parse},
	}
	for _, c := range cases {
		t.Run(c.raw, func(t *testing.T) {
			raw, err := rawdata.Load(contract.Fixture(c.raw))
			if err != nil {
				t.Fatal(err)
			}
			got, err := c.parse(raw, "0.1.0")
			if err != nil {
				t.Fatal(err)
			}
			if err := contract.Validate("payload", got); err != nil {
				t.Fatalf("payload does not match schema: %v", err)
			}
			wantBytes, err := os.ReadFile(contract.Fixture(c.want))
			if err != nil {
				t.Fatal(err)
			}
			gotJSON, wantJSON := canonical(t, got), canonical(t, json.RawMessage(wantBytes))
			if gotJSON != wantJSON {
				t.Errorf("parsed payload differs from %s\n--- got\n%s\n--- want\n%s", c.want, gotJSON, wantJSON)
			}
		})
	}
}

func canonical(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var generic any
	if err := json.Unmarshal(b, &generic); err != nil {
		t.Fatal(err)
	}
	out, _ := json.MarshalIndent(generic, "", "  ")
	return string(out)
}
