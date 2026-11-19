package app

import (
	"context"
	"fmt"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

// MissedUpdateAfter is how long a PC may go without reaching its server before the desktop app says it
// missed a security update (the recovery key rotates every 30 days on the server).
const MissedUpdateAfter = 30 * 24 * time.Hour

// MissedUpdateNotice is the home screen banner after MissedUpdateAfter without server contact.
const MissedUpdateNotice = "This computer missed a security update. Connect to the office network."

// ApplyRecoveryKey saves the recovery key hash the server pushed (replacing the stored enrollment key
// hash) with its version and acknowledges it. The server never sends the key itself.
func (s *Service) ApplyRecoveryKey(ctx context.Context, rk payload.RecoveryKey) error {
	h, err := config.ParseSecretHash(rk.Hash)
	if err != nil {
		s.logf("warning", "system", "Ignored an unreadable recovery key update")
		return err
	}
	if rk.Version < 1 {
		return fmt.Errorf("invalid recovery key version %d", rk.Version)
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.DeviceID == "" {
		return ErrNotRegistered
	}
	cfg.EnrollmentKeyHash = h
	cfg.RecoveryKeyVersion = rk.Version
	if err := cfg.Save(); err != nil {
		return err
	}
	s.logf("info", "system", "Recovery key updated to version %d", rk.Version)
	client, token, err := s.APIClient()
	if err != nil {
		return err
	}
	if err := client.AckRecoveryKey(ctx, token, rk.Version); err != nil {
		s.logf("warning", "sync", "Could not confirm the recovery key update to the server")
		return err
	}
	return nil
}

// RecordContact notes that the server answered now (the events stream opened or ended after being open,
// a scan was accepted, the PC registered).
func (s *Service) RecordContact() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.DeviceID == "" {
		return nil
	}
	cfg.LastServerContactAt = s.now().Format(time.RFC3339)
	return cfg.Save()
}

// MissedUpdate reports whether the PC has not reached its server for over MissedUpdateAfter, decided on
// the PC alone. Without a recorded contact the registration time counts.
func (st *Status) MissedUpdate(now time.Time) bool {
	if !st.Registered {
		return false
	}
	last := st.LastServerContactAt
	if last == "" {
		last = st.RegisteredAt
	}
	t, err := time.Parse(time.RFC3339, last)
	if err != nil {
		return false
	}
	return now.Sub(t) > MissedUpdateAfter
}
