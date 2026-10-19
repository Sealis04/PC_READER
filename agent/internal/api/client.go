// Package api calls the server's /api/agent/* endpoints, applying the spec's
// error rules: 400 no retry, 401 stop, 409 success, 429/5xx/network errors retried with backoff.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/payload"
)

// Error is a non-success response from the server.
type Error struct {
	Status  int
	Code    string `json:"error"`
	Message string `json:"message"`
	Details []struct {
		Path    string `json:"path"`
		Message string `json:"message"`
	} `json:"details"`
}

func (e *Error) Error() string {
	msg := fmt.Sprintf("server returned %d", e.Status)
	if e.Code != "" {
		msg += " " + e.Code
	}
	if e.Message != "" {
		msg += ": " + e.Message
	}
	for i, d := range e.Details {
		if i == 5 {
			msg += fmt.Sprintf(" (and %d more)", len(e.Details)-5)
			break
		}
		msg += fmt.Sprintf("\n  %s %s", d.Path, d.Message)
	}
	return msg
}

var ErrUnauthorized = errors.New("the server rejected this device's token; re-registration needed (`pcreader register`)")

type Client struct {
	BaseURL string
	HTTP    *http.Client
	// Backoff lists the waits before each retry of a retryable failure. The CLI uses
	// short waits; the background reporter (M2) uses the spec's 1, 5, 15, 60 minutes.
	Backoff []time.Duration
	Sleep   func(context.Context, time.Duration) error
}

func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 60 * time.Second},
		Backoff: []time.Duration{2 * time.Second, 5 * time.Second, 15 * time.Second},
		Sleep: func(ctx context.Context, d time.Duration) error {
			select {
			case <-time.After(d):
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
}

func retryable(status int) bool { return status == http.StatusTooManyRequests || status >= 500 }

// do POSTs body and decodes the response into out for any status in ok.
func (c *Client) do(ctx context.Context, path, token string, body any, out any, ok ...int) (int, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	var lastErr error
	for attempt := 0; ; attempt++ {
		status, err := c.once(ctx, path, token, b, out, ok)
		if err == nil {
			return status, nil
		}
		lastErr = err
		// status 0 means no response at all (network error or timeout).
		transient := status == 0 || retryable(status)
		if !transient || ctx.Err() != nil || attempt >= len(c.Backoff) {
			return status, lastErr
		}
		if err := c.Sleep(ctx, c.Backoff[attempt]); err != nil {
			return 0, err
		}
	}
}

func (c *Client) once(ctx context.Context, path, token string, body []byte, out any, ok []int) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, fmt.Errorf("cannot reach %s: %w", c.BaseURL, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return res.StatusCode, err
	}
	for _, s := range ok {
		if res.StatusCode == s {
			if err := json.Unmarshal(data, out); err != nil {
				return res.StatusCode, fmt.Errorf("unexpected response from server: %w", err)
			}
			return res.StatusCode, nil
		}
	}
	if res.StatusCode == http.StatusUnauthorized && token != "" {
		return res.StatusCode, ErrUnauthorized
	}
	apiErr := &Error{Status: res.StatusCode}
	_ = json.Unmarshal(data, apiErr)
	if apiErr.Code == "" && apiErr.Message == "" {
		apiErr.Message = strings.TrimSpace(string(data))
		if len(apiErr.Message) > 200 {
			apiErr.Message = apiErr.Message[:200]
		}
	}
	return res.StatusCode, apiErr
}

func (c *Client) Register(ctx context.Context, req payload.RegisterRequest) (*payload.RegisterResponse, error) {
	var out payload.RegisterResponse
	if _, err := c.do(ctx, "/api/agent/register", "", req, &out, http.StatusCreated); err != nil {
		return nil, err
	}
	return &out, nil
}

// UploadScan returns the scan ID. A duplicate scan_uuid (409) counts as success.
func (c *Client) UploadScan(ctx context.Context, token string, req payload.ScanRequest) (scanID string, duplicate bool, err error) {
	var out payload.ScanResponse
	status, err := c.do(ctx, "/api/agent/scans", token, req, &out, http.StatusCreated, http.StatusConflict)
	if err != nil {
		return "", false, err
	}
	return out.ScanID, status == http.StatusConflict, nil
}
