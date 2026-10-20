// Package api calls the server's /api/agent/* endpoints, applying the spec's
// error rules: 400 no retry, 401 stop, 409 success, 429/5xx/network errors retried with backoff.
package api

import (
	"bytes"
	"context"
	"encoding/base64"
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

// do sends body (POST unless method says otherwise) and decodes the response into out for any status in ok.
func (c *Client) do(ctx context.Context, method, path, token string, body any, out any, ok ...int) (int, error) {
	var b []byte // nil: no request body (GET)
	if body != nil {
		var err error
		if b, err = json.Marshal(body); err != nil {
			return 0, err
		}
	}
	var lastErr error
	for attempt := 0; ; attempt++ {
		status, err := c.once(ctx, method, path, token, b, out, ok)
		if err == nil {
			return status, nil
		}
		lastErr = err
		// status 0 means no response at all (network error or timeout).
		transient := status == 0 || retryable(status)
		var apiErr *Error
		if errors.As(err, &apiErr) && apiErr.Code == "too_many_attempts" {
			transient = false // wrong-PIN rate limit: waiting a few seconds will not clear it
		}
		if !transient || ctx.Err() != nil || attempt >= len(c.Backoff) {
			return status, lastErr
		}
		if err := c.Sleep(ctx, c.Backoff[attempt]); err != nil {
			return 0, err
		}
	}
}

func (c *Client) once(ctx context.Context, method, path, token string, body []byte, out any, ok []int) (int, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bytes.NewReader(body))
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
			if out == nil {
				return res.StatusCode, nil
			}
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
	if _, err := c.do(ctx, http.MethodPost, "/api/agent/register", "", req, &out, http.StatusCreated); err != nil {
		return nil, err
	}
	return &out, nil
}

// UploadScan returns the scan ID. A duplicate scan_uuid (409) counts as success.
func (c *Client) UploadScan(ctx context.Context, token string, req payload.ScanRequest) (scanID string, duplicate bool, err error) {
	var out payload.ScanResponse
	status, err := c.do(ctx, http.MethodPost, "/api/agent/scans", token, req, &out, http.StatusCreated, http.StatusConflict)
	if err != nil {
		return "", false, err
	}
	return out.ScanID, status == http.StatusConflict, nil
}

// UpdateUser sends the user's corrected details (or a new person's, which reassigns the
// computer) with the current IT PIN, and returns the details as stored. A wrong PIN is a 403 *Error.
func (c *Client) UpdateUser(ctx context.Context, token string, u payload.UserDetails, pin string) (*payload.UserDetails, error) {
	return c.putUser(ctx, token, payload.UserRequest{UserDetails: u, ITPIN: pin})
}

// ConfirmUser saves the user's details with the approval code of IT's "confirm details" request
// instead of the PIN (same employee ID only). A used, expired or wrong code is a 403 *Error.
func (c *Client) ConfirmUser(ctx context.Context, token string, u payload.UserDetails, confirm payload.ConfirmApproval) (*payload.UserDetails, error) {
	return c.putUser(ctx, token, payload.UserRequest{UserDetails: u, Confirm: &confirm})
}

func (c *Client) putUser(ctx context.Context, token string, body payload.UserRequest) (*payload.UserDetails, error) {
	var out payload.UserDetails
	if _, err := c.do(ctx, http.MethodPut, "/api/agent/user", token, body, &out, http.StatusOK); err != nil {
		return nil, err
	}
	return &out, nil
}

// SendNetwork stores a network snapshot (sent when the connection opens and when the network changes).
func (c *Client) SendNetwork(ctx context.Context, token string, snap payload.NetworkSnapshot) error {
	_, err := c.do(ctx, http.MethodPost, "/api/agent/network", token, snap, nil, http.StatusNoContent)
	return err
}

// UploadLogs sends up to 500 entries and returns the ids the server now holds. A 413 comes back as
// an *Error with Status 413: split the batch and retry.
func (c *Client) UploadLogs(ctx context.Context, token string, entries []payload.LogEntry) ([]int64, error) {
	var out payload.LogsResponse
	if _, err := c.do(ctx, http.MethodPost, "/api/agent/logs", token, payload.LogsRequest{Entries: entries}, &out, http.StatusOK); err != nil {
		return nil, err
	}
	return out.ReceivedIDs, nil
}

// CompleteRequest tells the server how a dashboard request went. Repeating it is safe.
func (c *Client) CompleteRequest(ctx context.Context, token, id string, res payload.RequestComplete) error {
	var out struct{}
	_, err := c.do(ctx, http.MethodPost, "/api/agent/requests/"+id+"/complete", token, res, &out, http.StatusOK)
	return err
}

// UnlockSettings asks the server whether pin is the current IT PIN. It returns nil only for a yes. A
// wrong PIN is an *Error with Status 403 and Code "wrong_pin"; too many tries is Status 429;
// ErrUnauthorized means the server rejected the device token. Anything else (no reply, 5xx) means the
// server could not answer, which the caller treats as offline. It never retries, so a PC that cannot
// reach the server finds out quickly.
func (c *Client) UnlockSettings(ctx context.Context, token, pin string) error {
	once := *c
	once.Backoff = nil
	var out payload.SettingsUnlockResponse
	if _, err := once.do(ctx, http.MethodPost, "/api/agent/settings-unlock", token, payload.SettingsUnlockRequest{PIN: pin}, &out, http.StatusOK); err != nil {
		return err
	}
	if !out.OK {
		return errors.New("unexpected response from server")
	}
	return nil
}

// Branding fetches the agency name and logo path. The endpoint is public, so no token is sent; like
// UnlockSettings it never retries, so an offline start is not held up.
func (c *Client) Branding(ctx context.Context) (*payload.Branding, error) {
	once := *c
	once.Backoff = nil
	var out payload.Branding
	if _, err := once.do(ctx, http.MethodGet, "/api/branding", "", nil, &out, http.StatusOK); err != nil {
		return nil, err
	}
	if strings.TrimSpace(out.Name) == "" {
		return nil, errors.New("the server sent no agency name")
	}
	return &out, nil
}

// MaxLogoBytes is the largest logo the server accepts and the app will take.
const MaxLogoBytes = 512 * 1024

// BrandingLogo downloads the logo at path (the logo_url the server gave) and returns it as a data: URL.
// Only the server's own logo path and PNG, JPEG or WebP images are accepted.
func (c *Client) BrandingLogo(ctx context.Context, path string) (string, error) {
	if !strings.HasPrefix(path, "/api/branding/logo") {
		return "", errors.New("unexpected logo address")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return "", err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("cannot reach %s: %w", c.BaseURL, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", &Error{Status: res.StatusCode, Message: "the logo could not be fetched"}
	}
	typ := strings.ToLower(strings.TrimSpace(strings.SplitN(res.Header.Get("Content-Type"), ";", 2)[0]))
	switch typ {
	case "image/png", "image/jpeg", "image/webp":
	default:
		return "", fmt.Errorf("the logo has an unsupported type %q", typ)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, MaxLogoBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) == 0 || len(data) > MaxLogoBytes {
		return "", errors.New("the logo is empty or too large")
	}
	return "data:" + typ + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// Ping checks that the server answers, without retries: any 2xx or 3xx reply from the
// dashboard's device list counts. It does not validate the enrollment key.
func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/devices", nil)
	if err != nil {
		return err
	}
	// Redirects (e.g. to a login page later) still prove the server is there.
	hc := *c.HTTP
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach %s: %w", c.BaseURL, err)
	}
	_ = res.Body.Close()
	if res.StatusCode >= 400 {
		return &Error{Status: res.StatusCode, Message: "this address answered, but it does not look like a PC_READER server"}
	}
	return nil
}
