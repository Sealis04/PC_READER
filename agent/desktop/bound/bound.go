// Package bound holds the Go methods the desktop UI calls. It has no Wails dependency (the
// Wails shell in the parent folder binds an *App), so everything here is unit-tested on any OS.
// Methods never return Go errors: failures come back in plain words in the result structs,
// because that is what the UI shows.
package bound

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // Windows has no zoneinfo; the dashboard's default zone must still work.

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// DisplayTimezone formats times shown in the window, like the dashboard's DISPLAY_TIMEZONE.
const DisplayTimezone = "Asia/Manila"

const reregisterMessage = "The server no longer recognises this computer. Ask IT for the enrollment key and register again."

// App is bound to the window. Create it with New.
type App struct {
	svc     *app.Service
	version string
	ctx     context.Context

	mu            sync.Mutex // guards the in-memory setup state below
	pendingServer string     // set by CheckConnection, used by Signup
	pendingKey    string     // held in memory only until signup; never written to disk
	reregistering bool

	busy sync.Mutex // one scan/upload/signup at a time
}

func New(svc *app.Service, version string) *App {
	return &App{svc: svc, version: version, ctx: context.Background()}
}

// Startup stores the window's context (Wails calls it on start).
func (a *App) Startup(ctx context.Context) { a.ctx = ctx }

// UserForm is the person's details as typed in the window.
type UserForm struct {
	FullName       string `json:"fullName"`
	EmployeeID     string `json:"employeeId"`
	Department     string `json:"department"`
	Email          string `json:"email"`
	Position       string `json:"position"`
	Phone          string `json:"phone"`
	PolicyAccepted bool   `json:"policyAccepted"`
}

// State tells the UI which screen to open.
type State struct {
	Screen    string    `json:"screen"` // "setup", "signup" or "home"
	Version   string    `json:"version"`
	Notice    string    `json:"notice"`
	ServerURL string    `json:"serverUrl"`
	User      *UserForm `json:"user"` // prefill for signup when registering again
}

func (a *App) State() State {
	st := State{Version: a.version, Notice: app.Notice}
	status, err := a.svc.Status()
	if err == nil {
		st.ServerURL = status.ServerURL
		if status.User != nil {
			st.User = formFromUser(*status.User)
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case err == nil && status.Registered && !a.reregistering:
		st.Screen = "home"
	case a.pendingServer != "":
		st.Screen, st.ServerURL = "signup", a.pendingServer
	default:
		st.Screen = "setup"
	}
	return st
}

// Result is the common outcome of an action.
type Result struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	// FieldErrors maps form fields (fullName, employeeId, ...) to messages.
	FieldErrors map[string]string `json:"fieldErrors"`
	// NeedsReregistration means the server rejected this computer's token.
	NeedsReregistration bool `json:"needsReregistration"`
}

func fail(msg string) Result { return Result{Message: msg} }

// CheckConnection is the IT setup step: it checks the server answers and keeps the address and
// enrollment key in memory for the signup that follows. The key is verified at signup.
func (a *App) CheckConnection(serverURL, key string) Result {
	if strings.TrimSpace(key) == "" {
		return Result{Message: "Enter the enrollment key from IT.", FieldErrors: map[string]string{"key": "Required"}}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	u, err := a.svc.CheckConnection(ctx, serverURL)
	if err != nil {
		res := fail(friendly(err, serverURL))
		if strings.Contains(err.Error(), "must be a URL") {
			res.FieldErrors = map[string]string{"serverUrl": "Use an address like http://192.168.1.10:3000"}
		}
		return res
	}
	a.mu.Lock()
	a.pendingServer, a.pendingKey = u, strings.TrimSpace(key)
	a.mu.Unlock()
	return Result{OK: true, Message: "Connected to " + u + "."}
}

// StartReregistration returns to the IT setup screen after the server rejected this computer,
// keeping the saved details as the signup prefill.
func (a *App) StartReregistration() State {
	a.mu.Lock()
	a.reregistering, a.pendingServer, a.pendingKey = true, "", ""
	a.mu.Unlock()
	return a.State()
}

// Signup scans, registers, uploads the first scan and saves everything.
func (a *App) Signup(f UserForm) Result {
	if errs := validate(f, true); len(errs) > 0 {
		return Result{Message: "Please fix the highlighted fields.", FieldErrors: errs}
	}
	a.mu.Lock()
	server, key := a.pendingServer, a.pendingKey
	a.mu.Unlock()
	if server == "" || key == "" {
		return fail("The server is not set up yet. Go back to the IT setup step.")
	}
	if !a.busy.TryLock() {
		return fail("Another action is still running. Please wait.")
	}
	defer a.busy.Unlock()

	res, err := a.svc.Register(a.ctx, app.RegisterInput{ServerURL: server, Key: key, User: userFromForm(f), UploadFirstScan: true})
	if err != nil {
		return signupFailure(err, server)
	}
	a.mu.Lock()
	a.pendingServer, a.pendingKey, a.reregistering = "", "", false
	a.mu.Unlock()
	out := Result{OK: true, Message: "Registered " + res.Hostname + "."}
	if res.UploadErr != nil {
		out.Message += " Your specs could not be sent yet (" + friendly(res.UploadErr, server) + "); use “Report now” to try again."
	}
	return out
}

func signupFailure(err error, server string) Result {
	var apiErr *api.Error
	if errors.As(err, &apiErr) && apiErr.Status == 400 {
		if fields := fieldErrorsFromDetails(apiErr); len(fields) > 0 {
			return Result{Message: "The server did not accept some of your details.", FieldErrors: fields}
		}
	}
	return fail(friendly(err, server))
}

// Summary is the "My computer" card; Sections is the full scan, grouped.
type Summary struct {
	ComputerName string     `json:"computerName"`
	Model        string     `json:"model"`
	Serial       string     `json:"serial"`
	OS           string     `json:"os"`
	CPU          string     `json:"cpu"`
	Memory       string     `json:"memory"`
	Disks        []DiskView `json:"disks"`
	IPAddress    string     `json:"ipAddress"`
}

type DiskView struct {
	Name     string `json:"name"`
	Size     string `json:"size"`
	Free     string `json:"free"`
	UsedPct  int    `json:"usedPct"`
	HasUsage bool   `json:"hasUsage"`
}

// Home is everything the "My computer" screen shows.
type Home struct {
	OK           bool      `json:"ok"`
	Message      string    `json:"message"`
	Server       string    `json:"server"`
	AssignedUser *UserForm `json:"assignedUser"`
	LastReportAt string    `json:"lastReportAt"`
	// Reported is false when the specs come from a fresh local scan that was never uploaded.
	Reported bool      `json:"reported"`
	Summary  Summary   `json:"summary"`
	Sections []Section `json:"sections"`
	// NeedsReregistration is set when the token is missing from the credential store.
	NeedsReregistration bool `json:"needsReregistration"`
}

func (a *App) MyComputer() Home {
	st, err := a.svc.Status()
	if err != nil {
		return Home{Message: "Could not read this computer's saved settings: " + err.Error()}
	}
	h := Home{OK: true, Server: st.ServerURL, LastReportAt: "Never", Reported: st.LastPayload != nil}
	if st.User != nil {
		h.AssignedUser = formFromUser(*st.User)
	}
	if st.TokenErr != nil {
		h.NeedsReregistration, h.Message = true, reregisterMessage
	}
	if st.LastReportAt != "" {
		h.LastReportAt = displayTime(st.LastReportAt)
	}
	sc := st.LastPayload
	if sc == nil {
		// Registered without a stored scan (e.g. by the command-line tool): scan locally for display.
		if !a.busy.TryLock() {
			return Home{Message: "Another action is still running. Please wait."}
		}
		defer a.busy.Unlock()
		if sc, err = a.svc.Collect(a.ctx, ""); err != nil {
			h.OK, h.Message = false, "Could not read this computer's specs: "+err.Error()
			return h
		}
	}
	h.Summary, h.Sections = summarize(sc), sections(sc)
	return h
}

// ReportNow scans and uploads, then returns the refreshed screen.
type ReportResult struct {
	Result
	Home           Home   `json:"home"`
	Duplicate      bool   `json:"duplicate"`
	ReportedAtText string `json:"reportedAt"`
}

func (a *App) ReportNow() ReportResult {
	if !a.busy.TryLock() {
		return ReportResult{Result: fail("Another action is still running. Please wait.")}
	}
	_, dup, _, err := a.svc.Report(a.ctx, "manual")
	a.busy.Unlock()
	if err != nil {
		return ReportResult{Result: a.failure(err), Home: a.MyComputer()}
	}
	home := a.MyComputer()
	return ReportResult{
		Result:         Result{OK: true, Message: "Your computer's specs were sent at " + home.LastReportAt + "."},
		Home:           home,
		Duplicate:      dup,
		ReportedAtText: home.LastReportAt,
	}
}

// UpdateUser saves corrected details. A different employee ID hands the computer to that person.
func (a *App) UpdateUser(f UserForm) Result {
	if errs := validate(f, false); len(errs) > 0 {
		return Result{Message: "Please fix the highlighted fields.", FieldErrors: errs}
	}
	if !a.busy.TryLock() {
		return fail("Another action is still running. Please wait.")
	}
	defer a.busy.Unlock()
	if _, err := a.svc.UpdateUser(a.ctx, userFromForm(f)); err != nil {
		var apiErr *api.Error
		if errors.As(err, &apiErr) && apiErr.Status == 400 {
			if fields := fieldErrorsFromDetails(apiErr); len(fields) > 0 {
				return Result{Message: "The server did not accept some of your details.", FieldErrors: fields}
			}
		}
		return a.failure(err)
	}
	return Result{OK: true, Message: "Your details were saved."}
}

// failure turns an error from a signed-in call into a result, flagging a rejected token.
func (a *App) failure(err error) Result {
	if errors.Is(err, api.ErrUnauthorized) || errors.Is(err, app.ErrNotRegistered) {
		return Result{Message: reregisterMessage, NeedsReregistration: true}
	}
	st, _ := a.svc.Status()
	server := ""
	if st != nil {
		server = st.ServerURL
	}
	return fail(friendly(err, server))
}

// ---- validation and wording ----

func validate(f UserForm, needPolicy bool) map[string]string {
	errs := map[string]string{}
	need := func(key, v, label string, max int) {
		switch v = strings.TrimSpace(v); {
		case v == "":
			errs[key] = label + " is required"
		case len(v) > max:
			errs[key] = label + " is too long"
		}
	}
	need("fullName", f.FullName, "Full name", 255)
	need("employeeId", f.EmployeeID, "Employee ID", 64)
	need("department", f.Department, "Department", 255)
	if e := strings.TrimSpace(f.Email); e != "" {
		if addr, err := mail.ParseAddress(e); err != nil || addr.Address != e {
			errs["email"] = "Enter a valid email address"
		} else if len(e) > 255 {
			errs["email"] = "Email is too long"
		}
	}
	if len(strings.TrimSpace(f.Position)) > 255 {
		errs["position"] = "Position is too long"
	}
	if len(strings.TrimSpace(f.Phone)) > 64 {
		errs["phone"] = "Phone is too long"
	}
	if needPolicy && !f.PolicyAccepted {
		errs["policyAccepted"] = "Tick the box to continue"
	}
	return errs
}

var detailFields = map[string]string{
	"full_name": "fullName", "employee_id": "employeeId", "department": "department",
	"email": "email", "position": "position", "phone": "phone",
}

func fieldErrorsFromDetails(e *api.Error) map[string]string {
	out := map[string]string{}
	for _, d := range e.Details {
		name := d.Path[strings.LastIndex(d.Path, "/")+1:]
		if field, ok := detailFields[name]; ok {
			out[field] = capitalize(d.Message)
		}
	}
	return out
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// friendly turns an error into a sentence for the user.
func friendly(err error, server string) string {
	var apiErr *api.Error
	switch {
	case errors.Is(err, api.ErrUnauthorized):
		return reregisterMessage
	case errors.As(err, &apiErr):
		switch {
		case apiErr.Status == 403:
			return "The enrollment key is not correct. Ask IT for the right key."
		case apiErr.Code == "enrollment_disabled" || apiErr.Status == 503:
			return "The server is not accepting new computers yet. Tell IT."
		case apiErr.Status == 404:
			return "That address answered, but it does not look like a PC_READER server. Check it with IT."
		case apiErr.Status == 413:
			return "The scan was too large for the server. Tell IT."
		case apiErr.Status >= 500:
			return "The server had a problem. Try again in a few minutes."
		}
		return "The server did not accept the request: " + apiErr.Message
	case strings.Contains(err.Error(), "cannot reach"):
		if server == "" {
			return "Cannot reach the server. Check that you are on the agency network."
		}
		return "Cannot reach the server at " + server + ". Check the address and that you are on the agency network."
	case strings.Contains(err.Error(), "must be a URL"):
		return "The server address must look like http://192.168.1.10:3000."
	}
	return "Something went wrong: " + err.Error()
}

func displayTime(rfc3339 string) string {
	t, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		return rfc3339
	}
	if loc, err := time.LoadLocation(DisplayTimezone); err == nil {
		t = t.In(loc)
	}
	return t.Format("2 Jan 2006, 3:04 PM")
}

func userFromForm(f UserForm) payload.UserDetails {
	return payload.UserDetails{
		FullName:   strings.TrimSpace(f.FullName),
		EmployeeID: strings.TrimSpace(f.EmployeeID),
		Department: strings.TrimSpace(f.Department),
		Email:      rd.StrPtr(f.Email),
		Position:   rd.StrPtr(f.Position),
		Phone:      rd.StrPtr(f.Phone),
	}
}

func formFromUser(u payload.UserDetails) *UserForm {
	return &UserForm{
		FullName:   u.FullName,
		EmployeeID: u.EmployeeID,
		Department: u.Department,
		Email:      rd.Deref(u.Email),
		Position:   rd.Deref(u.Position),
		Phone:      rd.Deref(u.Phone),
	}
}
