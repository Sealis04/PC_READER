package bound

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// testPin is the IT PIN the fake server accepts (fake.pin starts with it).
const testPin = "482913"

type fake struct {
	*httptest.Server
	unauthorized bool
	registerBody string // overrides the register reply (status 400) when set
	registerCode int
	updates      []payload.UserDetails
	scans        []payload.ScanRequest
	userCalls    int
	pin          string // the current IT PIN the fake server accepts
	unlockStatus int    // overrides the settings-unlock reply (e.g. 500) when set
	unlockCalls  int
}

func setup(t *testing.T) (*App, *fake) {
	t.Helper()
	t.Setenv("PCREADER_HOME", t.TempDir())
	t.Setenv("PCREADER_TOKEN_STORE", "file")
	config.HashIterations = 1000 // fast hashing in tests
	t.Cleanup(func() { config.HashIterations = 600_000 })
	f := &fake{pin: testPin}
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
			} else if req.ITPIN != f.pin {
				w.WriteHeader(403)
				_, _ = w.Write([]byte(`{"error":"wrong_pin","message":"That PIN is not the current IT PIN"}`))
			} else {
				w.WriteHeader(201)
				_, _ = w.Write([]byte(`{"device_id":"dev-1","device_token":"tok-1","checkin_interval_seconds":300}`))
			}
		case r.URL.Path == "/api/agent/settings-unlock" && !f.unauthorized:
			f.unlockCalls++
			var req payload.SettingsUnlockRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			switch {
			case f.unlockStatus != 0:
				w.WriteHeader(f.unlockStatus)
				_, _ = w.Write([]byte(`{"error":"server_error"}`))
			case req.PIN == f.pin:
				_, _ = w.Write([]byte(`{"ok":true}`))
			default:
				w.WriteHeader(403)
				_, _ = w.Write([]byte(`{"error":"wrong_pin","message":"That PIN is not the current IT PIN"}`))
			}
		case f.unauthorized:
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		case r.URL.Path == "/api/agent/scans":
			var req payload.ScanRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			f.scans = append(f.scans, req)
			if req.ScanType == "manual" && req.ITPIN != f.pin {
				w.WriteHeader(403)
				_, _ = w.Write([]byte(`{"error":"wrong_pin","message":"Manual scans need the current IT PIN"}`))
				return
			}
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"scan_id":"scan-1"}`))
		case r.URL.Path == "/api/agent/user":
			var u payload.UserRequest
			_ = json.NewDecoder(r.Body).Decode(&u)
			f.userCalls++
			if u.ITPIN != f.pin {
				w.WriteHeader(403)
				_, _ = w.Write([]byte(`{"error":"wrong_pin","message":"That PIN is not the current IT PIN"}`))
				return
			}
			f.updates = append(f.updates, u.UserDetails)
			_ = json.NewEncoder(w).Encode(u.UserDetails)
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
	if res := a.Signup(form(), testPin); !res.OK {
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
	res := a.Signup(form(), testPin)
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
	res := a.Signup(UserForm{Email: "nope"}, testPin)
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
	if res := a.Signup(form(), testPin); res.OK || !strings.Contains(res.Message, "IT setup") {
		t.Fatalf("%+v", res)
	}
}

func TestSignupWrongKeyAndUnreachableServerSpeakPlainly(t *testing.T) {
	a, f := setup(t)
	a.CheckConnection(f.URL, "wrong")
	if res := a.Signup(form(), testPin); res.OK || !strings.Contains(res.Message, "enrollment key is not correct") {
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
	res := a.Signup(form(), testPin)
	if res.OK || res.FieldErrors["email"] == "" {
		t.Fatalf("%+v", res)
	}
}

func TestReportNowUpdatesTimeAndHandlesRejectedToken(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	if res := a.UnlockITSettings(testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
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
	if res := a.UpdateUser(bad, testPin); res.OK || res.FieldErrors["department"] == "" || len(f.updates) != 0 {
		t.Fatalf("%+v", res)
	}
	upd := form()
	upd.Department, upd.Phone = "Budget", "0917 000 0000"
	if res := a.UpdateUser(upd, testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
	if len(f.updates) != 1 || f.updates[0].Department != "Budget" || f.updates[0].Email != nil || *f.updates[0].Phone != "0917 000 0000" {
		t.Fatalf("sent %+v", f.updates)
	}
	if h := a.MyComputer(); h.AssignedUser.Department != "Budget" {
		t.Fatalf("home shows %+v", h.AssignedUser)
	}
	f.unauthorized = true
	if res := a.UpdateUser(upd, testPin); res.OK || !res.NeedsReregistration {
		t.Fatalf("%+v", res)
	}
}

func TestReregistrationKeepsDetailsAsPrefill(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	if st := a.StartReregistration(); st.Screen != "home" {
		t.Fatalf("re-registration opened without unlocking Settings: %+v", st)
	}
	if res := a.UnlockITSettings(f.pin); !res.OK {
		t.Fatalf("%+v", res)
	}
	st := a.StartReregistration()
	if st.Screen != "setup" || st.User == nil || st.User.EmployeeID != "EMP-1" || st.ServerURL != f.URL {
		t.Fatalf("%+v", st)
	}
	a.CheckConnection(f.URL, "good-key")
	if a.State().Screen != "signup" {
		t.Fatal("not on signup")
	}
	if res := a.Signup(form(), testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
	if a.State().Screen != "home" {
		t.Fatal("not home after re-registering")
	}
}

func TestMachineRegisteredByCLIOpensHomeWithLocalScan(t *testing.T) {
	a, f := setup(t)
	if _, err := a.svc.Register(context.Background(), app.RegisterInput{ServerURL: f.URL, Key: "good-key", PIN: testPin, User: payload.UserDetails{FullName: "A", EmployeeID: "E", Department: "D"}}); err != nil {
		t.Fatal(err)
	}
	if st := a.State(); st.Screen != "home" || st.ServerURL != f.URL {
		t.Fatalf("a registered computer opens home, even without a saved enrollment key: %+v", st)
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

// ---- IT PIN ----

func configText(t *testing.T) string {
	t.Helper()
	dir, _ := config.Dir()
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestSetupSavesOnlyAHashOfTheEnrollmentKey(t *testing.T) {
	a, f := setup(t)
	if st := a.State(); st.Screen != "setup" {
		t.Fatalf("%+v", st)
	}
	if res := a.CheckConnection(f.URL, "good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if res := a.Signup(form(), testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
	if txt := configText(t); strings.Contains(txt, "good-key") {
		t.Fatalf("enrollment key in config.json:\n%s", txt)
	}
	cfg, _ := config.Load()
	if cfg.EnrollmentKeyHash == nil || !cfg.EnrollmentKeyHash.Verify("good-key") || cfg.EnrollmentKeyHash.Verify("other-key") {
		t.Fatalf("stored hash %+v", cfg.EnrollmentKeyHash)
	}
	if st := a.State(); st.Screen != "home" {
		t.Fatalf("%+v", st)
	}
}

func TestSetupStepAsksForNoPinFieldsButSignupNeedsThePin(t *testing.T) {
	a, f := setup(t)
	// IT setup is the enrollment key and the address; the PIN is typed with the signup form.
	if res := a.CheckConnection(f.URL, "good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if res := a.Signup(form(), testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
	if res := a.CheckConnection(f.URL, "good-key"); res.OK {
		t.Fatal("setup ran again on a registered computer")
	}
}

func TestFailedSignupDoesNotSaveTheKeyHash(t *testing.T) {
	a, f := setup(t)
	a.CheckConnection(f.URL, "wrong-key")
	if res := a.Signup(form(), testPin); res.OK {
		t.Fatalf("%+v", res)
	}
	if cfg, _ := config.Load(); cfg.EnrollmentKeyHash != nil {
		t.Fatal("key hash saved although registration failed")
	}
}

func registeredWithPin(t *testing.T) (*App, *fake) {
	t.Helper()
	a, f := setup(t)
	if res := a.CheckConnection(f.URL, "good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if res := a.Signup(form(), testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
	return a, f
}

func TestITSettingsNeedThePin(t *testing.T) {
	a, f := registeredWithPin(t)
	if p := a.UnlockMode(); p.Mode != "pin" || !strings.Contains(p.Message, "IT PIN shown on the PC_READER dashboard") {
		t.Fatalf("prompt %+v", p)
	}
	if s := a.ITSettings(); s.OK || s.ServerURL != "" {
		t.Fatalf("settings readable without the PIN: %+v", s)
	}
	if res := a.SaveServerURL(f.URL); res.OK {
		t.Fatal("server URL changed without the PIN")
	}
	if st := a.StartReregistration(); st.Screen != "home" {
		t.Fatalf("re-registration without the PIN: %+v", st)
	}
	if res := a.UnlockITSettings("000000"); res.OK || res.FieldErrors["pin"] == "" || res.Mode != "pin" || !strings.Contains(res.Message, "4 tries left") {
		t.Fatalf("%+v", res)
	}
	if res := a.UnlockITSettings("12ab"); res.OK || !strings.Contains(res.Message, "6 digits") {
		t.Fatalf("%+v", res)
	}
	callsBefore := f.unlockCalls
	if res := a.UnlockITSettings(" 482913 "); !res.OK {
		t.Fatalf("%+v", res)
	}
	if f.unlockCalls != callsBefore+1 {
		t.Fatal("the PIN was not checked by the server")
	}
	if s := a.ITSettings(); !s.OK || s.ServerURL != f.URL {
		t.Fatalf("%+v", s)
	}
	a.LockITSettings()
	if s := a.ITSettings(); s.OK {
		t.Fatal("still unlocked after locking")
	}
}

func TestOldPinHashIsNotAnUnlock(t *testing.T) {
	// Only the server's current PIN opens Settings: whatever PIN was typed at an older setup does not.
	a, f := registeredWithPin(t)
	f.pin = "111111"
	if res := a.UnlockITSettings("482913"); res.OK {
		t.Fatalf("an old PIN unlocked Settings: %+v", res)
	}
	if res := a.UnlockITSettings("111111"); !res.OK {
		t.Fatalf("%+v", res)
	}
}

func TestWrongPinLocksFor60SecondsAfterFiveTries(t *testing.T) {
	a, f := registeredWithPin(t)
	clock := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return clock }
	for i := 1; i <= 4; i++ {
		res := a.UnlockITSettings("000000")
		if res.OK || !strings.Contains(res.Message, "not correct") {
			t.Fatalf("try %d: %+v", i, res)
		}
	}
	if res := a.UnlockITSettings("000000"); res.OK || !strings.Contains(res.Message, "Too many wrong tries") || !strings.Contains(res.Message, "60 seconds") {
		t.Fatalf("fifth wrong PIN: %+v", res)
	}
	// Locked: even the right PIN is refused, without asking the server.
	calls := f.unlockCalls
	clock = clock.Add(59 * time.Second)
	if res := a.UnlockITSettings(f.pin); res.OK || !strings.Contains(res.Message, "Too many wrong tries") {
		t.Fatalf("right PIN accepted during lockout: %+v", res)
	}
	if f.unlockCalls != calls {
		t.Fatal("the server was asked during the lockout")
	}
	clock = clock.Add(2 * time.Second)
	if res := a.UnlockITSettings(f.pin); !res.OK {
		t.Fatalf("right PIN refused after lockout: %+v", res)
	}
	// A right PIN resets the count.
	a.LockITSettings()
	for i := 0; i < 4; i++ {
		a.UnlockITSettings("000000")
	}
	if res := a.UnlockITSettings(f.pin); !res.OK {
		t.Fatalf("count was not reset by the right PIN: %+v", res)
	}
}

func TestServerRateLimitIsReportedNotCounted(t *testing.T) {
	a, f := registeredWithPin(t)
	f.unlockStatus = 429
	res := a.UnlockITSettings(f.pin)
	if res.OK || res.Mode != "pin" || !strings.Contains(res.Message, "Too many wrong PINs") {
		t.Fatalf("%+v", res)
	}
}

func TestServerDownOffersTheEnrollmentKey(t *testing.T) {
	for _, down := range []string{"unreachable", "5xx"} {
		t.Run(down, func(t *testing.T) {
			a, f := registeredWithPin(t)
			if down == "5xx" {
				f.unlockStatus = 503
			} else {
				f.Close()
			}
			res := a.UnlockITSettings("482913")
			if res.OK || res.Mode != "key" || !strings.Contains(res.Message, "Can't reach the server. Enter the enrollment key to change the server address.") {
				t.Fatalf("%+v", res)
			}
			if a.isUnlocked() {
				t.Fatal("unlocked without checking anything")
			}
			// The prompt stays on the key until the window is left.
			if p := a.UnlockMode(); p.Mode != "key" {
				t.Fatalf("prompt %+v", p)
			}
			// Even the (never-stored) PIN does not open it now; a wrong key counts as a wrong try.
			if res := a.UnlockITSettings("482913"); res.OK || res.Mode != "key" || !strings.Contains(res.Message, "4 tries left") {
				t.Fatalf("%+v", res)
			}
			if res := a.UnlockITSettings("good-key"); !res.OK || res.Mode != "key" {
				t.Fatalf("%+v", res)
			}
			if !a.isUnlocked() {
				t.Fatal("not unlocked with the right key")
			}
			if s := a.ITSettings(); !s.OK {
				t.Fatalf("%+v", s)
			}
			a.LockITSettings()
			if p := a.UnlockMode(); p.Mode != "pin" {
				t.Fatalf("prompt did not return to the PIN after leaving: %+v", p)
			}
		})
	}
}

func TestOfflineUnlockIsLogged(t *testing.T) {
	a, f := registeredWithPin(t)
	var logged []string
	a.svc.Log = func(level, category, message string) { logged = append(logged, level+"/"+category+": "+message) }
	f.unlockStatus = 500
	a.UnlockITSettings("482913")
	if res := a.UnlockITSettings("wrong"); res.OK || len(logged) != 0 {
		t.Fatalf("%+v %v", res, logged)
	}
	if res := a.UnlockITSettings("good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "enrollment key") || strings.Contains(logged[0], "good-key") {
		t.Fatalf("log %v", logged)
	}
}

func TestWrongKeysAndPinsShareOneLockout(t *testing.T) {
	a, f := registeredWithPin(t)
	clock := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return clock }
	for i := 0; i < 2; i++ {
		a.UnlockITSettings("000000") // wrong PIN, server up
	}
	f.unlockStatus = 500
	a.UnlockITSettings("000000") // server down: switches to the key, not counted
	for i := 0; i < 2; i++ {
		a.UnlockITSettings("nope") // wrong keys: 3rd and 4th wrong try overall
	}
	if res := a.UnlockITSettings("nope"); !strings.Contains(res.Message, "Too many wrong tries") {
		t.Fatalf("fifth wrong try overall: %+v", res)
	}
	if res := a.UnlockITSettings("good-key"); res.OK {
		t.Fatalf("right key accepted during lockout: %+v", res)
	}
	clock = clock.Add(61 * time.Second)
	if res := a.UnlockITSettings("good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
}

func TestOfflineWithoutSavedKeyCannotUnlock(t *testing.T) {
	a, f := setup(t)
	// Registered by the CLI or an older app version: no enrollment key hash on this computer.
	if _, err := a.svc.Register(context.Background(), app.RegisterInput{ServerURL: f.URL, Key: "good-key", PIN: testPin, User: payload.UserDetails{FullName: "A", EmployeeID: "E", Department: "D"}}); err != nil {
		t.Fatal(err)
	}
	f.unlockStatus = 500
	if res := a.UnlockITSettings("482913"); res.Mode != "key" {
		t.Fatalf("%+v", res)
	}
	for i := 0; i < 7; i++ { // not counted as wrong tries, so never locks out
		res := a.UnlockITSettings("good-key")
		if res.OK || !strings.Contains(res.Message, "no saved enrollment key") || !strings.Contains(res.Message, "IT PIN") {
			t.Fatalf("try %d: %+v", i, res)
		}
	}
	if a.isUnlocked() {
		t.Fatal("unlocked without a saved key")
	}
	// With the server back, the PIN works as usual.
	a.LockITSettings()
	f.unlockStatus = 0
	if res := a.UnlockITSettings("482913"); !res.OK {
		t.Fatalf("%+v", res)
	}
}

func TestRejectedTokenAsksForTheEnrollmentKeyAndRegistersAgain(t *testing.T) {
	a, f := registeredWithPin(t)
	f.unauthorized = true
	// The window already knows (background connection) that the server rejects this computer.
	a.SetConnection("reregister", "Re-registration needed")
	if p := a.UnlockMode(); p.Mode != "key" || !strings.Contains(p.Message, "enrollment key") {
		t.Fatalf("prompt %+v", p)
	}
	if res := a.UnlockITSettings("wrong"); res.OK || res.Mode != "key" {
		t.Fatalf("%+v", res)
	}
	if res := a.UnlockITSettings("good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	f.unauthorized = false
	st := a.StartReregistration()
	if st.Screen != "setup" {
		t.Fatalf("%+v", st)
	}
	if res := a.CheckConnection(f.URL, "good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if res := a.Signup(form(), testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
}

func TestServerRejectingTheTokenOnUnlockSwitchesToTheKey(t *testing.T) {
	a, f := registeredWithPin(t)
	f.unauthorized = true // the window has not heard about it yet
	res := a.UnlockITSettings("482913")
	if res.OK || res.Mode != "key" || !strings.Contains(res.Message, "no longer recognises") {
		t.Fatalf("%+v", res)
	}
	if p := a.UnlockMode(); p.Mode != "key" {
		t.Fatalf("%+v", p)
	}
}

func TestMissingTokenAsksForTheKeyFirst(t *testing.T) {
	a, _ := registeredWithPin(t)
	cfg, _ := config.Load()
	cfg.DeviceUUID = "00000000-0000-4000-8000-000000000000"
	_ = cfg.Save()
	if p := a.UnlockMode(); p.Mode != "key" {
		t.Fatalf("%+v", p)
	}
}

func TestSettingsChangeServerURL(t *testing.T) {
	a, f := registeredWithPin(t)
	a.UnlockITSettings(f.pin)

	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>")) }))
	defer other.Close()
	if res := a.SaveServerURL("not a url"); res.OK || res.FieldErrors["serverUrl"] == "" {
		t.Fatalf("%+v", res)
	}
	if res := a.SaveServerURL(other.URL + "/"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if cfg, _ := config.Load(); cfg.ServerURL != other.URL {
		t.Fatalf("server URL %q", cfg.ServerURL)
	}
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	if res := a.SaveServerURL(deadURL); res.OK || !strings.Contains(res.Message, "Cannot reach the server at "+deadURL) {
		t.Fatalf("%+v", res)
	}
	if cfg, _ := config.Load(); cfg.ServerURL != other.URL {
		t.Fatal("unreachable address was saved")
	}

	if txt := configText(t); strings.Contains(txt, f.pin) {
		t.Fatalf("PIN in config.json:\n%s", txt)
	}
	a.LockITSettings()
	if res := a.SaveServerURL(f.URL); res.OK {
		t.Fatal("server address changed while locked")
	}
}

func TestReregisterThroughITSettingsRefreshesTheKeyHash(t *testing.T) {
	a, f := registeredWithPin(t)
	a.UnlockITSettings(f.pin)
	st := a.StartReregistration()
	if st.Screen != "setup" {
		t.Fatalf("%+v", st)
	}
	if res := a.CheckConnection(f.URL, ""); res.OK || res.FieldErrors["key"] == "" {
		t.Fatalf("%+v", res)
	}
	if res := a.CheckConnection(f.URL, "good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if res := a.Signup(form(), testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
	if cfg, _ := config.Load(); cfg.EnrollmentKeyHash == nil || !cfg.EnrollmentKeyHash.Verify("good-key") {
		t.Fatal("key hash lost while registering again")
	}
	if s := a.ITSettings(); s.OK {
		t.Fatal("IT settings stayed unlocked after registering again")
	}
}

func TestReregistrationGivesACLIRegisteredComputerItsKeyHash(t *testing.T) {
	a, f := setup(t)
	if _, err := a.svc.Register(context.Background(), app.RegisterInput{ServerURL: f.URL, Key: "good-key", PIN: testPin, User: payload.UserDetails{FullName: "A", EmployeeID: "E", Department: "D"}}); err != nil {
		t.Fatal(err)
	}
	if cfg, _ := config.Load(); cfg.EnrollmentKeyHash != nil {
		t.Fatal("CLI registration saved a key hash")
	}
	a.UnlockITSettings(f.pin)
	a.StartReregistration()
	a.CheckConnection(f.URL, "good-key")
	if res := a.Signup(form(), testPin); !res.OK {
		t.Fatalf("%+v", res)
	}
	if cfg, _ := config.Load(); cfg.EnrollmentKeyHash == nil || !cfg.EnrollmentKeyHash.Verify("good-key") {
		t.Fatal("no key hash after re-registering")
	}
}

func TestLeavingSettingsAbandonsReregistration(t *testing.T) {
	a, f := registeredWithPin(t)
	a.UnlockITSettings(f.pin)
	if st := a.StartReregistration(); st.Screen != "setup" {
		t.Fatalf("%+v", st)
	}
	a.LockITSettings()
	if st := a.State(); st.Screen != "home" {
		t.Fatalf("setup stayed reachable without Settings: %+v", st)
	}
}

func TestUnregisteredComputerShowsSetup(t *testing.T) {
	a, f := registeredWithPin(t)
	cfg, _ := config.Load()
	cfg.DeviceID = "" // registration lost
	_ = cfg.Save()
	if st := a.State(); st.Screen != "setup" {
		t.Fatalf("%+v", st)
	}
	if res := a.CheckConnection(f.URL, "good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
}

func TestOnReadyFiresAfterSignupButNotAfterFailedSignup(t *testing.T) {
	a, f := setup(t)
	ready := 0
	a.OnReady = func() { ready++ }
	if res := a.CheckConnection(f.URL, "wrong-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if res := a.Signup(form(), testPin); res.OK || ready != 0 {
		t.Fatalf("wrong key: res=%+v ready=%d", res, ready)
	}
	a.mu.Lock()
	a.pendingKey = "good-key"
	a.mu.Unlock()
	if res := a.Signup(form(), testPin); !res.OK || ready != 1 {
		t.Fatalf("signup: res=%+v ready=%d", res, ready)
	}
}

func TestConnectionStatusAndDetailsPromptState(t *testing.T) {
	a, _ := setup(t)
	if c := a.Connection(); c.Status != "" {
		t.Fatalf("status before the shell reports: %+v", c)
	}
	a.SetConnection("connected", "Connected")
	if c := a.Connection(); c.Status != "connected" || c.Label != "Connected" {
		t.Fatalf("connection = %+v", c)
	}
	a.SetConnection("reregister", "Re-registration needed")
	if c := a.Connection(); c.Status != "reregister" {
		t.Fatalf("connection = %+v", c)
	}

	if p := a.TakePrompt(); p.Show {
		t.Fatalf("prompt without a request: %+v", p)
	}
	a.RaisePrompt()
	a.RaisePrompt() // twice before the window looked still shows once
	p := a.TakePrompt()
	if !p.Show || !strings.Contains(p.Message, "IT asked") {
		t.Fatalf("prompt = %+v", p)
	}
	if again := a.TakePrompt(); again.Show {
		t.Fatalf("prompt shown twice: %+v", again)
	}
}

// ---- the app is view-only without the hourly IT PIN ----

func unlockApp(t *testing.T, a *App) {
	t.Helper()
	if res := a.UnlockITSettings(testPin); !res.OK {
		t.Fatalf("unlock: %+v", res)
	}
}

func TestViewingNeedsNoPin(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	if h := a.MyComputer(); !h.OK || len(h.Sections) == 0 {
		t.Fatalf("%+v", h)
	}
	if sv := a.Session(); sv.Unlocked {
		t.Fatalf("a fresh window is unlocked: %+v", sv)
	}
}

func TestReportNowNeedsThePinAndSendsNothingWithout(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	before := len(f.scans)
	res := a.ReportNow()
	if res.OK || !res.NeedsPin || len(f.scans) != before {
		t.Fatalf("%+v (scans %d -> %d)", res, before, len(f.scans))
	}
	unlockApp(t, a)
	if res := a.ReportNow(); !res.OK || len(f.scans) != before+1 || f.scans[before].ITPIN != testPin || f.scans[before].ScanType != "manual" {
		t.Fatalf("%+v scans %+v", res, f.scans)
	}
}

func TestOneCorrectPinCoversSeveralActionsUntilItExpires(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	clock := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return clock }
	unlockApp(t, a)
	if sv := a.Session(); !sv.Unlocked || !sv.HasPin || sv.SecondsLeft != 600 {
		t.Fatalf("session %+v", sv)
	}
	clock = clock.Add(9*time.Minute + 59*time.Second)
	if res := a.ReportNow(); !res.OK {
		t.Fatalf("report inside the session: %+v", res)
	}
	if res := a.UpdateUser(form(), ""); !res.OK {
		t.Fatalf("update inside the session (no PIN typed): %+v", res)
	}
	clock = clock.Add(2 * time.Second) // 10 minutes and 1 second after the unlock
	if sv := a.Session(); sv.Unlocked {
		t.Fatalf("still unlocked after 10 minutes: %+v", sv)
	}
	calls := len(f.scans)
	if res := a.ReportNow(); res.OK || !res.NeedsPin || len(f.scans) != calls {
		t.Fatalf("report after expiry: %+v", res)
	}
	if res := a.ITSettings(); res.OK {
		t.Fatal("Settings still readable after expiry")
	}
}

func TestHidingTheWindowLocksTheApp(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	unlockApp(t, a)
	a.LockITSettings() // what the shell calls when the window is hidden
	if sv := a.Session(); sv.Unlocked || sv.HasPin {
		t.Fatalf("%+v", sv)
	}
	if res := a.ReportNow(); res.OK || !res.NeedsPin {
		t.Fatalf("%+v", res)
	}
	if a.sessionPin != "" {
		t.Fatal("the PIN was kept in memory after locking")
	}
}

func TestEnrollmentKeyUnlockOpensSettingsButNotActions(t *testing.T) {
	a, f := registeredWithPin(t)
	f.unlockStatus = 500
	if res := a.UnlockITSettings(testPin); res.Mode != "key" {
		t.Fatalf("%+v", res)
	}
	if res := a.UnlockITSettings("good-key"); !res.OK {
		t.Fatalf("%+v", res)
	}
	if sv := a.Session(); !sv.Unlocked || sv.HasPin {
		t.Fatalf("session %+v", sv)
	}
	if res := a.ReportNow(); res.OK || !res.NeedsPin {
		t.Fatalf("a key unlock allowed Report now: %+v", res)
	}
	if res := a.UpdateUser(form(), ""); res.OK || !res.NeedsPin || f.userCalls != 0 {
		t.Fatalf("a key unlock allowed an update: %+v", res)
	}
}

func TestUpdateUserNeedsThePinTypedOrFromTheSession(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	upd := form()
	upd.Department = "Budget"
	if res := a.UpdateUser(upd, ""); res.OK || !res.NeedsPin || res.FieldErrors["pin"] == "" || f.userCalls != 0 {
		t.Fatalf("%+v", res)
	}
	if res := a.UpdateUser(upd, "12ab"); res.OK || !strings.Contains(res.FieldErrors["pin"], "6 digits") || f.userCalls != 0 {
		t.Fatalf("%+v", res)
	}
	if res := a.UpdateUser(upd, "000000"); res.OK || !res.NeedsPin || !strings.Contains(res.FieldErrors["pin"], "4 tries left") || len(f.updates) != 0 {
		t.Fatalf("%+v", res)
	}
	if res := a.UpdateUser(upd, testPin); !res.OK || len(f.updates) != 1 {
		t.Fatalf("%+v", res)
	}
	// The accepted PIN opens the session, so Report now works without asking again.
	if sv := a.Session(); !sv.Unlocked || !sv.HasPin {
		t.Fatalf("session %+v", sv)
	}
	if res := a.ReportNow(); !res.OK {
		t.Fatalf("%+v", res)
	}
}

func TestDashboardPromptDoesNotSkipThePin(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	a.RaisePrompt()
	if p := a.TakePrompt(); !p.Show || !strings.Contains(p.Message, "IT needs to enter the PIN to save") {
		t.Fatalf("%+v", p)
	}
	if res := a.UpdateUser(form(), ""); res.OK || !res.NeedsPin || f.userCalls != 0 {
		t.Fatalf("saved without the PIN after a prompt: %+v", res)
	}
}

func TestPinChangedMidSessionAsksAgainAndCountsAsWrong(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	unlockApp(t, a)
	f.pin = "111111" // IT pressed Change now
	res := a.ReportNow()
	if res.OK || !res.NeedsPin || !strings.Contains(res.Message, "not correct") {
		t.Fatalf("%+v", res)
	}
	if sv := a.Session(); sv.HasPin {
		t.Fatalf("the stale PIN was kept: %+v", sv)
	}
}

func TestSignupNeedsThePinAndSharesTheLockout(t *testing.T) {
	a, f := setup(t)
	a.CheckConnection(f.URL, "good-key")
	if res := a.Signup(form(), ""); res.OK || res.FieldErrors["pin"] == "" || !res.NeedsPin {
		t.Fatalf("%+v", res)
	}
	if res := a.Signup(form(), "12345"); res.OK || !strings.Contains(res.FieldErrors["pin"], "6 digits") {
		t.Fatalf("%+v", res)
	}
	for i := 4; i >= 1; i-- {
		res := a.Signup(form(), "000000")
		if res.OK || !res.NeedsPin || !strings.Contains(res.FieldErrors["pin"], fmt.Sprintf("%d tries left", i)) {
			t.Fatalf("try: %+v", res)
		}
	}
	// The fifth wrong try locks every prompt, Settings included.
	if res := a.Signup(form(), "000000"); res.OK || !strings.Contains(res.Message, "Too many wrong tries") {
		t.Fatalf("%+v", res)
	}
	if res := a.Signup(form(), testPin); res.OK || !strings.Contains(res.Message, "Too many wrong tries") {
		t.Fatalf("locked prompt accepted the right PIN: %+v", res)
	}
	if res := a.UnlockITSettings(testPin); res.OK || !strings.Contains(res.Message, "Too many wrong tries") {
		t.Fatalf("%+v", res)
	}
	if a.State().Screen == "home" {
		t.Fatal("registered while locked out")
	}
}

func TestSignupWithAWrongEnrollmentKeyIsNotAWrongPin(t *testing.T) {
	a, f := setup(t)
	a.CheckConnection(f.URL, "bad-key")
	res := a.Signup(form(), testPin)
	if res.OK || res.NeedsPin || !strings.Contains(res.Message, "enrollment key is not correct") {
		t.Fatalf("%+v", res)
	}
	if a.pinFailures != 0 {
		t.Fatal("a wrong enrollment key counted as a wrong PIN try")
	}
}

func TestActionsOfflineSayTheServerIsUnreachableWithNoKeyFallback(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	unlockApp(t, a)
	f.Close()
	if res := a.ReportNow(); res.OK || res.Message != offlineActionMessage {
		t.Fatalf("%+v", res)
	}
	if res := a.UpdateUser(form(), ""); res.OK || res.Message != offlineActionMessage {
		t.Fatalf("%+v", res)
	}
}

func TestSignupOfflineSaysTheServerIsUnreachable(t *testing.T) {
	a, f := setup(t)
	a.CheckConnection(f.URL, "good-key")
	f.Close()
	if res := a.Signup(form(), testPin); res.OK || res.Message != offlineActionMessage {
		t.Fatalf("%+v", res)
	}
}

func TestServerRateLimitOnAnActionAsksToWait(t *testing.T) {
	a, f := setup(t)
	register(t, a, f)
	unlockApp(t, a)
	f.Server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":"too_many_attempts","message":"Too many wrong PINs"}`))
	})
	if res := a.ReportNow(); res.OK || !res.NeedsPin || !strings.Contains(res.Message, "Try again in a minute") {
		t.Fatalf("%+v", res)
	}
	if a.pinFailures != 0 {
		t.Fatal("a server rate limit was counted as a wrong try")
	}
}
