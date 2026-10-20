package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

func TestBrandingMatchesTheContractAndSendsNoToken(t *testing.T) {
	c, calls := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/branding" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("the public endpoint must not get a token")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"Sample Agency","logo_url":"/api/branding/logo?v=1760000000000"}`))
	})
	b, err := c.Branding(context.Background())
	if err != nil || b.Name != "Sample Agency" || b.LogoURL == nil || *b.LogoURL != "/api/branding/logo?v=1760000000000" || *calls != 1 {
		t.Fatalf("got %+v %v (%d calls)", b, err, *calls)
	}
	if err := contract.Validate("branding", b); err != nil {
		t.Fatalf("the parsed branding does not match the contract: %v", err)
	}
}

func TestBrandingWithoutLogoAndTheSharedFixtures(t *testing.T) {
	c, _ := client(t, reply(200, `{"name":"PC_READER","logo_url":null}`))
	b, err := c.Branding(context.Background())
	if err != nil || b.LogoURL != nil {
		t.Fatalf("got %+v %v", b, err)
	}
	// The contract fixtures the server tests also check must decode into the Go type unchanged.
	for _, name := range []string{"default.json", "with-logo.json"} {
		raw, err := os.ReadFile(contract.Fixture("branding/" + name))
		if err != nil {
			t.Fatal(err)
		}
		var fx payload.Branding
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&fx); err != nil || fx.Name == "" {
			t.Fatalf("%s: %+v %v", name, fx, err)
		}
		if err := contract.Validate("branding", fx); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestBrandingDoesNotRetryAndRejectsAnEmptyName(t *testing.T) {
	c, calls := client(t, reply(500, `{"error":"server_error"}`))
	if _, err := c.Branding(context.Background()); err == nil || *calls != 1 {
		t.Fatalf("err %v calls %d: an offline start must not wait on retries", err, *calls)
	}
	c, _ = client(t, reply(200, `{"name":"  ","logo_url":null}`))
	if _, err := c.Branding(context.Background()); err == nil {
		t.Fatal("an empty name must be refused")
	}
}

func serveLogo(status int, typ string, body []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", typ)
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}
}

func TestBrandingLogoReturnsADataURL(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3}
	c, _ := client(t, serveLogo(200, "image/png", png))
	got, err := c.BrandingLogo(context.Background(), "/api/branding/logo?v=1")
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	if err != nil || got != want {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestBrandingLogoRefusesWhatTheServerWouldNotSend(t *testing.T) {
	ctx := context.Background()
	c, _ := client(t, serveLogo(200, "image/svg+xml", []byte("<svg/>")))
	if _, err := c.BrandingLogo(ctx, "/api/branding/logo?v=1"); err == nil {
		t.Fatal("SVG must be refused")
	}
	c, _ = client(t, serveLogo(200, "image/png", make([]byte, MaxLogoBytes+1)))
	if _, err := c.BrandingLogo(ctx, "/api/branding/logo?v=1"); err == nil {
		t.Fatal("an oversized logo must be refused")
	}
	c, _ = client(t, serveLogo(404, "application/json", []byte(`{}`)))
	if _, err := c.BrandingLogo(ctx, "/api/branding/logo?v=1"); err == nil {
		t.Fatal("a 404 must be an error")
	}
	for _, path := range []string{"/devices", "http://evil.example/x.png", "//evil.example/x.png"} {
		if _, err := c.BrandingLogo(ctx, path); err == nil || !strings.Contains(err.Error(), "unexpected logo address") {
			t.Fatalf("%q must be refused, got %v", path, err)
		}
	}
}
