package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/contract"
)

func runCLI(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestScanFromRawWritesValidPayload(t *testing.T) {
	out := filepath.Join(t.TempDir(), "scan.json")
	if code, _, stderr := runCLI("scan", "--from-raw", contract.Fixture("raw/macos"), "--out", out); code != 0 {
		t.Fatal(stderr)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var doc any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if err := contract.Validate("payload", doc); err != nil {
		t.Fatal(err)
	}
}

func TestRegisterRequiresPolicyAndFields(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	code, _, stderr := runCLI("register", "--server", "http://127.0.0.1:1", "--key", "k", "--name", "n", "--employee-id", "e", "--department", "d")
	if code != 1 || !strings.Contains(stderr, "--accept-policy") || !strings.Contains(stderr, "Data-use notice") {
		t.Fatalf("code %d: %s", code, stderr)
	}
	code, _, stderr = runCLI("register", "--server", "http://127.0.0.1:1", "--accept-policy")
	if code != 1 || !strings.Contains(stderr, "--name") || !strings.Contains(stderr, "--key") {
		t.Fatalf("code %d: %s", code, stderr)
	}
	code, _, stderr = runCLI("register", "--server", "192.168.1.10", "--accept-policy")
	if code != 1 || !strings.Contains(stderr, "must be a URL") {
		t.Fatalf("code %d: %s", code, stderr)
	}
}

func TestUploadBeforeRegisterExplainsWhatToDo(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	code, _, stderr := runCLI("scan", "--upload", "--from-raw", contract.Fixture("raw/windows"))
	if code != 1 || !strings.Contains(stderr, "pcreader register") {
		t.Fatalf("code %d: %s", code, stderr)
	}
}

func TestUnknownCommand(t *testing.T) {
	if code, _, _ := runCLI("frobnicate"); code != 2 {
		t.Fatalf("code %d", code)
	}
}
