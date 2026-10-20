package bound

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/app"
)

const logoPNG = "\x89PNG\r\n\x1a\n"

func brandingApp(t *testing.T, srv *httptest.Server) *App {
	t.Helper()
	svc := app.New("test")
	svc.NewClient = func(u string) *api.Client {
		c := api.New(u)
		c.Backoff = nil
		return c
	}
	return New(svc, "test")
}

func brandingServer(t *testing.T, name string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/devices":
			_, _ = w.Write([]byte("<html>"))
		case "/api/branding":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"name":"` + name + `","logo_url":"/api/branding/logo?v=7"}`))
		case "/api/branding/logo":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte(logoPNG))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestBrandingDefaultsToPCReaderUntilAServerAnswered(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	a := brandingApp(t, nil)
	if got := a.Branding(); got.Name != "PC_READER" || got.Logo != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestSetupShowsTheServersBrandingAndAnOfflineStartKeepsIt(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	srv := brandingServer(t, "Sample Agency")
	a := brandingApp(t, srv)
	if res := a.CheckConnection(srv.URL, "key"); !res.OK {
		t.Fatalf("connection: %+v", res)
	}
	got := a.Branding()
	if got.Name != "Sample Agency" || got.Logo != "data:image/png;base64,iVBORw0KGgo=" {
		t.Fatalf("got %+v", got)
	}

	// Next launch with the server gone: the window still draws the saved name and logo, and a failed refresh
	// returns them rather than the default.
	srv.Close()
	again := brandingApp(t, srv)
	if got := again.Branding(); got.Name != "Sample Agency" || got.Logo == "" {
		t.Fatalf("offline start lost the branding: %+v", got)
	}
	if got := again.RefreshBranding(); got.Name != "Sample Agency" || got.Logo == "" {
		t.Fatalf("offline refresh lost the branding: %+v", got)
	}
}

func TestRefreshBrandingPicksUpAChangeOnTheServer(t *testing.T) {
	t.Setenv("PCREADER_HOME", t.TempDir())
	first := brandingServer(t, "Old Name")
	a := brandingApp(t, first)
	if res := a.CheckConnection(first.URL, "key"); !res.OK {
		t.Fatalf("connection: %+v", res)
	}
	// IT renames the agency; the same address now answers with the new name.
	second := brandingServer(t, "New Name")
	if b := a.refreshBranding(second.URL); b.Name != "New Name" {
		t.Fatalf("got %+v", b)
	}
	if a.Branding().Name != "New Name" {
		t.Fatal("the new name was not saved")
	}
}
