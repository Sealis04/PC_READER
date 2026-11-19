package background

import (
	"fmt"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/config"
)

const moveID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

func TestServerMoveSwitchesAndReconnectsToTheNewAddress(t *testing.T) {
	g := startRig(t)
	g.waitStatus(t, StatusConnected)
	next := newFake(t)
	next.meID = "dev-1"
	g.f.push <- fmt.Sprintf("event: server_moved\ndata: {\"move_id\":%q,\"url\":%q}\n\n", moveID, next.URL+"/")
	waitFor(t, "a stream on the new server", func() bool { return next.streams.Load() > 0 })
	cfg, _ := config.Load()
	if cfg.ServerURL != next.URL {
		t.Fatalf("server url = %q", cfg.ServerURL)
	}
	g.f.mu.Lock()
	moves := g.f.moves
	g.f.mu.Unlock()
	if len(moves) != 1 || !moves[0].Moved || moves[0].MoveID != moveID {
		t.Fatalf("old server got %+v", moves)
	}
	// Stop the runner before the new server closes (its open stream would hold Close up).
	g.cancel()
	<-g.done
}

func TestServerMoveToAnAddressThatDoesNotKnowThePCStays(t *testing.T) {
	g := startRig(t)
	g.waitStatus(t, StatusConnected)
	next := newFake(t) // meID "": answers 401
	g.f.push <- fmt.Sprintf("event: server_moved\ndata: {\"move_id\":%q,\"url\":%q}\n\n", moveID, next.URL)
	waitFor(t, "the move result", func() bool { g.f.mu.Lock(); defer g.f.mu.Unlock(); return len(g.f.moves) == 1 })
	if m := g.f.moves[0]; m.Moved || m.Reason != "unknown_device" {
		t.Fatalf("result %+v", m)
	}
	if cfg, _ := config.Load(); cfg.ServerURL != g.f.URL {
		t.Fatalf("moved anyway to %q", cfg.ServerURL)
	}
	if next.streams.Load() != 0 {
		t.Fatal("connected to the new address")
	}
}
