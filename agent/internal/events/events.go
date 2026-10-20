// Package events is the agent's one long-lived connection to the server: a Server-Sent Events
// stream (GET /api/agent/events) that delivers dashboard requests the moment they are queued.
// There is no polling. After sleep, network loss or a server restart the client reconnects
// with backoff; a 401 stops it, because the token is no longer valid.
package events

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

// Backoff is the wait before each reconnect: 1 s, 5 s, 15 s, then 60 s until it works.
var Backoff = []time.Duration{time.Second, 5 * time.Second, 15 * time.Second, 60 * time.Second}

// HealthyAfter is how long a connection must stay open before the backoff starts over.
const HealthyAfter = time.Minute

// IdleTimeout drops a stream that has been silent this long. The server sends a heartbeat
// about every 25 seconds, so silence means the connection is dead (sleep, Wi-Fi change).
const IdleTimeout = 75 * time.Second

// ErrReregister means the server rejected the token (401): stop and ask for registration.
var ErrReregister = api.ErrUnauthorized

// Client runs the stream. Zero values for the optional fields use the defaults above.
type Client struct {
	// Credentials returns the server address and device token (read on every connect, so a
	// changed address or a new registration is picked up).
	Credentials func() (serverURL, token string, err error)
	Version     string
	HTTP        *http.Client // must have no overall Timeout; the stream is meant to stay open
	Backoff     []time.Duration
	IdleTimeout time.Duration
	Sleep       func(context.Context, time.Duration) error
	Now         func() time.Time

	// OnConnecting runs before each attempt, OnOpen when the stream is open (hello received),
	// OnClosed when an open stream ended or an attempt failed (err explains why).
	OnConnecting func()
	OnOpen       func()
	OnClosed     func(wasOpen bool, err error)
	// OnRequest runs for every "request" event, on the reading goroutine: hand off long work.
	OnRequest func(payload.PendingRequest)
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{}
}

func (c *Client) backoff() []time.Duration {
	if len(c.Backoff) > 0 {
		return c.Backoff
	}
	return Backoff
}

func (c *Client) idle() time.Duration {
	if c.IdleTimeout > 0 {
		return c.IdleTimeout
	}
	return IdleTimeout
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Client) sleep(ctx context.Context, d time.Duration) error {
	if c.Sleep != nil {
		return c.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Run connects and keeps reconnecting until ctx ends (returns ctx.Err()) or the server rejects
// the token (returns ErrReregister).
func (c *Client) Run(ctx context.Context) error {
	step := 0
	for {
		if c.OnConnecting != nil {
			c.OnConnecting()
		}
		started := c.now()
		opened, err := c.once(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, api.ErrUnauthorized) {
			if c.OnClosed != nil {
				c.OnClosed(opened, err)
			}
			return ErrReregister
		}
		if opened && c.now().Sub(started) >= HealthyAfter {
			step = 0
		}
		if c.OnClosed != nil {
			c.OnClosed(opened, err)
		}
		b := c.backoff()
		wait := b[min(step, len(b)-1)]
		step++
		if err := c.sleep(ctx, wait); err != nil {
			return err
		}
	}
}

// once makes one connection and reads it until it ends. opened reports whether the hello arrived.
func (c *Client) once(ctx context.Context) (opened bool, err error) {
	server, token, err := c.Credentials()
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	u := strings.TrimRight(server, "/") + "/api/agent/events?agent_version=" + url.QueryEscape(c.Version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "text/event-stream")
	res, err := c.http().Do(req)
	if err != nil {
		return false, fmt.Errorf("cannot reach %s: %w", server, err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return false, api.ErrUnauthorized
	}
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		apiErr := &api.Error{Status: res.StatusCode}
		_ = json.Unmarshal(data, apiErr)
		return false, apiErr
	}

	// Cancel the request when nothing (not even a heartbeat) arrives for IdleTimeout.
	idle := time.AfterFunc(c.idle(), cancel)
	defer idle.Stop()

	r := bufio.NewReader(res.Body)
	var event string
	var data []string
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			if ctx.Err() != nil {
				return opened, errors.New("connection went silent")
			}
			if errors.Is(err, io.EOF) {
				return opened, errors.New("the server closed the connection")
			}
			return opened, err
		}
		idle.Reset(c.idle())
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if event != "" || len(data) > 0 {
				if c.dispatch(event, strings.Join(data, "\n"), &opened) {
					return opened, errors.New("unreadable message from the server")
				}
			}
			event, data = "", nil
		case strings.HasPrefix(line, ":"):
			// heartbeat comment
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
}

// dispatch handles one complete message and reports whether it was unreadable.
func (c *Client) dispatch(event, data string, opened *bool) (bad bool) {
	switch event {
	case "hello":
		if !*opened {
			*opened = true
			if c.OnOpen != nil {
				c.OnOpen()
			}
		}
	case "request":
		var r payload.PendingRequest
		if err := json.Unmarshal([]byte(data), &r); err != nil || r.ID == "" {
			return true
		}
		if c.OnRequest != nil {
			c.OnRequest(r)
		}
	}
	return false
}
