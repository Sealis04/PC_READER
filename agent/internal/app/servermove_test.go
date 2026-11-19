package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

// moveRig is a registered PC on old (which records move results) and a new address that answers /me.
type moveRig struct {
	s       *Service
	old     *httptest.Server
	mu      sync.Mutex
	results []payload.MoveResult
}

func newMoveRig(t *testing.T) *moveRig {
	t.Helper()
	f := newServer(t)
	m := &moveRig{s: testService(t), old: f.Server}
	if _, err := m.s.Register(context.Background(), RegisterInput{ServerURL: f.URL, Key: "k", PIN: "123456", User: user()}); err != nil {
		t.Fatal(err)
	}
	// Wrap the fake: record move results, delegate the rest.
	inner := f.Config.Handler
	f.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/move-result" {
			var res payload.MoveResult
			_ = json.NewDecoder(r.Body).Decode(&res)
			m.mu.Lock()
			m.results = append(m.results, res)
			m.mu.Unlock()
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		inner.ServeHTTP(w, r)
	})
	return m
}

func newAddress(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/me" || r.Header.Get("Authorization") != "Bearer tok-1" {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFollowMove(t *testing.T) {
	cases := []struct {
		name   string
		url    func(t *testing.T) string
		moved  bool
		reason string
	}{
		{"same device", func(t *testing.T) string { return newAddress(t, 200, `{"device_id":"dev-1"}`).URL + "/" }, true, ""},
		{"unknown token", func(t *testing.T) string { return newAddress(t, 401, `{"error":"unauthorized"}`).URL }, false, payload.MoveUnknownDevice},
		{"other device", func(t *testing.T) string { return newAddress(t, 200, `{"device_id":"dev-2"}`).URL }, false, payload.MoveDifferentDevice},
		{"server error", func(t *testing.T) string { return newAddress(t, 500, `{}`).URL }, false, payload.MoveUnreachable},
		{"unreachable", func(t *testing.T) string { s := newAddress(t, 200, ""); s.Close(); return s.URL }, false, payload.MoveUnreachable},
		{"bad address", func(t *testing.T) string { return "ftp://somewhere" }, false, payload.MoveInvalidURL},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := newMoveRig(t)
			target := c.url(t)
			moved, reason, err := m.s.FollowMove(context.Background(), payload.ServerMoved{MoveID: "move-1", URL: target})
			if err != nil || moved != c.moved || reason != c.reason {
				t.Fatalf("moved=%v reason=%q err=%v", moved, reason, err)
			}
			cfg, _ := config.Load()
			want := m.old.URL
			if c.moved {
				want = strings.TrimRight(target, "/")
			}
			if cfg.ServerURL != want {
				t.Fatalf("server url %q, want %q", cfg.ServerURL, want)
			}
			if len(m.results) != 1 || m.results[0].Moved != c.moved || m.results[0].Reason != c.reason || m.results[0].MoveID != "move-1" {
				t.Fatalf("reported %+v", m.results)
			}
		})
	}
}

func TestFollowMoveNeedsRegistration(t *testing.T) {
	s := testService(t)
	if _, _, err := s.FollowMove(context.Background(), payload.ServerMoved{MoveID: "m", URL: "http://x"}); err != ErrNotRegistered {
		t.Fatalf("err = %v", err)
	}
}
