package bound

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

type fake struct {
	*httptest.Server
	unauthorized bool
	registerBody string // overrides the register reply (status 400) when set
	registerCode int
	updates      []payload.UserDetails
}

func setup(t *testing.T) (*App, *fake) {
	t.Helper()
	t.Setenv("PCREADER_HOME", t.TempDir())
	t.Setenv("PCREADER_TOKEN_STORE", "file")
	f := &fake{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/devices":
			_, _ = w.Write([]byte("<html>"))
		case r.URL.Path == "/api/agent/register":
			var req payload.RegisterRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			if f.registerCode != 0 {
				w.WriteHeader(f.registerCode)
				_, _ = w.Write([]byte(f.registerBody))
			} else if req.EnrollmentKey != "good-key" {
				w.WriteHeader(403)
				_, _ = w.Write([]byte(`{"error":"invalid_enrollment_key","message":"Enrollment key is not valid"}`))
			} else {
				w.WriteHeader(201)
				_, _ = w.Write([]byte(`{"device_id":"dev-1","device_token":"tok-1","checkin_interval_seconds":300}`))
			}
		case f.unauthorized:
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		case r.URL.Path == "/api/agent/scans":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"scan_id":"scan-1"}`))
		case r.URL.Path == "/api/agent/user":
			var u payload.UserDetails
			_ = json.NewDecoder(r.Body).Decode(&u)
			f.updates = append(f.updates, u)
			_ = json.NewEncoder(w).Encode(u)
		}
	}))
	t.Cleanup(f.Close)
	svc := app.New("test")
	svc.Scan = func(context.Context) (rd.Set, error) { return rd.Load(contract.Fixture("raw/windows")) }
	svc.NewClient = func(u string) *api.Client {
		c := api.New(u)
		c.Backoff = nil
		return c
	}
	return New(svc, "test"), f
}

func form() UserForm {
	return UserForm{FullName: "Juan Dela Cruz", EmployeeID: "EMP-1", Department: "Finance", Position: "Clerk", PolicyAccepted: true}
}

func register(t *testing.T, a *App, f *fake) {
	t.Helper()
	if res := a.CheckConnection(f.URL, "good-key"); !res.OK {
		t.Fatalf("connection: %+v", res)
	}
	if res := a.Signup(form()); !res.OK {
		t.Fatalf("signup: %+v", res)
	}
}

func TestFirstLaunchFlowSetupSignupHome(t *testing.T) {
	a, f := setup(t)
	if st := a.State(); st.Screen != "setup" || st.Notice == "" {
		t.Fatalf("state %+v", st)
	}
	if res := a.CheckConnection(f.URL, "  "); res.OK || res.FieldErrors["key"] == "" {
		t.Fatalf("empty key accepted: %+v", res)
	}
	if res := a.CheckConnection("not a url", "k"); res.OK || res.FieldErrors["serverUrl"] == "" {
		t.Fatalf("bad url accepted: %+v", res)
	}
	if res := a.CheckConnection(f.URL, "good-key"); !res.OK {
		t.Fatalf("connection: %+v", res)
	}
	if st := a.State(); st.Screen != "signup" || st.ServerURL != f.URL {
		t.Fatalf("state %+v", st)
	}
	res := a.Signup(form())
	if !res.OK || !strings.Contains(res.Message, "Registered") {
		t.Fatalf("signup: %+v", res)
	}
	if st := a.State(); st.Screen != "home" {
		t.Fatalf("state %+v", st)
	}
	// The enrollment key was only in memory.
	cfg, _ := config.Load()
	if raw, _ := json.Marshal(cfg); strings.Contains(string(raw), "good-key") {
		t.Fatal("enrollment key written to config")
	}
	if a.pendingKey != "" {
		t.Fatal("enrollment key kept in memory after signup")
	}

	h := a.MyComputer()
	if !h.OK || !h.Reported || h.LastReportAt == "Never" || h.AssignedUser == nil || h.AssignedUser.EmployeeID != "EMP-1" {
		t.Fatalf("home %+v", h)
	}
	if h.Summary.ComputerName == "" || h.Summary.Memory == "—" || len(h.Summary.Disks) == 0 || len(h.Sections) < 5 {
		t.Fatalf("summary %+v, %d sections", h.Summary, len(h.Sections))
	}
}

func TestSignupValidatesBeforeContactingServer(t *testing.T) {
	a, f := setup(t)
	a.CheckConnection(f.URL, "good-key")
	res := a.Signup(UserForm{Email: "nope"})
	for _, k := range []string{"fullName", "employeeId", "department", "email", "policyAccepted"} {
		if res.FieldErrors[k] == "" {
			t.Errorf("no error for %s: %+v", k, res.FieldErrors)
		}
	}
	if res.OK || a.State().Screen == "home" {
		t.Fatal("registered with an invalid form")
	}
}

func TestSignupNeedsSetupFirst(t *testing.T) {
	a, _ := setup(t)
	if res := a.Signup(form()); res.OK || !strings.Contains(res.Message, "IT setup") {
		t.Fatalf("%+v", res)
	}
}

func TestSignupWrongKeyAndUnreachableServerSpeakPlainly(t *testing.T) {
	a, f := setup(t)
	a.CheckConnection(f.URL, "wrong")
	if res := a.Signup(form()); res.OK || !strings.Contains(res.Message, "enrollment key is not correct") {
		t.Fatalf("%+v", res)
	}
	if a.State().Screen != "signup" {
		t.Fatal("left signup after a wrong key")
	}
	f.Close()
	if res := a.CheckConnection(f.URL, "k"); res.OK || !strings.Contains(res.Message, "Cannot reach the server at "+f.URL) || !strings.Contains(res.Message, "docker compose up -d") {
		t.Fatalf("%+v", res)
	}
}

func TestSignupMapsServerFieldErrors(t *testing.T) {
	a, f := setup(t)
	f.registerCode, f.registerBody = 400, `{"error":"invalid_payload","message":"bad","details":[{"path":"/user/email","message":"must match format \"email\""}]}`
	a.CheckConnection(f.URL, "good-key")
	res := a.Signup(form())
	if res.OK || res.FieldErrors["email"] == "" {
		t.Fatalf("%+v", res)
	}
}

func TestReportNowUpdatesTimeAndHandlesRejectedToken(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	res := a.ReportNow()
	if !res.OK || !strings.Contains(res.Message, "specs were sent") || res.Home.LastReportAt == "Never" {
		t.Fatalf("%+v", res)
	}
	f.unauthorized = true
	res = a.ReportNow()
	if res.OK || !res.NeedsReregistration || !strings.Contains(res.Message, "register again") {
		t.Fatalf("%+v", res)
	}
}

func TestUpdateUserSavesAndValidates(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	bad := form()
	bad.Department = ""
	if res := a.UpdateUser(bad); res.OK || res.FieldErrors["department"] == "" || len(f.updates) != 0 {
		t.Fatalf("%+v", res)
	}
	upd := form()
	upd.Department, upd.Phone = "Budget", "0917 000 0000"
	if res := a.UpdateUser(upd); !res.OK {
		t.Fatalf("%+v", res)
	}
	if len(f.updates) != 1 || f.updates[0].Department != "Budget" || f.updates[0].Email != nil || *f.updates[0].Phone != "0917 000 0000" {
		t.Fatalf("sent %+v", f.updates)
	}
	if h := a.MyComputer(); h.AssignedUser.Department != "Budget" {
		t.Fatalf("home shows %+v", h.AssignedUser)
	}
	f.unauthorized = true
	if res := a.UpdateUser(upd); res.OK || !res.NeedsReregistration {
		t.Fatalf("%+v", res)
	}
}

func TestReregistrationKeepsDetailsAsPrefill(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	st := a.StartReregistration()
	if st.Screen != "setup" || st.User == nil || st.User.EmployeeID != "EMP-1" || st.ServerURL != f.URL {
		t.Fatalf("%+v", st)
	}
	a.CheckConnection(f.URL, "good-key")
	if a.State().Screen != "signup" {
		t.Fatal("not on signup")
	}
	if res := a.Signup(form()); !res.OK {
		t.Fatalf("%+v", res)
	}
	if a.State().Screen != "home" {
		t.Fatal("not home after re-registering")
	}
}

func TestMachineRegisteredByCLIOpensHomeWithLocalScan(t *testing.T) {
	a, f := setup(t)
	if _, err := a.svc.Register(context.Background(), app.RegisterInput{ServerURL: f.URL, Key: "good-key", User: payload.UserDetails{FullName: "A", EmployeeID: "E", Department: "D"}}); err != nil {
		t.Fatal(err)
	}
	if a.State().Screen != "home" {
		t.Fatal("registered machine did not open to home")
	}
	h := a.MyComputer()
	if !h.OK || h.Reported || h.LastReportAt != "Never" || h.Summary.ComputerName == "" {
		t.Fatalf("%+v", h)
	}
}

func TestMissingTokenAsksToRegisterAgain(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	cfg, _ := config.Load()
	cfg.DeviceUUID = "00000000-0000-4000-8000-000000000000" // token store has nothing for this ID
	_ = cfg.Save()
	if h := a.MyComputer(); !h.NeedsReregistration {
		t.Fatalf("%+v", h)
	}
}

func TestFormatBytesAndSummary(t *testing.T) {
	for in, want := range map[int64]string{512: "512 B", 16 << 30: "16 GB", 476 << 30: "476 GB", 1536 << 20: "1.5 GB", 2 << 40: "2 TB"} {
		if got := formatBytes(in); got != want {
			t.Errorf("formatBytes(%d) = %q, want %q", in, got, want)
		}
	}
	sc, err := app.New("test").Collect(context.Background(), contract.Fixture("raw/macos"))
	if err != nil {
		t.Fatal(err)
	}
	s := summarize(sc)
	if s.CPU == "—" || s.OS == "—" || s.Model == "—" {
		t.Fatalf("mac summary %+v", s)
	}
}
