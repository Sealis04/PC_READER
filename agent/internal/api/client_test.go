package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/contract"
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

func TestUpdateUserPutsDetailsWithToken(t *testing.T) {
	c, _ := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/agent/user" || r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("unexpected request %s %s auth %q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		reply(200, `{"full_name":"A B","employee_id":"E1","email":null,"department":"IT","position":null,"phone":null}`)(w, r)
	})
	got, err := c.UpdateUser(context.Background(), "tok", payload.UserDetails{FullName: "A B", EmployeeID: "E1", Department: "IT"})
	if err != nil || got.EmployeeID != "E1" {
		t.Fatalf("got %+v %v", got, err)
	}
}

func TestUpdateUserUnauthorized(t *testing.T) {
	c, calls := client(t, reply(401, `{"error":"unauthorized"}`))
	if _, err := c.UpdateUser(context.Background(), "tok", payload.UserDetails{}); !errors.Is(err, ErrUnauthorized) || *calls != 1 {
		t.Fatalf("err %v calls %d", err, *calls)
	}
}

func TestPing(t *testing.T) {
	c, calls := client(t, reply(200, `<html>`))
	if err := c.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	c, calls = client(t, reply(404, `nope`))
	var apiErr *Error
	if err := c.Ping(context.Background()); !errors.As(err, &apiErr) || apiErr.Status != 404 || *calls != 1 {
		t.Fatalf("err %v calls %d", err, *calls)
	}
}

func TestUnlockSettingsAnswers(t *testing.T) {
	c, calls := client(t, func(w http.ResponseWriter, r *http.Request) {
		var req payload.SettingsUnlockRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if err := contract.Validate("settings-unlock", req); err != nil {
			t.Errorf("request does not match the contract: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		if req.PIN != "123456" {
			w.WriteHeader(403)
			_, _ = w.Write([]byte(`{"error":"wrong_pin","message":"nope"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	ctx := context.Background()
	if err := c.UnlockSettings(ctx, "tok", "123456"); err != nil {
		t.Fatal(err)
	}
	var apiErr *Error
	if err := c.UnlockSettings(ctx, "tok", "000000"); !errors.As(err, &apiErr) || apiErr.Status != 403 || apiErr.Code != "wrong_pin" {
		t.Fatalf("wrong PIN: %v", err)
	}
	if err := c.UnlockSettings(ctx, "bad", "123456"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("bad token: %v", err)
	}
	if *calls != 3 {
		t.Fatalf("calls = %d, want one each", *calls)
	}
}

func TestUnlockSettingsDoesNotRetry(t *testing.T) {
	for _, status := range []int{429, 503} {
		c, calls := client(t, reply(status, `{"error":"x"}`))
		var apiErr *Error
		if err := c.UnlockSettings(context.Background(), "tok", "123456"); !errors.As(err, &apiErr) || apiErr.Status != status || *calls != 1 {
			t.Fatalf("status %d: err %v, calls %d", status, err, *calls)
		}
	}
}
