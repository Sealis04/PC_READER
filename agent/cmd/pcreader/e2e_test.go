package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

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

// lockedBuffer lets the test read what `pcreader listen` prints while it runs.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type serverRequest struct {
	ID     string  `json:"id"`
	Type   string  `json:"type"`
	Status string  `json:"status"`
	ScanID *string `json:"scan_id"`
}

func listRequests(t *testing.T, server, deviceID string) []serverRequest {
	t.Helper()
	res, err := http.Get(server + "/api/dashboard/devices/" + deviceID + "/requests")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct {
		Requests []serverRequest `json:"requests"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Requests
}

func queueRequest(t *testing.T, server, deviceID, typ string) {
	t.Helper()
	res, err := http.Post(server+"/api/dashboard/devices/"+deviceID+"/requests", "application/json", strings.NewReader(`{"type":"`+typ+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 201 && res.StatusCode != 200 {
		t.Fatalf("queueing %s: HTTP %d", typ, res.StatusCode)
	}
}

// TestEndToEndListen: `pcreader listen` connects to the server, receives requests queued after it
// connected (no polling), acts on them and completes them.
func TestEndToEndListen(t *testing.T) {
	server := os.Getenv("PCREADER_E2E_SERVER")
	if server == "" {
		t.Skip("set PCREADER_E2E_SERVER and PCREADER_E2E_KEY to run against a server")
	}
	t.Setenv("PCREADER_HOME", t.TempDir())
	t.Setenv("PCREADER_TOKEN_STORE", "file")
	raw := contract.Fixture("raw/windows")
	mustRun(t, "register", "--server", server, "--key", os.Getenv("PCREADER_E2E_KEY"), "--name", "E2E Listener",
		"--employee-id", "E2E-listen", "--department", "IT", "--accept-policy", "--from-raw", raw)
	var deviceID string
	for _, line := range strings.Split(mustRun(t, "status"), "\n") {
		if strings.HasPrefix(line, "Device ID:") {
			deviceID = strings.TrimSpace(strings.TrimPrefix(line, "Device ID:"))
		}
	}
	if deviceID == "" {
		t.Fatal("no device id in status output")
	}

	ctx, cancel := context.WithCancel(context.Background())
	out, errOut := &lockedBuffer{}, &lockedBuffer{}
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"listen", "--from-raw", raw}, out, errOut) }()
	defer cancel()

	waitUntil := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if cond() {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %s\nstdout: %s\nstderr: %s", what, out.String(), errOut.String())
	}
	waitUntil("the connection", func() bool { return strings.Contains(out.String(), "status: Connected") })

	// Queued only now, after the connection is open: it must arrive over the stream.
	for _, typ := range []string{"scan_now", "send_logs", "prompt_details_update"} {
		queueRequest(t, server, deviceID, typ)
	}
	waitUntil("all three requests to finish", func() bool {
		done := 0
		for _, r := range listRequests(t, server, deviceID) {
			if r.Status == "done" {
				done++
				if r.Type == "scan_now" && r.ScanID == nil {
					t.Errorf("scan_now finished without a scan_id")
				}
			}
			if r.Status == "failed" {
				t.Fatalf("request %s failed\nstdout: %s\nstderr: %s", r.Type, out.String(), errOut.String())
			}
		}
		return done == 3
	})
	if !strings.Contains(out.String(), "IT asked you to confirm your details") {
		t.Errorf("prompt not shown: %s", out.String())
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("listen exited %d: %s", code, errOut.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("listen did not stop")
	}
}
