package main

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/contract"
)

// TestEndToEnd registers and uploads both raw fixtures to a running server.
// It runs only when PCREADER_E2E_SERVER (and PCREADER_E2E_KEY) are set, e.g. in CI.
func TestEndToEnd(t *testing.T) {
	server := os.Getenv("PCREADER_E2E_SERVER")
	if server == "" {
		t.Skip("set PCREADER_E2E_SERVER and PCREADER_E2E_KEY to run against a server")
	}
	key := os.Getenv("PCREADER_E2E_KEY")

	for _, platform := range []string{"windows", "macos"} {
		t.Run(platform, func(t *testing.T) {
			t.Setenv("PCREADER_HOME", t.TempDir())
			t.Setenv("PCREADER_TOKEN_STORE", "file")
			raw := contract.Fixture("raw/" + platform)

			out := mustRun(t, "register", "--server", server, "--key", key, "--name", "E2E "+platform,
				"--employee-id", "E2E-"+platform, "--department", "IT", "--accept-policy", "--from-raw", raw)
			if !strings.Contains(out, "Registered") {
				t.Fatalf("unexpected register output: %s", out)
			}
			for i := 0; i < 2; i++ {
				if out := mustRun(t, "scan", "--upload", "--from-raw", raw); !strings.Contains(out, "Uploaded scan") {
					t.Fatalf("unexpected scan output: %s", out)
				}
			}
			if out := mustRun(t, "status"); !strings.Contains(out, "Token:       stored") {
				t.Fatalf("unexpected status: %s", out)
			}

			// A wrong key is refused and reported, not retried forever.
			t.Setenv("PCREADER_HOME", t.TempDir())
			var stdout, stderr bytes.Buffer
			code := run(context.Background(), []string{"register", "--server", server, "--key", "wrong", "--name", "x",
				"--employee-id", "x", "--department", "x", "--accept-policy", "--from-raw", raw}, &stdout, &stderr)
			if code == 0 || !strings.Contains(stderr.String(), "403") {
				t.Fatalf("expected 403 failure, got %d: %s", code, stderr.String())
			}
		})
	}
}

func mustRun(t *testing.T, args ...string) string {
	t.Helper()
	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), args, &stdout, &stderr); code != 0 {
		t.Fatalf("pcreader %s exited %d: %s", strings.Join(args, " "), code, stderr.String())
	}
	return stdout.String()
}
