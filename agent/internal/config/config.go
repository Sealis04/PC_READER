// Package config stores the agent's local settings and its device token.
package config

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/payload"
	"github.com/zalando/go-keyring"
)

const keyringService = "PCReader"

// Config is saved as config.json in Dir(). It holds no secrets, but it does hold the
// user's details and the last scan (for the desktop app); neither is ever logged.
type Config struct {
	ServerURL    string `json:"server_url"`
	DeviceUUID   string `json:"device_uuid"`
	DeviceID     string `json:"device_id"`
	RegisteredAt string `json:"registered_at"`
	// User is the person's details as last sent to the server.
	User *payload.UserDetails `json:"user,omitempty"`
	// LastReportAt is when the last scan was uploaded (RFC 3339, UTC); LastPayload is that scan.
	LastReportAt string        `json:"last_report_at,omitempty"`
	LastPayload  *payload.Scan `json:"last_payload,omitempty"`
}

// Dir is the app data folder: %AppData%\PCReader on Windows,
// ~/Library/Application Support/PCReader on macOS. PCREADER_HOME overrides it.
func Dir() (string, error) {
	if d := os.Getenv("PCREADER_HOME"); d != "" {
		return d, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "PCReader"), nil
}

func path() (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.json"), nil
}

// Load returns the saved config, or an empty one if none exists yet.
func Load() (*Config, error) {
	p, err := path()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return &Config{}, nil
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("%s is corrupt: %w", p, err)
	}
	return &c, nil
}

func (c *Config) Save() error {
	p, err := path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// RecordReport remembers a successfully uploaded scan (call Save afterwards).
func (c *Config) RecordReport(at time.Time, sc *payload.Scan) {
	c.LastReportAt = at.UTC().Format(time.RFC3339)
	c.LastPayload = sc
}

// EnsureDeviceUUID generates the install's device_uuid on first use.
func (c *Config) EnsureDeviceUUID() string {
	if c.DeviceUUID == "" {
		c.DeviceUUID = NewUUID()
	}
	return c.DeviceUUID
}

// NewUUID returns a random (version 4) UUID.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// TokenStore keeps the device token: the OS credential store (Windows Credential
// Manager, macOS Keychain) by default, or a 0600 file when PCREADER_TOKEN_STORE=file
// (for tests and machines without a credential store).
type TokenStore interface {
	Get(deviceUUID string) (string, error)
	Set(deviceUUID, token string) error
}

var ErrNoToken = errors.New("no device token stored; run `pcreader register` first")

func NewTokenStore() TokenStore {
	if strings.EqualFold(os.Getenv("PCREADER_TOKEN_STORE"), "file") {
		return fileStore{}
	}
	return keyringStore{}
}

type keyringStore struct{}

func (keyringStore) Get(id string) (string, error) {
	t, err := keyring.Get(keyringService, id)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNoToken
	}
	return t, err
}

func (keyringStore) Set(id, token string) error { return keyring.Set(keyringService, id, token) }

type fileStore struct{}

func (fileStore) file(id string) (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "token-"+id), nil
}

func (s fileStore) Get(id string) (string, error) {
	p, err := s.file(id)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", ErrNoToken
	}
	return strings.TrimSpace(string(b)), err
}

func (s fileStore) Set(id, token string) error {
	p, err := s.file(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(token), 0o600)
}
