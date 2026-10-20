// Package background is what the desktop app (and `pcreader listen`) does while it runs: hold the
// events connection, send a network snapshot when it opens and when the network changes, and act
// on dashboard requests (scan now, send logs, ask the user to confirm details). Nothing runs on
// a timer; the only automatic traffic is the open connection, the snapshots and reconnects.
package background

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/events"
	"github.com/sealis04/pc_reader/agent/internal/locallog"
	"github.com/sealis04/pc_reader/agent/internal/netinfo"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

// Status is the connection state shown in the tray and the window.
type Status string

const (
	StatusConnecting Status = "connecting"
	StatusConnected  Status = "connected"
	StatusOffline    Status = "offline"
	// StatusReregister: the server rejected the token; IT must register this computer again.
	StatusReregister Status = "reregister"
)

// Label is the status in plain words.
func (s Status) Label() string {
	switch s {
	case StatusConnected:
		return "Connected"
	case StatusOffline:
		return "Offline"
	case StatusReregister:
		return "Re-registration needed"
	}
	return "Connecting…"
}

// Runner holds the background behaviour. Svc and Log are required; the rest is optional.
type Runner struct {
	Svc     *app.Service
	Log     *locallog.Store
	Version string

	// Snapshot collects the network snapshot. nil uses netinfo.Collect.
	Snapshot func(context.Context) (payload.NetworkSnapshot, error)
	// WatchInterval and Fingerprint tune the network change detector (nil/0: 30 s, real interfaces).
	WatchInterval time.Duration
	Fingerprint   func() string
	// Tune adjusts the events client (tests shorten the backoff).
	Tune func(*events.Client)

	// OnStatus is called on every change of status. OnPrompt is called when IT asked the user to
	// confirm their details (open the window on "Update my details"); the request carries IT's
	// approval code, with which the user can save once without the PIN.
	OnStatus func(Status)
	OnPrompt func(req payload.PendingRequest)

	mu       sync.Mutex
	status   Status
	failNote bool            // a failed attempt was already logged since the last open stream
	inflight map[string]bool // request ids being handled
	work     sync.Mutex      // one scan or upload at a time
	watcher  *netinfo.Watcher
	ctx      context.Context
}

// Status returns the current connection status.
func (r *Runner) Status() Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status == "" {
		return StatusConnecting
	}
	return r.status
}

func (r *Runner) setStatus(s Status) {
	r.mu.Lock()
	changed := r.status != s
	r.status = s
	r.mu.Unlock()
	if changed && r.OnStatus != nil {
		r.OnStatus(s)
	}
}

func (r *Runner) log(level, category, format string, args ...any) {
	if r.Log != nil {
		_ = r.Log.Add(level, category, fmt.Sprintf(format, args...))
	}
}

func (r *Runner) snapshot(ctx context.Context) (payload.NetworkSnapshot, error) {
	if r.Snapshot != nil {
		return r.Snapshot(ctx)
	}
	return netinfo.Collect(ctx)
}

// Run holds the connection until ctx ends (returns ctx.Err()) or the server rejects this
// computer's token (returns events.ErrReregister).
func (r *Runner) Run(ctx context.Context) error {
	r.ctx = ctx
	r.inflight = map[string]bool{}
	r.watcher = &netinfo.Watcher{
		Interval:    r.WatchInterval,
		Fingerprint: r.Fingerprint,
		Collect:     r.snapshot,
		OnChange:    func(s payload.NetworkSnapshot) { r.sendSnapshot(ctx, &s) },
		OnError:     func(err error) { r.log(locallog.Warning, locallog.System, "Could not read the network details") },
	}
	go r.watcher.Run(ctx)

	c := &events.Client{
		Credentials:  r.Svc.Credentials,
		Version:      r.Version,
		OnConnecting: func() { r.setStatus(StatusConnecting) },
		OnOpen: func() {
			r.mu.Lock()
			r.failNote = false
			r.mu.Unlock()
			r.setStatus(StatusConnected)
			r.log(locallog.Info, locallog.System, "Connected to the server")
			go r.sendSnapshot(ctx, nil)
		},
		OnClosed: func(wasOpen bool, err error) {
			if errors.Is(err, events.ErrReregister) {
				r.setStatus(StatusReregister)
				r.log(locallog.Error, locallog.System, "The server no longer recognises this computer; registration is needed")
				return
			}
			r.setStatus(StatusOffline)
			r.mu.Lock()
			first := wasOpen || !r.failNote
			r.failNote = true
			r.mu.Unlock()
			if wasOpen {
				r.log(locallog.Warning, locallog.System, "Connection to the server was lost; reconnecting")
			} else if first {
				r.log(locallog.Warning, locallog.System, "Cannot reach the server; will keep trying")
			}
		},
		OnRequest: func(req payload.PendingRequest) { go r.handle(req) },
	}
	if r.Tune != nil {
		r.Tune(c)
	}
	err := c.Run(ctx)
	if errors.Is(err, events.ErrReregister) {
		r.setStatus(StatusReregister)
	}
	return err
}

// sendSnapshot sends snap, or a fresh snapshot when snap is nil (the connection just opened).
func (r *Runner) sendSnapshot(ctx context.Context, snap *payload.NetworkSnapshot) {
	if snap == nil {
		s, err := r.snapshot(ctx)
		if err != nil {
			r.log(locallog.Warning, locallog.System, "Could not read the network details")
			return
		}
		snap = &s
		r.watcher.Prime(s)
	}
	client, token, err := r.Svc.APIClient()
	if err != nil {
		return
	}
	if err := client.SendNetwork(ctx, token, *snap); err != nil && ctx.Err() == nil {
		r.log(locallog.Warning, locallog.Sync, "Network details could not be sent")
	}
}

func (r *Runner) claim(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.inflight[id] {
		return false
	}
	r.inflight[id] = true
	return true
}

func (r *Runner) release(id string) {
	r.mu.Lock()
	delete(r.inflight, id)
	r.mu.Unlock()
}

// handle acts on one dashboard request and reports the outcome. A request the server sends
// again while it is still being handled (a reconnect) is ignored.
func (r *Runner) handle(req payload.PendingRequest) {
	if !r.claim(req.ID) {
		return
	}
	defer r.release(req.ID)
	ctx := r.ctx

	var res payload.RequestComplete
	switch req.Type {
	case payload.RequestScanNow:
		res = r.scanNow(ctx)
	case payload.RequestSendLogs:
		res = r.sendLogs(ctx)
	case payload.RequestPromptDetailsUpdate:
		// The user's save closes this request on the server (or it expires after 24 hours), so it is
		// not completed here: its approval code stays valid until then.
		r.log(locallog.Info, locallog.Update, "IT asked for the details to be confirmed")
		if r.OnPrompt != nil {
			r.OnPrompt(req)
		}
		return
	default:
		res = payload.RequestComplete{Result: "failed", Message: "This version does not know that request"}
	}

	client, token, err := r.Svc.APIClient()
	if err == nil {
		err = client.CompleteRequest(ctx, token, req.ID, res)
	}
	if err != nil && ctx.Err() == nil {
		r.log(locallog.Warning, locallog.Sync, "Could not confirm a request to the server")
	}
}

func (r *Runner) scanNow(ctx context.Context) payload.RequestComplete {
	r.work.Lock()
	defer r.work.Unlock()
	r.log(locallog.Info, locallog.Scan, "IT asked for a scan")
	scanID, _, _, err := r.Svc.Report(ctx, "on_demand", "")
	if err != nil {
		return payload.RequestComplete{Result: "failed", Message: "The scan could not be completed"}
	}
	return payload.RequestComplete{Result: "done", ScanID: scanID}
}

func (r *Runner) sendLogs(ctx context.Context) payload.RequestComplete {
	r.work.Lock()
	defer r.work.Unlock()
	client, token, err := r.Svc.APIClient()
	if err != nil {
		return payload.RequestComplete{Result: "failed", Message: "This computer is not registered"}
	}
	n, err := UploadLogs(ctx, r.Log, client, token)
	if err != nil {
		r.log(locallog.Error, locallog.Sync, "Log upload failed after %d entries", n)
		return payload.RequestComplete{Result: "failed", Message: "The logs could not be uploaded"}
	}
	r.log(locallog.Info, locallog.Sync, "Uploaded %d log entries", n)
	return payload.RequestComplete{Result: "done"}
}

// OpenLog opens the local log in the app data folder (shared by the desktop app and the CLI).
func OpenLog() (*locallog.Store, error) {
	dir, err := config.Dir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return locallog.Open(filepath.Join(dir, locallog.DefaultFile))
}
