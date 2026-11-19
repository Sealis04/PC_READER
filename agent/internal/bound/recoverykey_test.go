package bound

import (
	"strings"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/config"
)

func TestSetupHashesTheNormalizedKey(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	cfg, _ := config.Load()
	if !cfg.EnrollmentKeyHash.Verify("GOODKEY") {
		t.Fatal("the stored hash is not of the normalized key")
	}
}

func TestOfflineUnlockAcceptsAPushedKeyTypedLoosely(t *testing.T) {
	a, f := registeredWithPin(t)
	h, err := config.NewSecretHash(config.NormalizeRecoveryKey("K7QM-2XRP-9WDF-H4TN"))
	if err != nil {
		t.Fatal(err)
	}
	if err := a.svc.SetEnrollmentKeyHash(h); err != nil {
		t.Fatal(err)
	}
	f.unlockStatus = 503
	if res := a.UnlockITSettings(f.pin); res.Mode != "key" {
		t.Fatalf("%+v", res)
	}
	if res := a.UnlockITSettings("good-key"); res.OK {
		t.Fatal("the replaced key still unlocks")
	}
	if res := a.UnlockITSettings("k7qm 2xrp 9wdf h4tn"); !res.OK {
		t.Fatalf("%+v", res)
	}
}

func TestMissedUpdateNotice(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	if got := a.MissedUpdate(); got != "" {
		t.Fatalf("fresh registration: %q", got)
	}
	a.now = func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }
	if got := a.MissedUpdate(); !strings.Contains(got, "missed a security update") || got != app.MissedUpdateNotice {
		t.Fatalf("after 31 days: %q", got)
	}
	// While the connection is open the PC is in contact.
	a.SetConnection("connected", "Connected")
	if got := a.MissedUpdate(); got != "" {
		t.Fatalf("connected: %q", got)
	}
}
