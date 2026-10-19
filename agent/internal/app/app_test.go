package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

type fakeServer struct {
	*httptest.Server
	mu    sync.Mutex
	calls []string
	// reject makes /scans and /user answer 401.
	reject bool
	// registerStatus overrides the register reply when non-zero.
	registerStatus int
}

func newServer(t *testing.T) *fakeServer {
	t.Helper()
	f := &fakeServer{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, r.Method+" "+r.URL.Path)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/devices":
			_, _ = w.Write([]byte("<html>"))
		case r.URL.Path == "/api/agent/register":
			if f.registerStatus != 0 {
				w.WriteHeader(f.registerStatus)
				_, _ = w.Write([]byte(`{"error":"invalid_enrollment_key","message":"Enrollment key is not valid"}`))
				return
			}
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"device_id":"dev-1","device_token":"tok-1","checkin_interval_seconds":300}`))
		case f.reject:
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		case r.URL.Path == "/api/agent/scans":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"scan_id":"scan-1"}`))
		case r.URL.Path == "/api/agent/user":
			var u payload.UserDetails
			_ = json.NewDecoder(r.Body).Decode(&u)
			_ = json.NewEncoder(w).Encode(u)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeServer) count(call string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == call {
			n++
		}
	}
	return n
}

func testService(t *testing.T) *Service {
	t.Helper()
	t.Setenv("PCREADER_HOME", t.TempDir())
	t.Setenv("PCREADER_TOKEN_STORE", "file")
	s := New("test")
	s.Scan = func(context.Context) (rd.Set, error) { return rd.Load(contract.Fixture("raw/windows")) }
	s.NewClient = func(u string) *api.Client {
		c := api.New(u)
		c.Backoff = nil
		return c
	}
	return s
}

func user() payload.UserDetails {
	return payload.UserDetails{FullName: "  Juan Dela Cruz ", EmployeeID: "EMP-1", Department: "Finance", Email: rd.StrPtr(" "), Position: rd.StrPtr("Clerk")}
}

func TestNormalizeServerURL(t *testing.T) {
	if got, err := NormalizeServerURL(" http://10.0.0.5:3000/ "); err != nil || got != "http://10.0.0.5:3000" {
		t.Fatalf("got %q %v", got, err)
	}
	for _, bad := range []string{"", "10.0.0.5", "ftp://x", "http://"} {
		if _, err := NormalizeServerURL(bad); err == nil || !strings.Contains(err.Error(), "must be a URL") {
			t.Fatalf("%q: %v", bad, err)
		}
	}
}

func TestRegisterSavesStateAndUploadsFirstScan(t *testing.T) {
	srv, s := newServer(t), testService(t)
	res, err := s.Register(context.Background(), RegisterInput{ServerURL: srv.URL + "/", Key: " k ", User: user(), UploadFirstScan: true})
	if err != nil || res.UploadErr != nil || res.DeviceID != "dev-1" || res.ScanID != "scan-1" {
		t.Fatalf("got %+v %v", res, err)
	}
	st, err := s.Status()
	if err != nil || !st.Registered || st.TokenErr != nil || st.ServerURL != srv.URL {
		t.Fatalf("status %+v %v", st, err)
	}
	if st.User == nil || st.User.FullName != "Juan Dela Cruz" || st.User.Email != nil || *st.User.Position != "Clerk" {
		t.Fatalf("user %+v", st.User)
	}
	if st.LastReportAt == "" || st.LastPayload == nil || st.LastPayload.System.Hostname == "" {
		t.Fatalf("last report not kept: %+v", st)
	}
	if srv.count("POST /api/agent/scans") != 1 {
		t.Fatalf("calls %v", srv.calls)
	}
}

func TestRegisterWithoutFirstScanKeepsNoReport(t *testing.T) {
	srv, s := newServer(t), testService(t)
	if _, err := s.Register(context.Background(), RegisterInput{ServerURL: srv.URL, Key: "k", User: user()}); err != nil {
		t.Fatal(err)
	}
	if st, _ := s.Status(); st.LastReportAt != "" || st.LastPayload != nil || srv.count("POST /api/agent/scans") != 0 {
		t.Fatalf("unexpected report %+v", st)
	}
}

func TestRegisterWrongKeySavesNothing(t *testing.T) {
	srv, s := newServer(t), testService(t)
	srv.registerStatus = 403
	_, err := s.Register(context.Background(), RegisterInput{ServerURL: srv.URL, Key: "bad", User: user()})
	var apiErr *api.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 403 {
		t.Fatalf("err %v", err)
	}
	if st, _ := s.Status(); st.Registered {
		t.Fatal("registration saved after failure")
	}
}

func TestReportUpdatesLastReport(t *testing.T) {
	srv, s := newServer(t), testService(t)
	if _, err := s.Register(context.Background(), RegisterInput{ServerURL: srv.URL, Key: "k", User: user()}); err != nil {
		t.Fatal(err)
	}
	id, dup, sc, err := s.Report(context.Background(), "manual")
	if err != nil || dup || id != "scan-1" || sc == nil {
		t.Fatalf("got %q %v %v", id, dup, err)
	}
	st, _ := s.Status()
	if st.LastReportAt == "" || st.LastPayload == nil {
		t.Fatalf("status %+v", st)
	}
}

func TestReportBeforeRegisterAndUnauthorized(t *testing.T) {
	srv, s := newServer(t), testService(t)
	if _, _, _, err := s.Report(context.Background(), "manual"); !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("err %v", err)
	}
	if _, err := s.UpdateUser(context.Background(), user()); !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("err %v", err)
	}
	if _, err := s.Register(context.Background(), RegisterInput{ServerURL: srv.URL, Key: "k", User: user()}); err != nil {
		t.Fatal(err)
	}
	srv.reject = true
	if _, _, _, err := s.Report(context.Background(), "manual"); !errors.Is(err, api.ErrUnauthorized) {
		t.Fatalf("report err %v", err)
	}
	if _, err := s.UpdateUser(context.Background(), user()); !errors.Is(err, api.ErrUnauthorized) {
		t.Fatalf("update err %v", err)
	}
	if st, _ := s.Status(); st.LastReportAt != "" {
		t.Fatal("failed upload recorded as a report")
	}
}

func TestUpdateUserSavesStoredDetails(t *testing.T) {
	srv, s := newServer(t), testService(t)
	if _, err := s.Register(context.Background(), RegisterInput{ServerURL: srv.URL, Key: "k", User: user()}); err != nil {
		t.Fatal(err)
	}
	u := user()
	u.Department = " Budget "
	got, err := s.UpdateUser(context.Background(), u)
	if err != nil || got.Department != "Budget" {
		t.Fatalf("got %+v %v", got, err)
	}
	cfg, _ := config.Load()
	if cfg.User == nil || cfg.User.Department != "Budget" {
		t.Fatalf("config user %+v", cfg.User)
	}
}

func TestUploadServerOverrideSavesNothing(t *testing.T) {
	srv, s := newServer(t), testService(t)
	if _, err := s.Register(context.Background(), RegisterInput{ServerURL: srv.URL, Key: "k", User: user()}); err != nil {
		t.Fatal(err)
	}
	sc, err := s.Collect(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Upload(context.Background(), sc, time.Now(), UploadOptions{ServerURL: srv.URL}); err != nil {
		t.Fatal(err)
	}
	if st, _ := s.Status(); st.LastReportAt != "" {
		t.Fatal("override upload recorded as a report")
	}
}

func TestCheckConnection(t *testing.T) {
	srv, s := newServer(t), testService(t)
	if u, err := s.CheckConnection(context.Background(), srv.URL+"/"); err != nil || u != srv.URL {
		t.Fatalf("got %q %v", u, err)
	}
	if _, err := s.CheckConnection(context.Background(), "nonsense"); err == nil {
		t.Fatal("expected error")
	}
	srv.Close()
	if _, err := s.CheckConnection(context.Background(), srv.URL); err == nil || !strings.Contains(err.Error(), "cannot reach") {
		t.Fatalf("err %v", err)
	}
}
