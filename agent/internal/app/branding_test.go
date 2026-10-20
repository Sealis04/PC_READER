package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/config"
)

// brandingServer answers /api/branding with name and logoPath (nil: no logo) and serves the logo.
type brandingServer struct {
	*httptest.Server
	name             atomic.Value // string
	logoPath         atomic.Value // string; "" means no logo
	down             atomic.Bool
	brandingN, logoN atomic.Int32
	logoStatus       atomic.Int32
}

func newBrandingServer(t *testing.T, name, logoPath string) *brandingServer {
	t.Helper()
	b := &brandingServer{}
	b.name.Store(name)
	b.logoPath.Store(logoPath)
	b.logoStatus.Store(200)
	b.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if b.down.Load() {
			w.WriteHeader(503)
			return
		}
		switch r.URL.Path {
		case "/api/branding":
			b.brandingN.Add(1)
			w.Header().Set("Content-Type", "application/json")
			logo := "null"
			if p := b.logoPath.Load().(string); p != "" {
				logo = `"` + p + `"`
			}
			_, _ = w.Write([]byte(`{"name":"` + b.name.Load().(string) + `","logo_url":` + logo + `}`))
		case "/api/branding/logo":
			b.logoN.Add(1)
			if s := int(b.logoStatus.Load()); s != 200 {
				w.WriteHeader(s)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(b.Close)
	return b
}

func brandingService(t *testing.T) *Service {
	t.Helper()
	t.Setenv("PCREADER_HOME", t.TempDir())
	t.Setenv("PCREADER_TOKEN_STORE", "file")
	return &Service{Version: "test"}
}

func TestRefreshBrandingSavesNameAndLogoForOfflineStarts(t *testing.T) {
	s := brandingService(t)
	srv := newBrandingServer(t, "Sample Agency", "/api/branding/logo?v=1")
	b, err := s.RefreshBranding(context.Background(), srv.URL)
	if err != nil || b.Name != "Sample Agency" || b.Logo == "" || b.LogoURL != "/api/branding/logo?v=1" {
		t.Fatalf("got %+v %v", b, err)
	}
	// The server goes away: the saved name and logo are still there.
	srv.down.Store(true)
	cached := s.CachedBranding()
	if cached == nil || cached.Name != "Sample Agency" || cached.Logo != b.Logo {
		t.Fatalf("cache lost: %+v", cached)
	}
	got, err := s.RefreshBranding(context.Background(), srv.URL)
	if err == nil || got == nil || got.Name != "Sample Agency" || got.Logo != b.Logo {
		t.Fatalf("an offline refresh must keep the saved branding: %+v %v", got, err)
	}
}

func TestRefreshBrandingDownloadsTheLogoOnlyWhenItsVersionChanged(t *testing.T) {
	s := brandingService(t)
	srv := newBrandingServer(t, "A", "/api/branding/logo?v=1")
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := s.RefreshBranding(ctx, srv.URL); err != nil {
			t.Fatal(err)
		}
	}
	if srv.logoN.Load() != 1 || srv.brandingN.Load() != 3 {
		t.Fatalf("logo fetched %d times, branding %d", srv.logoN.Load(), srv.brandingN.Load())
	}
	srv.logoPath.Store("/api/branding/logo?v=2")
	if _, err := s.RefreshBranding(ctx, srv.URL); err != nil || srv.logoN.Load() != 2 {
		t.Fatalf("a new version must be fetched: %v (%d)", err, srv.logoN.Load())
	}
}

func TestRefreshBrandingFollowsNameChangesAndLogoRemoval(t *testing.T) {
	s := brandingService(t)
	srv := newBrandingServer(t, "Old Name", "/api/branding/logo?v=1")
	ctx := context.Background()
	if _, err := s.RefreshBranding(ctx, srv.URL); err != nil {
		t.Fatal(err)
	}
	srv.name.Store("New Name")
	srv.logoPath.Store("")
	b, err := s.RefreshBranding(ctx, srv.URL)
	if err != nil || b.Name != "New Name" || b.Logo != "" || b.LogoURL != "" {
		t.Fatalf("got %+v %v", b, err)
	}
	if c := s.CachedBranding(); c == nil || c.Name != "New Name" || c.Logo != "" {
		t.Fatalf("saved %+v", c)
	}
}

func TestRefreshBrandingKeepsTheNameWhenTheLogoCannotBeFetched(t *testing.T) {
	s := brandingService(t)
	srv := newBrandingServer(t, "Sample Agency", "/api/branding/logo?v=1")
	srv.logoStatus.Store(500)
	b, err := s.RefreshBranding(context.Background(), srv.URL)
	if err != nil || b.Name != "Sample Agency" || b.Logo != "" {
		t.Fatalf("got %+v %v", b, err)
	}
	// Next time (the logo is back) it is fetched, because nothing was saved for that version.
	srv.logoStatus.Store(200)
	if b, err = s.RefreshBranding(context.Background(), srv.URL); err != nil || b.Logo == "" {
		t.Fatalf("got %+v %v", b, err)
	}
}

func TestRefreshBrandingUsesTheRegisteredServerAndKeepsOtherSettings(t *testing.T) {
	s := brandingService(t)
	srv := newBrandingServer(t, "Sample Agency", "")
	cfg := &config.Config{ServerURL: srv.URL, DeviceID: "dev-1", DeviceUUID: "uuid-1", LastReportAt: "2026-10-20T00:00:00Z"}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RefreshBranding(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	got, _ := config.Load()
	if got.DeviceID != "dev-1" || got.LastReportAt == "" || got.Branding == nil || got.Branding.Name != "Sample Agency" {
		t.Fatalf("config after refresh: %+v", got)
	}
}

func TestRefreshBrandingWithoutAnAddressIsNotRegistered(t *testing.T) {
	s := brandingService(t)
	if _, err := s.RefreshBranding(context.Background(), ""); !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("got %v", err)
	}
	if s.CachedBranding() != nil {
		t.Fatal("nothing should be cached")
	}
}
