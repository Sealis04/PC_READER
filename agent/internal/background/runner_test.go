package background

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/events"
	"github.com/sealis04/pc_reader/agent/internal/locallog"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// fakeServer is the parts of the server the background app talks to.
type fakeServer struct {
	*httptest.Server
	mu         sync.Mutex
	push       chan string // raw SSE frames to send on the open stream
	scanTypes  []string
	snapshots  []payload.NetworkSnapshot
	logBatches [][]int64
	completes  map[string]payload.RequestComplete
	maxLogs    int // 413 above this many entries per upload (0: no limit)
	unauth     atomic.Bool
	streams    atomic.Int32
}

func newFake(t *testing.T) *fakeServer {
	t.Helper()
	f := &fakeServer{push: make(chan string, 16), completes: map[string]payload.RequestComplete{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/agent/register" && f.unauth.Load() {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.URL.Path == "/api/agent/register":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"device_id":"dev-1","device_token":"tok-1","checkin_interval_seconds":300}`))
		case r.URL.Path == "/api/agent/scans":
			var req payload.ScanRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			f.mu.Lock()
			f.scanTypes = append(f.scanTypes, req.ScanType)
			f.mu.Unlock()
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"scan_id":"6f0f6c3a-3d65-4c8e-9a0e-1b2c3d4e5f60"}`))
		case r.URL.Path == "/api/agent/events":
			f.streams.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: hello\ndata: {\"heartbeat_seconds\":25}\n\n")
			w.(http.Flusher).Flush()
			for {
				select {
				case frame := <-f.push:
					fmt.Fprint(w, frame)
					w.(http.Flusher).Flush()
				case <-r.Context().Done():
					return
				}
			}
		case r.URL.Path == "/api/agent/network":
			var s payload.NetworkSnapshot
			_ = json.NewDecoder(r.Body).Decode(&s)
			f.mu.Lock()
			f.snapshots = append(f.snapshots, s)
			f.mu.Unlock()
			w.WriteHeader(204)
		case r.URL.Path == "/api/agent/logs":
			var req payload.LogsRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			if f.maxLogs > 0 && len(req.Entries) > f.maxLogs {
				w.WriteHeader(413)
				_, _ = w.Write([]byte(`{"error":"payload_too_large"}`))
				return
			}
			ids := []int64{}
			for _, e := range req.Entries {
				ids = append(ids, e.LocalEntryID)
			}
			f.mu.Lock()
			f.logBatches = append(f.logBatches, ids)
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(payload.LogsResponse{ReceivedIDs: ids})
		case strings.HasPrefix(r.URL.Path, "/api/agent/requests/") && strings.HasSuffix(r.URL.Path, "/complete"):
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/agent/requests/"), "/complete")
			var c payload.RequestComplete
			_ = json.NewDecoder(r.Body).Decode(&c)
			if err := contract.Validate("request-complete", c); err != nil {
				t.Errorf("complete body breaks the contract: %v", err)
			}
			f.mu.Lock()
			f.completes[id] = c
			f.mu.Unlock()
			_, _ = w.Write([]byte(`{"id":"` + id + `","status":"` + c.Result + `"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeServer) request(id, typ string) {
	f.push <- fmt.Sprintf("event: request\ndata: {\"id\":%q,\"type\":%q,\"created_at\":\"2026-10-19T08:00:00Z\"}\n\n", id, typ)
}

func (f *fakeServer) complete(id string) (payload.RequestComplete, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.completes[id]
	return c, ok
}

func (f *fakeServer) waitComplete(t *testing.T, id string) payload.RequestComplete {
	t.Helper()
	var c payload.RequestComplete
	waitFor(t, "request "+id+" to be completed", func() bool { var ok bool; c, ok = f.complete(id); return ok })
	return c
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type rig struct {
	f      *fakeServer
	r      *Runner
	store  *locallog.Store
	cancel context.CancelFunc
	done   chan error
	status chan Status
	prompt atomic.Int32
	snap   atomic.Pointer[payload.NetworkSnapshot]
	fp     atomic.Value
}

func startRig(t *testing.T) *rig {
	t.Helper()
	t.Setenv("PCREADER_HOME", t.TempDir())
	t.Setenv("PCREADER_TOKEN_STORE", "file")
	f := newFake(t)
	svc := app.New("test")
	svc.Scan = func(context.Context) (rd.Set, error) { return rd.Load(contract.Fixture("raw/windows")) }
	svc.NewClient = func(u string) *api.Client {
		c := api.New(u)
		c.Backoff = nil
		return c
	}
	store, err := locallog.Open(filepath.Join(t.TempDir(), locallog.DefaultFile))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	svc.Log = func(l, c, m string) { _ = store.Add(l, c, m) }
	user := payload.UserDetails{FullName: "A", EmployeeID: "E-1", Department: "IT"}
	if _, err := svc.Register(context.Background(), app.RegisterInput{ServerURL: f.URL, Key: "k", User: user}); err != nil {
		t.Fatal(err)
	}

	g := &rig{f: f, store: store, done: make(chan error, 1), status: make(chan Status, 32)}
	first := payload.NetworkSnapshot{CollectedAt: "2026-10-19T08:00:00Z", IPAddresses: []string{"192.168.1.5"}, MACAddresses: []string{"AA:BB:CC:DD:EE:01"},
		DNSServers: []string{"192.168.1.1"}, ConnectionType: "ethernet"}
	g.snap.Store(&first)
	g.fp.Store("one")
	g.r = &Runner{
		Svc: svc, Log: store, Version: "0.3.0-test",
		Snapshot:      func(context.Context) (payload.NetworkSnapshot, error) { return *g.snap.Load(), nil },
		WatchInterval: 10 * time.Millisecond,
		Fingerprint:   func() string { return g.fp.Load().(string) },
		Tune: func(c *events.Client) {
			c.Backoff = []time.Duration{10 * time.Millisecond}
			c.IdleTimeout = 10 * time.Second
		},
		OnStatus: func(s Status) { g.status <- s },
		OnPrompt: func() { g.prompt.Add(1) },
	}
	ctx, cancel := context.WithCancel(context.Background())
	g.cancel = cancel
	t.Cleanup(cancel)
	go func() { g.done <- g.r.Run(ctx) }()
	return g
}

func (g *rig) waitStatus(t *testing.T, want Status) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case s := <-g.status:
			if s == want {
				return
			}
		case <-deadline:
			t.Fatalf("never reached status %q (now %q)", want, g.r.Status())
		}
	}
}

func TestConnectSendsNetworkSnapshotAndReportsConnected(t *testing.T) {
	g := startRig(t)
	g.waitStatus(t, StatusConnected)
	waitFor(t, "the snapshot", func() bool { g.f.mu.Lock(); defer g.f.mu.Unlock(); return len(g.f.snapshots) == 1 })
	if err := contract.Validate("network", g.f.snapshots[0]); err != nil {
		t.Fatalf("snapshot breaks the contract: %v", err)
	}
	if g.f.snapshots[0].IPAddresses[0] != "192.168.1.5" || g.r.Status() != StatusConnected {
		t.Fatalf("snapshot %+v status %s", g.f.snapshots[0], g.r.Status())
	}
}

func TestScanNowRequestUploadsOnDemandScanAndCompletesWithScanID(t *testing.T) {
	g := startRig(t)
	g.waitStatus(t, StatusConnected)
	g.f.request("req-scan", "scan_now")
	c := g.f.waitComplete(t, "req-scan")
	if c.Result != "done" || c.ScanID != "6f0f6c3a-3d65-4c8e-9a0e-1b2c3d4e5f60" {
		t.Fatalf("complete = %+v", c)
	}
	g.f.mu.Lock()
	defer g.f.mu.Unlock()
	// the registration did not upload; the only scan is the on-demand one
	if len(g.f.scanTypes) != 1 || g.f.scanTypes[0] != "on_demand" {
		t.Fatalf("scan types = %v", g.f.scanTypes)
	}
}

func TestFailedScanIsReportedAsFailed(t *testing.T) {
	g := startRig(t)
	g.r.Svc.Scan = func(context.Context) (rd.Set, error) { return nil, errors.New("wmi exploded") }
	g.waitStatus(t, StatusConnected)
	g.f.request("req-bad", "scan_now")
	c := g.f.waitComplete(t, "req-bad")
	if c.Result != "failed" || c.Message == "" || strings.Contains(c.Message, "wmi") {
		t.Fatalf("complete = %+v (message must be plain words, no internals)", c)
	}
}

func TestSendLogsUploadsAndClearsTheConfirmedEntries(t *testing.T) {
	g := startRig(t)
	for i := 0; i < 3; i++ {
		_ = g.store.Add(locallog.Info, locallog.System, fmt.Sprintf("entry %d", i))
	}
	g.waitStatus(t, StatusConnected)
	g.f.request("req-logs", "send_logs")
	c := g.f.waitComplete(t, "req-logs")
	if c.Result != "done" {
		t.Fatalf("complete = %+v", c)
	}
	g.f.mu.Lock()
	uploaded := 0
	for _, b := range g.f.logBatches {
		uploaded += len(b)
	}
	g.f.mu.Unlock()
	if uploaded < 3 {
		t.Fatalf("uploaded %d entries", uploaded)
	}
	left, _ := g.store.Next(100)
	for _, e := range left {
		if strings.HasPrefix(e.Message, "entry ") {
			t.Fatalf("confirmed entry still stored: %+v", e)
		}
	}
}

func TestPromptDetailsRequestCallsBackAndCompletes(t *testing.T) {
	g := startRig(t)
	g.waitStatus(t, StatusConnected)
	g.f.request("req-prompt", "prompt_details_update")
	if c := g.f.waitComplete(t, "req-prompt"); c.Result != "done" {
		t.Fatalf("complete = %+v", c)
	}
	if g.prompt.Load() != 1 {
		t.Fatalf("OnPrompt called %d times", g.prompt.Load())
	}
}

func TestSameRequestDeliveredTwiceWhileRunningIsHandledOnce(t *testing.T) {
	g := startRig(t)
	var scans atomic.Int32
	release := make(chan struct{})
	g.r.Svc.Scan = func(context.Context) (rd.Set, error) {
		scans.Add(1)
		<-release
		return rd.Load(contract.Fixture("raw/windows"))
	}
	g.waitStatus(t, StatusConnected)
	g.f.request("dup", "scan_now")
	waitFor(t, "the scan to start", func() bool { return scans.Load() == 1 })
	g.f.request("dup", "scan_now")
	time.Sleep(50 * time.Millisecond)
	close(release)
	g.f.waitComplete(t, "dup")
	if scans.Load() != 1 {
		t.Fatalf("scanned %d times, want once", scans.Load())
	}
}

func TestNetworkChangeSendsANewSnapshot(t *testing.T) {
	g := startRig(t)
	g.waitStatus(t, StatusConnected)
	waitFor(t, "the first snapshot", func() bool { g.f.mu.Lock(); defer g.f.mu.Unlock(); return len(g.f.snapshots) == 1 })
	moved := payload.NetworkSnapshot{CollectedAt: "2026-10-19T09:00:00Z", IPAddresses: []string{"10.1.1.9"}, MACAddresses: []string{"AA:BB:CC:DD:EE:02"},
		DNSServers: []string{}, ConnectionType: "wifi", SSID: strp("GUEST")}
	g.snap.Store(&moved)
	g.fp.Store("two")
	waitFor(t, "the second snapshot", func() bool { g.f.mu.Lock(); defer g.f.mu.Unlock(); return len(g.f.snapshots) == 2 })
	if got := g.f.snapshots[1]; got.IPAddresses[0] != "10.1.1.9" || got.ConnectionType != "wifi" {
		t.Fatalf("second snapshot = %+v", got)
	}
}

func strp(s string) *string { return &s }

func TestUnauthorizedStopsWithReregisterStatus(t *testing.T) {
	g := startRig(t)
	g.f.unauth.Store(true)
	g.cancel() // stop the first run, then start one against the now-rejecting server
	<-g.done
	g2 := make(chan error, 1)
	ctx := context.Background()
	go func() { g2 <- g.r.Run(ctx) }()
	select {
	case err := <-g2:
		if !errors.Is(err, events.ErrReregister) || g.r.Status() != StatusReregister {
			t.Fatalf("err=%v status=%s", err, g.r.Status())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop on 401")
	}
	logged, _ := g.store.Next(100)
	found := false
	for _, e := range logged {
		found = found || strings.Contains(e.Message, "no longer recognises")
	}
	if !found {
		t.Fatalf("expected a log entry about re-registration, got %+v", logged)
	}
}

func TestUploadLogsSplitsOn413AndKeepsUnconfirmed(t *testing.T) {
	g := newFake(t)
	g.maxLogs = 100
	store, _ := locallog.Open(filepath.Join(t.TempDir(), locallog.DefaultFile))
	defer store.Close()
	for i := 0; i < 450; i++ {
		_ = store.Add(locallog.Info, locallog.System, "x")
	}
	client := api.New(g.URL)
	client.Backoff = nil
	sent, err := UploadLogs(context.Background(), store, client, "tok")
	if err != nil || sent != 450 {
		t.Fatalf("sent=%d err=%v", sent, err)
	}
	if n, _ := store.Count(); n != 0 {
		t.Fatalf("%d entries left", n)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, b := range g.logBatches {
		if len(b) > 100 {
			t.Fatalf("batch of %d exceeds the server limit", len(b))
		}
	}
}

type failingUploader struct{ calls int }

func (f *failingUploader) UploadLogs(context.Context, string, []payload.LogEntry) ([]int64, error) {
	f.calls++
	return nil, errors.New("network down")
}

func TestFailedUploadDeletesNothing(t *testing.T) {
	store, _ := locallog.Open(filepath.Join(t.TempDir(), locallog.DefaultFile))
	defer store.Close()
	for i := 0; i < 5; i++ {
		_ = store.Add(locallog.Info, locallog.System, "keep me")
	}
	f := &failingUploader{}
	if _, err := UploadLogs(context.Background(), store, f, "tok"); err == nil {
		t.Fatal("expected an error")
	}
	if n, _ := store.Count(); n != 5 || f.calls != 1 {
		t.Fatalf("count=%d calls=%d", n, f.calls)
	}
}

type partialUploader struct{}

func (partialUploader) UploadLogs(_ context.Context, _ string, e []payload.LogEntry) ([]int64, error) {
	return []int64{e[0].LocalEntryID}, nil // the server confirms only the first
}

func TestOnlyConfirmedIDsAreDeleted(t *testing.T) {
	store, _ := locallog.Open(filepath.Join(t.TempDir(), locallog.DefaultFile))
	defer store.Close()
	for i := 0; i < 3; i++ {
		_ = store.Add(locallog.Info, locallog.System, fmt.Sprintf("e%d", i))
	}
	// partialUploader confirms one entry per call, so the loop drains the log one at a time.
	sent, err := UploadLogs(context.Background(), store, partialUploader{}, "tok")
	if err != nil || sent != 3 {
		t.Fatalf("sent=%d err=%v", sent, err)
	}
}
