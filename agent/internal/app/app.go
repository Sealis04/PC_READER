// Package app is the agent's service layer: scan, register, upload, update details and
// status. The CLI (cmd/pcreader) and the desktop app (desktop/) both call it, so they
// share one config folder, token store and set of rules.
package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	"github.com/sealis04/pc_reader/agent/internal/scan"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// Notice is the data-use notice shown before anyone registers (CLI and desktop app).
const Notice = `Data-use notice: PC_READER records your name, employee ID, department, position,
email and phone, plus this computer's hardware specs and basic network details
(IP and MAC addresses, gateway, DNS, Wi-Fi network name). The app starts when you
log in and keeps a quiet connection to the server so IT can see that this computer
is online, when it was last seen and which app version it runs, and can ask it for
a new scan, its app activity log (what PC_READER did, such as "scan completed") or
for you to confirm your details. Your network details are sent when the app
connects and whenever your network changes. It does not record browsing,
keystrokes, screenshots, files or location. IT uses this data only to manage
agency equipment.`

// ErrNotRegistered means there is no saved registration to report or update with.
var ErrNotRegistered = errors.New("this computer is not registered yet; run `pcreader register` first")

// Service holds what the operations need; tests replace the fields.
type Service struct {
	Version string
	// Scan collects this computer's hardware data. nil uses the real scanners (Windows/macOS).
	Scan func(ctx context.Context) (rd.Set, error)
	// NewClient builds the API client for a server URL. nil uses api.New.
	NewClient func(serverURL string) *api.Client
	// Tokens keeps the device token. nil uses config.NewTokenStore().
	Tokens config.TokenStore
	Now    func() time.Time
	// Log records an entry in the local log (level, category, message). nil logs nothing. Messages
	// must never carry tokens or personal details.
	Log func(level, category, message string)
}

func (s *Service) logf(level, category, format string, args ...any) {
	if s.Log != nil {
		s.Log(level, category, fmt.Sprintf(format, args...))
	}
}

// APIClient returns an API client for the registered server together with the device token.
func (s *Service) APIClient() (*api.Client, string, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, "", err
	}
	if cfg.DeviceUUID == "" || cfg.ServerURL == "" {
		return nil, "", ErrNotRegistered
	}
	token, err := s.tokens().Get(cfg.DeviceUUID)
	if err != nil {
		return nil, "", err
	}
	return s.client(cfg.ServerURL), token, nil
}

// Credentials returns the registered server address and device token.
func (s *Service) Credentials() (serverURL, token string, err error) {
	cfg, err := config.Load()
	if err != nil {
		return "", "", err
	}
	if cfg.DeviceUUID == "" || cfg.ServerURL == "" {
		return "", "", ErrNotRegistered
	}
	token, err = s.tokens().Get(cfg.DeviceUUID)
	return cfg.ServerURL, token, err
}

// New returns a Service wired to the real scanners, API client, credential store and clock.
// The token store is resolved on each use, so PCREADER_TOKEN_STORE is read late.
func New(version string) *Service {
	return &Service{Version: version}
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) client(serverURL string) *api.Client {
	if s.NewClient != nil {
		return s.NewClient(serverURL)
	}
	return api.New(serverURL)
}

func (s *Service) tokens() config.TokenStore {
	if s.Tokens != nil {
		return s.Tokens
	}
	return config.NewTokenStore()
}

// NormalizeServerURL checks a server address and strips trailing slashes.
func NormalizeServerURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("must be a URL like http://192.168.1.10:3000 (got %q)", raw)
	}
	return strings.TrimRight(u.String(), "/"), nil
}

// Collect scans this computer, or parses a folder saved by capture-raw (fromRaw).
func (s *Service) Collect(ctx context.Context, fromRaw string) (*payload.Scan, error) {
	var raw rd.Set
	var err error
	switch {
	case fromRaw != "":
		raw, err = rd.Load(fromRaw)
	case s.Scan != nil:
		raw, err = s.Scan(ctx)
	default:
		raw, err = scan.CollectRaw(ctx)
	}
	if err != nil {
		return nil, err
	}
	return scan.Parse(raw, s.Version)
}

// RegisterInput is everything registration needs. PolicyAccepted must be true.
type RegisterInput struct {
	ServerURL string
	Key       string
	// PIN is the current hourly IT PIN (shown on the dashboard); the server checks it after the key.
	PIN  string
	User payload.UserDetails
	// FromRaw uses a folder saved by capture-raw instead of scanning (testing).
	FromRaw string
	// UploadFirstScan also uploads the scan taken for registration.
	UploadFirstScan bool
}

// Registered is the outcome of Register. UploadErr is set when registration worked but the
// first scan could not be uploaded; the computer is registered either way.
type Registered struct {
	Hostname  string
	DeviceID  string
	ScanID    string
	UploadErr error
}

// Register scans, registers with the server, stores the token and saves config.json.
func (s *Service) Register(ctx context.Context, in RegisterInput) (*Registered, error) {
	serverURL, err := NormalizeServerURL(in.ServerURL)
	if err != nil {
		return nil, err
	}
	collectedAt := s.now()
	sc, err := s.Collect(ctx, in.FromRaw)
	if err != nil {
		s.logf("error", "scan", "Scan failed during sign-up")
		return nil, err
	}
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	u := trimUser(in.User)
	client := s.client(serverURL)
	res, err := client.Register(ctx, payload.RegisterRequest{
		EnrollmentKey: strings.TrimSpace(in.Key),
		ITPIN:         strings.TrimSpace(in.PIN),
		DeviceUUID:    cfg.EnsureDeviceUUID(),
		OSType:        sc.OSType,
		Hostname:      sc.System.Hostname,
		HardwareSummary: payload.Summary{
			Manufacturer: sc.System.Manufacturer,
			Model:        sc.System.Model,
			SerialNumber: sc.System.SerialNumber,
		},
		User: payload.User{UserDetails: u, PolicyAcknowledged: true},
	})
	if err != nil {
		s.logf("error", "signup", "Registration was not accepted by the server")
		return nil, fmt.Errorf("registration failed: %w", err)
	}
	if err := s.tokens().Set(cfg.DeviceUUID, res.DeviceToken); err != nil {
		return nil, fmt.Errorf("registered, but the token could not be saved to the credential store: %w", err)
	}
	now := s.now()
	cfg.ServerURL = serverURL
	cfg.DeviceID = res.DeviceID
	cfg.RegisteredAt = now.Format(time.RFC3339)
	cfg.User = &u
	if err := cfg.Save(); err != nil {
		return nil, err
	}
	s.logf("info", "signup", "Registered this computer")
	out := &Registered{Hostname: sc.System.Hostname, DeviceID: res.DeviceID}
	if in.UploadFirstScan {
		out.ScanID, _, out.UploadErr = s.uploadAndRecord(ctx, cfg, res.DeviceToken, "manual", strings.TrimSpace(in.PIN), collectedAt, sc)
	}
	return out, nil
}

// UploadOptions tunes Upload.
type UploadOptions struct {
	ScanType string
	// PIN is the hourly IT PIN; the server requires it for manual scans.
	PIN string
	// ServerURL overrides the registered server for this upload only (nothing is saved).
	ServerURL string
}

// Upload sends an already-collected scan using the saved registration.
func (s *Service) Upload(ctx context.Context, sc *payload.Scan, collectedAt time.Time, opt UploadOptions) (scanID string, duplicate bool, err error) {
	cfg, err := config.Load()
	if err != nil {
		return "", false, err
	}
	if cfg.DeviceUUID == "" || cfg.ServerURL == "" {
		return "", false, ErrNotRegistered
	}
	serverURL := cfg.ServerURL
	if opt.ServerURL != "" {
		if serverURL, err = NormalizeServerURL(opt.ServerURL); err != nil {
			return "", false, err
		}
	}
	token, err := s.tokens().Get(cfg.DeviceUUID)
	if err != nil {
		return "", false, err
	}
	scanType := opt.ScanType
	if scanType == "" {
		scanType = "manual"
	}
	id, dup, err := s.client(serverURL).UploadScan(ctx, token, scanRequest(scanType, opt.PIN, collectedAt, sc))
	if err != nil {
		s.logf("error", "sync", "Scan upload failed")
		return "", false, fmt.Errorf("upload failed: %w", err)
	}
	s.logf("info", "sync", "Scan uploaded (%s)", scanType)
	if opt.ServerURL == "" {
		cfg.RecordReport(s.now(), sc)
		if err := cfg.Save(); err != nil {
			return id, dup, err
		}
	}
	return id, dup, nil
}

// Report scans this computer and uploads the result. A manual report ("Report now") needs the
// current IT PIN; dashboard-requested (on_demand) ones pass "".
func (s *Service) Report(ctx context.Context, scanType, pin string) (scanID string, duplicate bool, sc *payload.Scan, err error) {
	collectedAt := s.now()
	sc, err = s.Collect(ctx, "")
	if err != nil {
		s.logf("error", "scan", "Scan failed")
		return "", false, nil, err
	}
	s.logf("info", "scan", "Scan completed")
	scanID, duplicate, err = s.Upload(ctx, sc, collectedAt, UploadOptions{ScanType: scanType, PIN: pin})
	return scanID, duplicate, sc, err
}

// UpdateUser sends corrected details. A different employee ID hands the computer to that
// person on the server. The server needs the current IT PIN. The stored details are saved locally.
func (s *Service) UpdateUser(ctx context.Context, u payload.UserDetails, pin string) (*payload.UserDetails, error) {
	return s.saveUser(func(c *api.Client, token string) (*payload.UserDetails, error) {
		return c.UpdateUser(ctx, token, trimUser(u), strings.TrimSpace(pin))
	})
}

// ConfirmUser saves the details with the approval code of IT's "confirm details" request instead of
// the PIN. The server accepts it once, within 24 hours, and only with the same employee ID.
func (s *Service) ConfirmUser(ctx context.Context, u payload.UserDetails, confirm payload.ConfirmApproval) (*payload.UserDetails, error) {
	return s.saveUser(func(c *api.Client, token string) (*payload.UserDetails, error) {
		return c.ConfirmUser(ctx, token, trimUser(u), confirm)
	})
}

func (s *Service) saveUser(send func(*api.Client, string) (*payload.UserDetails, error)) (*payload.UserDetails, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if cfg.DeviceUUID == "" || cfg.ServerURL == "" {
		return nil, ErrNotRegistered
	}
	token, err := s.tokens().Get(cfg.DeviceUUID)
	if err != nil {
		return nil, err
	}
	stored, err := send(s.client(cfg.ServerURL), token)
	if err != nil {
		s.logf("error", "update", "Updating details failed")
		return nil, err
	}
	s.logf("info", "update", "Details updated")
	cfg.User = stored
	if err := cfg.Save(); err != nil {
		return nil, err
	}
	return stored, nil
}

// CheckConnection tests that a server address answers (no key is checked or stored).
func (s *Service) CheckConnection(ctx context.Context, serverURL string) (string, error) {
	u, err := NormalizeServerURL(serverURL)
	if err != nil {
		return "", err
	}
	return u, s.client(u).Ping(ctx)
}

// Status is the saved registration, for display.
type Status struct {
	Dir          string
	Registered   bool
	ServerURL    string
	DeviceID     string
	DeviceUUID   string
	RegisteredAt string
	LastReportAt string
	User         *payload.UserDetails
	LastPayload  *payload.Scan
	// TokenErr is non-nil when the registration has no usable token stored.
	TokenErr error
	// EnrollmentKeyHash is the stored hash of the enrollment key, nil until IT setup or re-registration
	// saves it (CLI-registered computers have none). It unlocks Settings while the server is unreachable.
	EnrollmentKeyHash *config.SecretHash
}

// Status reads config.json and checks that the token is present.
func (s *Service) Status() (*Status, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	dir, _ := config.Dir()
	st := &Status{Dir: dir, Registered: cfg.DeviceID != "", EnrollmentKeyHash: cfg.EnrollmentKeyHash}
	if !st.Registered {
		return st, nil
	}
	st.ServerURL, st.DeviceID, st.DeviceUUID, st.RegisteredAt = cfg.ServerURL, cfg.DeviceID, cfg.DeviceUUID, cfg.RegisteredAt
	st.LastReportAt, st.User, st.LastPayload = cfg.LastReportAt, cfg.User, cfg.LastPayload
	_, st.TokenErr = s.tokens().Get(cfg.DeviceUUID)
	return st, nil
}

// SetEnrollmentKeyHash stores the hash of the enrollment key (nil is not allowed).
func (s *Service) SetEnrollmentKeyHash(h *config.SecretHash) error {
	if h == nil {
		return errors.New("no enrollment key hash given")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	cfg.EnrollmentKeyHash = h
	return cfg.Save()
}

// UnlockSettings asks the server whether pin is the current IT PIN (see api.Client.UnlockSettings for the
// errors). A computer with no usable registration cannot ask: that error is returned as is.
func (s *Service) UnlockSettings(ctx context.Context, pin string) error {
	client, token, err := s.APIClient()
	if err != nil {
		return err
	}
	return client.UnlockSettings(ctx, token, pin)
}

// LogEvent records an entry in the local log (uploaded with the next "Send logs"). Messages must never
// carry tokens, PINs, keys or personal details.
func (s *Service) LogEvent(level, category, message string) { s.logf(level, category, "%s", message) }

// SetServerURL saves a new server address for an already-registered computer. It does not
// contact the server; callers check the connection first.
func (s *Service) SetServerURL(serverURL string) error {
	u, err := NormalizeServerURL(serverURL)
	if err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.DeviceID == "" {
		return ErrNotRegistered
	}
	cfg.ServerURL = u
	return cfg.Save()
}

func (s *Service) uploadAndRecord(ctx context.Context, cfg *config.Config, token, scanType, pin string, collectedAt time.Time, sc *payload.Scan) (string, bool, error) {
	id, dup, err := s.client(cfg.ServerURL).UploadScan(ctx, token, scanRequest(scanType, pin, collectedAt, sc))
	if err != nil {
		return "", false, fmt.Errorf("upload failed: %w", err)
	}
	cfg.RecordReport(s.now(), sc)
	return id, dup, cfg.Save()
}

func scanRequest(scanType, pin string, collectedAt time.Time, sc *payload.Scan) payload.ScanRequest {
	req := payload.ScanRequest{
		ScanUUID:    config.NewUUID(),
		ScanType:    scanType,
		CollectedAt: collectedAt.Format(time.RFC3339Nano),
		Payload:     sc,
	}
	if scanType == "manual" {
		req.ITPIN = strings.TrimSpace(pin) // only manual scans carry the PIN
	}
	return req
}

func trimUser(u payload.UserDetails) payload.UserDetails {
	return payload.UserDetails{
		FullName:   strings.TrimSpace(u.FullName),
		EmployeeID: strings.TrimSpace(u.EmployeeID),
		Email:      rd.StrPtr(rd.Deref(u.Email)),
		Department: strings.TrimSpace(u.Department),
		Position:   rd.StrPtr(rd.Deref(u.Position)),
		Phone:      rd.StrPtr(rd.Deref(u.Phone)),
	}
}

// CachedBranding is the agency name and logo saved by the last successful RefreshBranding, or nil.
func (s *Service) CachedBranding() *config.Branding {
	cfg, err := config.Load()
	if err != nil {
		return nil
	}
	return cfg.Branding
}

// RefreshBranding asks the server (serverURL, or the registered server when empty) for its agency name
// and logo and saves them in config.json, so the window can show them on an offline start. The logo is
// downloaded only when its versioned address changed. On any failure the saved branding stays as it was.
func (s *Service) RefreshBranding(ctx context.Context, serverURL string) (*config.Branding, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if serverURL == "" {
		serverURL = cfg.ServerURL
	}
	if serverURL == "" {
		return cfg.Branding, ErrNotRegistered
	}
	client := s.client(serverURL)
	got, err := client.Branding(ctx)
	if err != nil {
		return cfg.Branding, err
	}
	next := &config.Branding{Name: strings.TrimSpace(got.Name)}
	if got.LogoURL != nil && *got.LogoURL != "" {
		next.LogoURL = *got.LogoURL
		if old := cfg.Branding; old != nil && old.LogoURL == next.LogoURL && old.Logo != "" {
			next.Logo = old.Logo
		} else if next.Logo, err = client.BrandingLogo(ctx, next.LogoURL); err != nil {
			// A broken logo must not hide the name: keep the name, drop the logo.
			s.logf("warning", "system", "The agency logo could not be fetched")
			next.LogoURL, next.Logo = "", ""
		}
	}
	// Load again: other parts of the app may have saved config.json while the server was answering.
	if cfg, err = config.Load(); err != nil {
		return next, err
	}
	cfg.Branding = next
	return next, cfg.Save()
}
