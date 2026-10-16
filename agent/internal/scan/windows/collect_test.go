package windows

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestCollectSplitsClassesAndDecodesScript(t *testing.T) {
	var gotScript string
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name == "powershell.exe" {
			b, _ := base64.StdEncoding.DecodeString(args[len(args)-1])
			u := make([]uint16, len(b)/2)
			for i := range u {
				u[i] = uint16(b[i*2]) | uint16(b[i*2+1])<<8
			}
			gotScript = string(utf16.Decode(u))
			return []byte("\xef\xbb\xbf" + `{"Win32_ComputerSystem":[{"Name":"PC1"}],"MSFT_PhysicalDisk":null}`), nil
		}
		return []byte("netsh output"), nil
	}
	raw, err := Collect(context.Background(), run)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotScript, "Win32_NetworkAdapterConfiguration") || !strings.Contains(gotScript, `root\Microsoft\Windows\Storage`) {
		t.Fatalf("script is missing classes:\n%s", gotScript)
	}
	if len(raw) != len(Classes)+1 {
		t.Fatalf("expected %d files, got %v", len(Classes)+1, raw.Names())
	}
	if !strings.Contains(string(raw["Win32_ComputerSystem.json"]), `"PC1"`) || strings.TrimSpace(string(raw["Win32_BIOS.json"])) != "null" {
		t.Fatalf("unexpected split: %s / %s", raw["Win32_ComputerSystem.json"], raw["Win32_BIOS.json"])
	}
}
