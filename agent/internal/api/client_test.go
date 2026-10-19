package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/payload"
)

func client(t *testing.T, h http.HandlerFunc) (*Client, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	c := New(srv.URL + "/")
	c.Backoff = []time.Duration{time.Millisecond, time.Millisecond}
	c.Sleep = func(context.Context, time.Duration) error { return nil }
	return c, &calls
}

func reply(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func TestDuplicateScanIsSuccess(t *testing.T) {
	c, _ := client(t, reply(409, `{"scan_id":"abc"}`))
	id, dup, err := c.UploadScan(context.Background(), "tok", payload.ScanRequest{})
	if err != nil || !dup || id != "abc" {
		t.Fatalf("got %q %v %v", id, dup, err)
	}
}

func TestBadPayloadIsNotRetried(t *testing.T) {
	c, calls := client(t, reply(400, `{"error":"invalid_payload","message":"bad","details":[{"path":"/payload/gpus","message":"required"}]}`))
	_, _, err := c.UploadScan(context.Background(), "tok", payload.ScanRequest{})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != "invalid_payload" || *calls != 1 {
		t.Fatalf("err %v, calls %d", err, *calls)
	}
}

func TestUnauthorizedStops(t *testing.T) {
	c, calls := client(t, reply(401, `{"error":"unauthorized"}`))
	_, _, err := c.UploadScan(context.Background(), "tok", payload.ScanRequest{})
	if !errors.Is(err, ErrUnauthorized) || *calls != 1 {
		t.Fatalf("err %v, calls %d", err, *calls)
	}
}

func TestServerErrorsAreRetriedThenSucceed(t *testing.T) {
	var n int32
	c, calls := client(t, func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&n, 1) < 3 {
			reply(503, `{"error":"busy"}`)(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("missing bearer token")
		}
		reply(201, `{"scan_id":"ok"}`)(w, r)
	})
	id, _, err := c.UploadScan(context.Background(), "tok", payload.ScanRequest{})
	if err != nil || id != "ok" || *calls != 3 {
		t.Fatalf("id %q err %v calls %d", id, err, *calls)
	}
}

func TestRetriesAreBounded(t *testing.T) {
	c, calls := client(t, reply(500, `oops`))
	_, _, err := c.UploadScan(context.Background(), "tok", payload.ScanRequest{})
	if err == nil || *calls != 3 {
		t.Fatalf("err %v calls %d", err, *calls)
	}
}

func TestRegisterWrongKey(t *testing.T) {
	c, _ := client(t, reply(403, `{"error":"invalid_enrollment_key","message":"Enrollment key is not valid"}`))
	_, err := c.Register(context.Background(), payload.RegisterRequest{})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 403 {
		t.Fatalf("err %v", err)
	}
}
