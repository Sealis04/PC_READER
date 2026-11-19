package app

import (
	"context"
	"errors"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

// MoveCheckTimeout bounds the check of a new server address during a server move.
var MoveCheckTimeout = 20 * time.Second

// FollowMove acts on IT's server move: it asks the new address which device this PC's token belongs to
// and switches only when the answer is this device. The outcome is reported to the current (old) server
// first. On a refusal the address stays as it is and reason says why (move-result reasons). Neither the
// token nor the address is logged.
func (s *Service) FollowMove(ctx context.Context, m payload.ServerMoved) (moved bool, reason string, err error) {
	cfg, err := config.Load()
	if err != nil {
		return false, "", err
	}
	if cfg.DeviceID == "" || cfg.ServerURL == "" {
		return false, "", ErrNotRegistered
	}
	token, err := s.tokens().Get(cfg.DeviceUUID)
	if err != nil {
		return false, "", err
	}
	old := s.client(cfg.ServerURL)
	refuse := func(why string) (bool, string, error) {
		s.logf("warning", "system", "Did not follow the server move (%s); keeping the current server address", why)
		if err := old.MoveResult(ctx, token, payload.MoveResult{MoveID: m.MoveID, Moved: false, Reason: why}); err != nil && ctx.Err() == nil {
			s.logf("warning", "sync", "Could not report the server move result")
		}
		return false, why, nil
	}

	newURL, err := NormalizeServerURL(m.URL)
	if err != nil {
		return refuse(payload.MoveInvalidURL)
	}
	if newURL != cfg.ServerURL {
		checkCtx, cancel := context.WithTimeout(ctx, MoveCheckTimeout)
		me, err := s.client(newURL).Me(checkCtx, token)
		cancel()
		switch {
		case errors.Is(err, api.ErrUnauthorized):
			return refuse(payload.MoveUnknownDevice)
		case err != nil:
			if ctx.Err() != nil {
				return false, "", ctx.Err()
			}
			return refuse(payload.MoveUnreachable)
		case me.DeviceID != cfg.DeviceID:
			return refuse(payload.MoveDifferentDevice)
		}
	}
	if err := old.MoveResult(ctx, token, payload.MoveResult{MoveID: m.MoveID, Moved: true}); err != nil && ctx.Err() == nil {
		// The new address knows this PC; switch anyway, the new server has the same records.
		s.logf("warning", "sync", "Could not report the server move result")
	}
	if newURL == cfg.ServerURL {
		return true, "", nil
	}
	if err := s.SetServerURL(newURL); err != nil {
		return false, "", err
	}
	_ = s.RecordContact()
	s.logf("info", "system", "Followed IT's server move to the new address")
	return true, "", nil
}
