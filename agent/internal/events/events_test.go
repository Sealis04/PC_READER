package events

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

func creds(url string) func() (string, string, error) {
	return func() (string, string, error) { return url, "tok", nil }
}

func noSleep(_ context.Context, _ time.Duration) error { return nil }

func TestReceivesHelloAndRequestsAndSendsTokenAndVersion(t *testing.T) {
	var gotAuth, gotVersion, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotVersion, gotAccept = r.Header.Get("Authorization"), r.URL.Query().Get("agent_version"), r.Header.Get("Accept")
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: hello\ndata: {\"heartbeat_seconds\":25}\n\n")
		fmt.Fprint(w, ": heartbeat\n\n")
		fmt.Fprint(w, "event: request\ndata: {\"id\":\"r1\",\"type\":\"scan_now\",\"created_at\":\"2026-10-19T08:00:00Z\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan payload.PendingRequest, 1)
	var opened atomic.Int32
	c := &Client{Credentials: creds(srv.URL), Version: "0.3.0+x y", OnOpen: func() { opened.Add(1) },
		OnRequest: func(r payload.PendingRequest) { got <- r; cancel() }}
	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run = %v", err)
	}
	r := <-got
	if r.ID != "r1" || r.Type != "scan_now" {
		t.Fatalf("request = %+v", r)
	}
	if gotAuth != "Bearer tok" || gotVersion != "0.3.0+x y" || gotAccept != "text/event-stream" || opened.Load() != 1 {
		t.Fatalf("auth=%q version=%q accept=%q opened=%d", gotAuth, gotVersion, gotAccept, opened.Load())
	}
}

func TestReconnectsWithBackoffSequence(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	var waits []time.Duration
	c := &Client{Credentials: creds(srv.URL), Sleep: func(_ context.Context, d time.Duration) error {
		mu.Lock()
		defer mu.Unlock()
		waits = append(waits, d)
		if len(waits) == 6 {
			cancel()
			return ctx.Err()
		}
		return nil
	}}
	_ = c.Run(ctx)
	want := []time.Duration{time.Second, 5 * time.Second, 15 * time.Second, 60 * time.Second, 60 * time.Second, 60 * time.Second}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits = %v, want %v", waits, want)
		}
	}
	if attempts.Load() != 6 {
		t.Fatalf("attempts = %d", attempts.Load())
	}
}

func TestBackoffResetsAfterAHealthyConnection(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) <= 2 { // two failures, then a stream that ends
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		fmt.Fprint(w, "event: hello\ndata: {\"heartbeat_seconds\":25}\n\n")
	}))
	defer srv.Close()

	// The clock jumps two minutes on every reading, so the third connection counts as healthy.
	var tick atomic.Int64
	now := func() time.Time { return time.Unix(0, 0).Add(time.Duration(tick.Add(1)) * 2 * time.Minute) }
	ctx, cancel := context.WithCancel(context.Background())
	var waits []time.Duration
	c := &Client{Credentials: creds(srv.URL), Now: now, Sleep: func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		if len(waits) == 4 {
			cancel()
			return ctx.Err()
		}
		return nil
	}}
	_ = c.Run(ctx)
	// fail(1s), fail(5s), healthy stream ends -> reset (1s), next attempt is healthy again -> 1s.
	want := []time.Duration{time.Second, 5 * time.Second, time.Second, time.Second}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits = %v, want %v", waits, want)
		}
	}
}

func TestUnauthorizedStopsAndAsksForReregistration(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	var closedErr error
	c := &Client{Credentials: creds(srv.URL), Sleep: noSleep, OnClosed: func(_ bool, err error) { closedErr = err }}
	err := c.Run(context.Background())
	if !errors.Is(err, ErrReregister) || !errors.Is(closedErr, api.ErrUnauthorized) || attempts.Load() != 1 {
		t.Fatalf("err=%v closed=%v attempts=%d", err, closedErr, attempts.Load())
	}
}

func TestSilentStreamIsDroppedAndReconnected(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		fmt.Fprint(w, "event: hello\ndata: {\"heartbeat_seconds\":25}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done() // never sends another byte
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &Client{Credentials: creds(srv.URL), IdleTimeout: 100 * time.Millisecond, Sleep: noSleep,
		OnClosed: func(bool, error) {
			if n.Load() >= 2 {
				cancel()
			}
		}}
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("silent stream was not dropped")
	}
	if n.Load() < 2 {
		t.Fatalf("connections = %d, want a reconnect", n.Load())
	}
}

func TestStatusCallbacksOpenAndClosed(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			fmt.Fprint(w, "event: hello\ndata: {\"heartbeat_seconds\":25}\n\n")
			return // ends: the server closed the stream
		}
		w.WriteHeader(500)
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	var log []string
	c := &Client{Credentials: creds(srv.URL), Sleep: noSleep,
		OnConnecting: func() { log = append(log, "connecting") },
		OnOpen:       func() { log = append(log, "open") },
		OnClosed: func(was bool, err error) {
			log = append(log, fmt.Sprintf("closed(open=%v)", was))
			if len(log) >= 6 {
				cancel()
			}
		}}
	_ = c.Run(ctx)
	want := []string{"connecting", "open", "closed(open=true)", "connecting", "closed(open=false)", "connecting"}
	for i, w := range want {
		if i >= len(log) || log[i] != w {
			t.Fatalf("log = %v, want prefix %v", log, want)
		}
	}
}
