// Package bound holds the Go methods the desktop UI calls. It has no Wails dependency (the
// Wails shell in the parent folder binds an *App), so everything here is unit-tested on any OS.
// Methods never return Go errors: failures come back in plain words in the result structs,
// because that is what the UI shows.
package bound

import (
	"context"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // Windows has no zoneinfo; the dashboard's default zone must still work.

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// DisplayTimezone formats times shown in the window, like the dashboard's DISPLAY_TIMEZONE.
const DisplayTimezone = "Asia/Manila"

// Unlock lockout: after maxPinFailures wrong PINs (or enrollment keys) in a row, every PIN prompt (Settings,
// Report now, signup, Update my details) is refused for pinLockout. The server also rate-limits wrong PINs.
// A correct PIN unlocks the app for unlockSession (or until the window is hidden); without it the window is
// view-only: My computer and Full details.
const (
	maxPinFailures = 5
	pinLockout     = 60 * time.Second
	unlockSession  = 10 * time.Minute
	// unlockTimeout is how long the server gets to answer before Settings falls back to the enrollment key.
	unlockTimeout = 8 * time.Second
	// brandingTimeout bounds one fetch of the agency name and logo.
	brandingTimeout = 15 * time.Second
)

// Unlock modes: what the Settings prompt asks for.
const (
	modePin = "pin" // the hourly IT PIN from the dashboard, checked by the server
	modeKey = "key" // the enrollment key, checked against the hash saved at IT setup
)

const reregisterMessage = "The server no longer recognises this computer. Ask IT for the enrollment key and register again."

// App is bound to the window. Create it with New.
type App struct {
	svc     *app.Service
	version string
	ctx     context.Context

	mu            sync.Mutex // guards the in-memory setup state below
	pendingServer string     // set by CheckConnection, used by Signup
	pendingKey    string     // held in memory only until signup (then only its hash is saved)
	reregistering bool
	keyFromPrompt bool      // the pending key was typed at the rejected-token prompt, so a wrong one counts as a wrong try
	keyReason     string    // "offline" or "rejected" once Settings asks for the enrollment key instead of the PIN
	unlockedUntil time.Time // the IT session is open until then (zero: locked)
	sessionPin    string    // the PIN the server accepted, kept in memory only to send with this session's actions; "" after a key unlock
	pinFailures   int       // consecutive wrong PINs or keys
	lockedUntil   time.Time // PIN checks refused until then
	now           func() time.Time

	busy sync.Mutex // one scan/upload/signup at a time

	// OnReady is called (when set) once IT setup or signup has finished on this computer: the
	// shell starts the background connection and start-at-login then. It runs outside the lock.
	OnReady func()

	connStatus, connLabel string // background connection, set by the shell
	promptPending         bool   // IT asked the user to confirm their details
	// confirm is IT's approval from the latest "confirm details" request: one save without the PIN.
	confirm *payload.ConfirmApproval
}

func New(svc *app.Service, version string) *App {
	return &App{svc: svc, version: version, ctx: context.Background(), now: time.Now}
}

// Startup stores the window's context (Wails calls it on start).
func (a *App) Startup(ctx context.Context) { a.ctx = ctx }

// ConnectionView is the background connection as the window shows it.
type ConnectionView struct {
	// Status is "connecting", "connected", "offline" or "reregister" ("" until the shell reports).
	Status string `json:"status"`
	Label  string `json:"label"`
}

// SetConnection records the background connection status (called by the shell).
func (a *App) SetConnection(status, label string) {
	a.mu.Lock()
	a.connStatus, a.connLabel = status, label
	a.mu.Unlock()
}

// Connection is what the window shows next to "My computer".
func (a *App) Connection() ConnectionView {
	a.mu.Lock()
	defer a.mu.Unlock()
	return ConnectionView{Status: a.connStatus, Label: a.connLabel}
}

// DefaultBrandName is shown until a server has told the app its agency name.
const DefaultBrandName = "PC_READER"

// BrandingView is what the window header shows: the agency name and, when the server has one, the logo
// as a data: URL ("" for none).
type BrandingView struct {
	Name string `json:"name"`
	Logo string `json:"logo"`
}

func brandingView(b *config.Branding) BrandingView {
	if b == nil || b.Name == "" {
		return BrandingView{Name: DefaultBrandName}
	}
	return BrandingView{Name: b.Name, Logo: b.Logo}
}

// Branding is the saved agency name and logo (no network, so it is instant and works offline).
func (a *App) Branding() BrandingView { return brandingView(a.svc.CachedBranding()) }

// RefreshBranding fetches the agency name and logo from the server and returns what to show: the new
// branding, or the saved one when the server cannot be reached. The shell calls it on launch and when the
// connection opens; the window listens for the "branding" event it emits afterwards.
func (a *App) RefreshBranding() BrandingView { return a.refreshBranding("") }

func (a *App) refreshBranding(serverURL string) BrandingView {
	ctx, cancel := context.WithTimeout(a.ctx, brandingTimeout)
	defer cancel()
	b, _ := a.svc.RefreshBranding(ctx, serverURL)
	return brandingView(b)
}

// RaisePrompt records that IT asked the user to confirm their details (called by the shell), with the
// request's approval code: it lets the user save once without the PIN. Kept in memory only.
func (a *App) RaisePrompt(requestID, approval string) {
	a.mu.Lock()
	a.promptPending = true
	if requestID != "" && approval != "" {
		a.confirm = &payload.ConfirmApproval{RequestID: requestID, Approval: approval}
	}
	a.mu.Unlock()
}

const (
	confirmPromptMessage = "IT asked you to confirm these details."
	pinPromptForDetails  = "IT asked you to confirm these details. IT needs to enter the PIN to save."
	confirmGoneMessage   = "This confirmation is no longer valid. IT needs to enter the PIN to save."
	employeeIDNeedsIT    = "Changing the employee ID needs IT."
)

// PromptView is the answer to TakePrompt.
type PromptView struct {
	Show    bool   `json:"show"`
	Message string `json:"message"`
	// Confirm means IT's approval is at hand: save with ConfirmDetails, no PIN field, employee ID read-only.
	Confirm bool `json:"confirm"`
}

// TakePrompt tells the window whether to open "Update my details" with a message, and clears
// the flag, so the prompt shows once.
func (a *App) TakePrompt() PromptView {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.promptPending {
		return PromptView{}
	}
	a.promptPending = false
	if a.confirm != nil {
		return PromptView{Show: true, Message: confirmPromptMessage, Confirm: true}
	}
	return PromptView{Show: true, Message: pinPromptForDetails}
}

// ConfirmDetails saves the details the user confirmed after IT's request, with the request's approval
// code instead of the PIN. The employee ID must stay the same (the server checks too); the code works once.
func (a *App) ConfirmDetails(f UserForm) Result {
	a.mu.Lock()
	confirm := a.confirm
	a.mu.Unlock()
	if confirm == nil {
		return Result{Message: confirmGoneMessage, NeedsPin: true}
	}
	errs := validate(f, false)
	if st, err := a.svc.Status(); err == nil && st.User != nil && strings.TrimSpace(f.EmployeeID) != st.User.EmployeeID {
		errs["employeeId"] = employeeIDNeedsIT
	}
	if len(errs) > 0 {
		return Result{Message: "Please fix the highlighted fields.", FieldErrors: errs}
	}
	if !a.busy.TryLock() {
		return fail("Another action is still running. Please wait.")
	}
	defer a.busy.Unlock()
	if _, err := a.svc.ConfirmUser(a.ctx, userFromForm(f), *confirm); err != nil {
		var apiErr *api.Error
		if errors.As(err, &apiErr) {
			switch {
			case apiErr.Status == 403 && apiErr.Code == "pin_required":
				return Result{Message: employeeIDNeedsIT, FieldErrors: map[string]string{"employeeId": employeeIDNeedsIT}}
			case apiErr.Status == 403:
				a.dropConfirm(confirm)
				return Result{Message: confirmGoneMessage, NeedsPin: true}
			case apiErr.Status == 429:
				return fail("Too many wrong tries. Try again in a minute.")
			case apiErr.Status == 400:
				if fields := fieldErrorsFromDetails(apiErr); len(fields) > 0 {
					return Result{Message: "The server did not accept some of your details.", FieldErrors: fields}
				}
			}
		}
		return a.failure(err)
	}
	a.dropConfirm(confirm)
	return Result{OK: true, Message: "Your details were saved."}
}

// dropConfirm forgets a used or refused approval (unless a newer request already replaced it).
func (a *App) dropConfirm(c *payload.ConfirmApproval) {
	a.mu.Lock()
	if a.confirm == c {
		a.confirm = nil
	}
	a.mu.Unlock()
}

func (a *App) ready() {
	if a.OnReady != nil {
		a.OnReady()
	}
}

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

// State is also where IT setup is decided: it shows on a computer that is not registered yet, and again
// when IT starts re-registration from Settings. A registered computer always opens home.
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
	pending := a.pendingServer
	a.mu.Unlock()
	switch {
	case !a.needsKey(err == nil && status.Registered):
		st.Screen = "home"
	case pending != "":
		st.Screen, st.ServerURL = "signup", pending
	default:
		st.Screen = "setup"
	}
	return st
}

// needsKey says whether the setup screen asks for the enrollment key: on a computer that is not
// registered, or one being registered again.
func (a *App) needsKey(registered bool) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return !registered || a.reregistering
}

// Result is the common outcome of an action.
type Result struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	// FieldErrors maps form fields (fullName, employeeId, ...) to messages.
	FieldErrors map[string]string `json:"fieldErrors"`
	// NeedsReregistration means the server rejected this computer's token.
	NeedsReregistration bool `json:"needsReregistration"`
	// NeedsPin means the action did not run because the IT PIN is missing or was not accepted: ask for it.
	NeedsPin bool `json:"needsPin"`
	// NeedsKey means registration was refused for the enrollment key: go back to the key field.
	NeedsKey bool `json:"needsKey"`
}

var needPinResult = Result{Message: "Enter the IT PIN first.", NeedsPin: true, FieldErrors: map[string]string{"pin": "Enter the IT PIN"}}

func fail(msg string) Result { return Result{Message: msg} }

// CheckConnection is the IT setup step. It checks the server address and keeps the address and the
// enrollment key in memory for the signup that follows. The key is verified at signup; only its salted
// hash is saved (so Settings can open when the server is unreachable), never the key itself.
func (a *App) CheckConnection(serverURL, key string) Result {
	status, serr := a.svc.Status()
	if serr != nil {
		return fail("Could not read this computer's saved settings: " + serr.Error())
	}
	if !a.needsKey(status.Registered) {
		return fail("IT setup is already done on this computer. Use Settings.")
	}
	if strings.TrimSpace(key) == "" {
		return Result{Message: "Enter the enrollment key from IT.", FieldErrors: map[string]string{"key": "Required"}}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	u, err := a.svc.CheckConnection(ctx, serverURL)
	if err != nil {
		return a.connectionFailure(err, serverURL)
	}
	a.mu.Lock()
	a.pendingServer, a.pendingKey, a.keyFromPrompt = u, strings.TrimSpace(key), false
	a.mu.Unlock()
	// Best effort: show this server's agency name and logo on the setup and signup screens.
	a.refreshBranding(u)
	return Result{OK: true, Message: "Connected to " + u + "."}
}

// connectionFailure words a failed server check for IT.
func (a *App) connectionFailure(err error, serverURL string) Result {
	res := fail(friendly(err, serverURL))
	if strings.Contains(err.Error(), "cannot reach") {
		res.Message = "Cannot reach the server at " + serverURL + ". Make sure the PC_READER server is running (docker compose up -d on the server computer) and that this address is correct, e.g. http://192.168.1.10:3000."
	}
	if strings.Contains(err.Error(), "must be a URL") {
		res.FieldErrors = map[string]string{"serverUrl": "Use an address like http://192.168.1.10:3000"}
	}
	return res
}

// UnlockPrompt tells the Settings prompt what to ask for.
type UnlockPrompt struct {
	Mode    string `json:"mode"` // "pin" or "key"
	Message string `json:"message"`
}

const (
	pinPromptMessage        = "Enter the IT PIN shown on the PC_READER dashboard."
	offlinePromptMessage    = "Can't reach the server. Enter the enrollment key to change the server address."
	reregisterPromptMessage = "The server no longer recognises this computer. Enter the enrollment key to register it again."
)

// UnlockMode is what the Settings prompt asks for: the IT PIN, unless this computer has no usable
// registration with the server (it was rejected, or the token is gone), where the PIN could never be
// checked, or the server just failed to answer. Then the enrollment key (needed to register again
// anyway, and saved as a hash at IT setup) is asked for instead.
func (a *App) UnlockMode() UnlockPrompt {
	st, err := a.svc.Status()
	a.mu.Lock()
	defer a.mu.Unlock()
	reason := a.keyReason
	if a.connStatus == "reregister" || (err == nil && st.Registered && st.TokenErr != nil) {
		reason = reasonRejected
	}
	switch reason {
	case reasonRejected:
		return UnlockPrompt{Mode: modeKey, Message: reregisterPromptMessage}
	case reasonOffline:
		return UnlockPrompt{Mode: modeKey, Message: offlinePromptMessage}
	}
	return UnlockPrompt{Mode: modePin, Message: pinPromptMessage}
}

const (
	reasonOffline  = "offline"
	reasonRejected = "rejected"
)

// UnlockResult is the outcome of an unlock attempt; Mode is what to ask for next.
type UnlockResult struct {
	Result
	Mode string `json:"mode"`
}

// UnlockITSettings opens the IT settings for this window session. In "pin" mode the typed PIN goes to the
// server, which checks it against the current hourly PIN; when the server cannot answer (no reply, a
// timeout or a 5xx) the prompt switches to "key" mode, where the enrollment key is checked against the
// hash saved at IT setup. Five wrong tries in a row, counted across both modes, lock every attempt for
// 60 seconds (in memory, so closing the window resets it).
func (a *App) UnlockITSettings(secret string) UnlockResult {
	if msg, locked := a.lockout(); locked {
		return a.unlockFail(a.UnlockMode().Mode, msg)
	}

	mode := a.UnlockMode()
	if mode.Mode == modeKey {
		if mode.Message == reregisterPromptMessage {
			return a.startReregistrationWithKey(secret)
		}
		return a.unlockWithKey(secret)
	}
	pin := strings.TrimSpace(secret)
	if !pinFormat.MatchString(pin) {
		return a.unlockFail(modePin, "The IT PIN is 6 digits.")
	}
	ctx, cancel := context.WithTimeout(a.ctx, unlockTimeout)
	defer cancel()
	err := a.svc.UnlockSettings(ctx, pin)
	var apiErr *api.Error
	switch {
	case err == nil:
		return a.unlockOK(pin)
	case errors.Is(err, api.ErrUnauthorized), errors.Is(err, app.ErrNotRegistered), errors.Is(err, config.ErrNoToken):
		return a.switchToKey(reasonRejected, reregisterPromptMessage)
	case errors.As(err, &apiErr) && apiErr.Status == 403:
		return a.countWrong(modePin, "That PIN is not correct.")
	case errors.As(err, &apiErr) && apiErr.Status == 429:
		return a.unlockFail(modePin, "Too many wrong PINs. Try again in a minute.")
	case errors.As(err, &apiErr) && apiErr.Status < 500:
		// The server answered but not as a PC_READER server would; asking for the key will not help.
		return a.unlockFail(modePin, "The server did not accept the request: "+apiErr.Message)
	}
	// No reply, a timeout or a 5xx: the server cannot check the PIN.
	return a.switchToKey(reasonOffline, offlinePromptMessage)
}

var pinFormat = regexp.MustCompile(`^[0-9]{6}$`)

func (a *App) unlockFail(mode, msg string) UnlockResult {
	return UnlockResult{Result: Result{Message: msg, FieldErrors: map[string]string{"pin": msg}}, Mode: mode}
}

// unlockOK opens the IT session for unlockSession. pin is the PIN the server accepted, kept only in
// memory to send with the session's actions; "" for an unlock by enrollment key (Settings only).
func (a *App) unlockOK(pin string) UnlockResult {
	a.mu.Lock()
	a.unlockedUntil, a.sessionPin = a.now().Add(unlockSession), pin
	a.pinFailures, a.keyReason = 0, ""
	a.mu.Unlock()
	return UnlockResult{Result: Result{OK: true}, Mode: modePin}
}

// lockout says whether PIN prompts are refused right now, and why.
func (a *App) lockout() (string, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if left := a.lockedUntil.Sub(a.now()); left > 0 {
		return fmt.Sprintf("Too many wrong tries. Try again in %d seconds.", int(left/time.Second)+1), true
	}
	return "", false
}

// wrongTry counts a wrong PIN or key and returns the message to show; the fifth in a row starts the lockout.
func (a *App) wrongTry(msg string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sessionPin = "" // a PIN the server just refused is not worth keeping
	a.pinFailures++
	if a.pinFailures >= maxPinFailures {
		a.pinFailures, a.lockedUntil = 0, a.now().Add(pinLockout)
		return fmt.Sprintf("Too many wrong tries. Try again in %d seconds.", int(pinLockout/time.Second))
	}
	return fmt.Sprintf("%s %d tries left.", msg, maxPinFailures-a.pinFailures)
}

// countWrong counts a wrong PIN or key for the Settings prompt.
func (a *App) countWrong(mode, msg string) UnlockResult {
	return a.unlockFail(mode, a.wrongTry(msg))
}

// SessionView is the "Unlocked for IT" indicator: whether the app is unlocked and for how long.
type SessionView struct {
	Unlocked    bool `json:"unlocked"`
	SecondsLeft int  `json:"secondsLeft"`
	// HasPin is false after a key unlock: Settings are open but actions still need the PIN.
	HasPin bool `json:"hasPin"`
}

// Session reports the IT session; it is locked again after unlockSession.
func (a *App) Session() SessionView {
	a.mu.Lock()
	defer a.mu.Unlock()
	left := a.unlockedUntil.Sub(a.now())
	if left <= 0 {
		a.unlockedUntil, a.sessionPin = time.Time{}, ""
		return SessionView{}
	}
	return SessionView{Unlocked: true, SecondsLeft: int((left + time.Second - 1) / time.Second), HasPin: a.sessionPin != ""}
}

// actionPin is the PIN to send with an action: the one typed for it, else the session's. ok is false when
// there is none (or the session ran out), or when wrong tries have locked the prompt (msg says so).
func (a *App) actionPin(typed string) (pin, msg string, ok bool) {
	if m, locked := a.lockout(); locked {
		return "", m, false
	}
	if typed = strings.TrimSpace(typed); typed != "" {
		if !pinFormat.MatchString(typed) {
			return "", "The IT PIN is 6 digits.", false
		}
		return typed, "", true
	}
	if sv := a.Session(); sv.HasPin {
		a.mu.Lock()
		defer a.mu.Unlock()
		return a.sessionPin, "", true
	}
	return "", needPinResult.Message, false
}

// pinRefused turns the server's answer to a PIN-gated action into a result: a wrong PIN counts toward the
// lockout and asks again; too many tries says to wait. handled is false for any other error.
func (a *App) pinRefused(err error) (res Result, handled bool) {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return Result{}, false
	}
	switch {
	case apiErr.Status == 403 && apiErr.Code == "wrong_pin":
		msg := a.wrongTry("That PIN is not correct.")
		return Result{Message: msg, NeedsPin: true, FieldErrors: map[string]string{"pin": msg}}, true
	case apiErr.Status == 429:
		msg := "Too many wrong PINs. Try again in a minute."
		return Result{Message: msg, NeedsPin: true, FieldErrors: map[string]string{"pin": msg}}, true
	}
	return Result{}, false
}

const offlineActionMessage = "Can't reach the server. Try again when this computer is online."

// switchToKey makes the prompt ask for the enrollment key (the server could not check the PIN).
func (a *App) switchToKey(reason, msg string) UnlockResult {
	a.mu.Lock()
	a.keyReason = reason
	a.mu.Unlock()
	return UnlockResult{Result: Result{Message: msg}, Mode: modeKey}
}

// modeReregister is the Mode of an unlock result that went straight to re-registration.
const modeReregister = "reregister"

// startReregistrationWithKey is the key prompt when the server answered but rejected this computer's token
// (a wiped database, a revoked token). The local hash is not consulted: the typed key is kept in memory and
// the signup form opens, where the server checks the key and the IT PIN. Nothing is unlocked here.
func (a *App) startReregistrationWithKey(key string) UnlockResult {
	key = strings.TrimSpace(key)
	if key == "" {
		return a.unlockFail(modeKey, "Enter the enrollment key from IT.")
	}
	st, err := a.svc.Status()
	if err != nil {
		return a.unlockFail(modeKey, "Could not read this computer's saved settings: "+err.Error())
	}
	a.mu.Lock()
	a.reregistering, a.pendingServer, a.pendingKey, a.keyFromPrompt = true, st.ServerURL, key, true
	a.mu.Unlock()
	return UnlockResult{Result: Result{OK: true}, Mode: modeReregister}
}

// unlockWithKey checks the typed enrollment key against the saved hash. A computer without a saved
// hash cannot unlock this way; that is said plainly and does not count as a wrong try.
func (a *App) unlockWithKey(key string) UnlockResult {
	st, err := a.svc.Status()
	if err != nil {
		return a.unlockFail(modeKey, "Could not read this computer's saved settings: "+err.Error())
	}
	if st.EnrollmentKeyHash == nil {
		return a.unlockFail(modeKey, "This computer has no saved enrollment key, so Settings cannot be opened while the server is unreachable. Connect to the agency network and use the IT PIN, or ask IT to run IT setup again.")
	}
	if !st.EnrollmentKeyHash.Verify(key) {
		return a.countWrong(modeKey, "That enrollment key is not correct.")
	}
	a.svc.LogEvent("warning", "system", "IT settings were opened with the enrollment key (the server was unreachable)")
	res := a.unlockOK("")
	res.Mode = modeKey
	return res
}

// LockITSettings ends the IT session (and abandons a re-registration in progress). The shell calls it when
// the window is hidden.
func (a *App) LockITSettings() {
	a.mu.Lock()
	a.unlockedUntil, a.sessionPin = time.Time{}, ""
	a.reregistering, a.pendingServer, a.pendingKey, a.keyReason, a.keyFromPrompt = false, "", "", "", false
	a.mu.Unlock()
}

// ITSettings is what the unlocked IT settings screen shows. It is empty until unlocked, so the
// address cannot be read without the PIN.
type ITSettings struct {
	OK        bool   `json:"ok"`
	Message   string `json:"message"`
	ServerURL string `json:"serverUrl"`
}

func (a *App) ITSettings() ITSettings {
	if !a.isUnlocked() {
		return ITSettings{Message: "Enter the IT PIN first."}
	}
	st, err := a.svc.Status()
	if err != nil {
		return ITSettings{Message: "Could not read this computer's saved settings: " + err.Error()}
	}
	return ITSettings{OK: true, ServerURL: st.ServerURL}
}

func (a *App) isUnlocked() bool { return a.Session().Unlocked }

var errLocked = Result{Message: "Enter the IT PIN first."}

// SaveServerURL changes the server address after checking that the server answers there.
func (a *App) SaveServerURL(serverURL string) Result {
	if !a.isUnlocked() {
		return errLocked
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	u, err := a.svc.CheckConnection(ctx, serverURL)
	if err != nil {
		return a.connectionFailure(err, serverURL)
	}
	if err := a.svc.SetServerURL(u); err != nil {
		return fail("The server address could not be saved: " + err.Error())
	}
	a.ready() // reconnect the background connection to the new address
	return Result{OK: true, Message: "Saved. Connected to " + u + "."}
}

// StartReregistration returns to the IT setup screen (enrollment key and signup), with the saved
// details as the signup prefill. It needs Settings unlocked first (with the enrollment key when the
// server rejected this computer).
func (a *App) StartReregistration() State {
	if a.isUnlocked() {
		a.mu.Lock()
		a.reregistering, a.pendingServer, a.pendingKey = true, "", ""
		a.mu.Unlock()
	}
	return a.State()
}

// Signup scans, registers, uploads the first scan and saves everything. pin is the current IT PIN
// from the dashboard; the server checks it (after the enrollment key), and there is no offline fallback.
func (a *App) Signup(f UserForm, pin string) Result {
	errs := validate(f, true)
	pin, pinMsg, pinOK := a.actionPin(pin)
	if !pinOK {
		errs["pin"] = pinMsg
	}
	if len(errs) > 0 {
		msg := "Please fix the highlighted fields."
		if len(errs) == 1 && !pinOK {
			msg = pinMsg // only the PIN is wrong or locked: say why
		}
		return Result{Message: msg, FieldErrors: errs, NeedsPin: !pinOK}
	}
	a.mu.Lock()
	server, key, fromPrompt := a.pendingServer, a.pendingKey, a.keyFromPrompt
	a.mu.Unlock()
	if server == "" || key == "" {
		return fail("The server is not set up yet. Go back to the IT setup step.")
	}
	if !a.busy.TryLock() {
		return fail("Another action is still running. Please wait.")
	}
	defer a.busy.Unlock()

	res, err := a.svc.Register(a.ctx, app.RegisterInput{ServerURL: server, Key: key, PIN: pin, User: userFromForm(f), UploadFirstScan: true})
	if err != nil {
		if res, handled := a.pinRefused(err); handled {
			return res
		}
		var apiErr *api.Error
		if fromPrompt && errors.As(err, &apiErr) && apiErr.Status == 403 && apiErr.Code == "invalid_enrollment_key" {
			// A wrong key counts toward the shared lockout; the typed key is dropped so IT enters it again.
			msg := a.wrongTry("That enrollment key is not correct.")
			a.mu.Lock()
			a.pendingServer, a.pendingKey, a.keyFromPrompt = "", "", false
			a.mu.Unlock()
			return Result{Message: msg, NeedsKey: true}
		}
		return signupFailure(err, server)
	}
	out := Result{OK: true, Message: "Registered " + res.Hostname + "."}
	// Keep a salted hash of the key so Settings can open while the server is unreachable.
	if h, err := config.NewSecretHash(key); err != nil {
		out.Message += " The enrollment key could not be saved (" + err.Error() + "); Settings will need the server to open."
	} else if err := a.svc.SetEnrollmentKeyHash(h); err != nil {
		out.Message += " The enrollment key could not be saved (" + err.Error() + "); Settings will need the server to open."
	}
	a.mu.Lock()
	a.pendingServer, a.pendingKey, a.reregistering, a.keyReason, a.keyFromPrompt = "", "", false, "", false
	a.unlockedUntil, a.sessionPin, a.pinFailures = time.Time{}, "", 0
	a.mu.Unlock()
	a.ready()
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
	return fail(actionFriendly(err, server))
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

// ReportNow needs the IT session's PIN (NeedsPin tells the window to ask for it first).
func (a *App) ReportNow() ReportResult {
	pin, msg, ok := a.actionPin("")
	if !ok {
		return ReportResult{Result: Result{Message: msg, NeedsPin: true}, Home: Home{OK: true}}
	}
	if !a.busy.TryLock() {
		return ReportResult{Result: fail("Another action is still running. Please wait.")}
	}
	_, dup, _, err := a.svc.Report(a.ctx, "manual", pin)
	a.busy.Unlock()
	if err != nil {
		if res, handled := a.pinRefused(err); handled {
			return ReportResult{Result: res, Home: Home{OK: true}}
		}
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

// UpdateUser saves corrected details. A different employee ID hands the computer to that person. pin is
// the IT PIN typed on the form; empty uses the session's. The server checks it.
func (a *App) UpdateUser(f UserForm, pin string) Result {
	errs := validate(f, false)
	pin, pinMsg, pinOK := a.actionPin(pin)
	if !pinOK {
		errs["pin"] = pinMsg
	}
	if len(errs) > 0 {
		msg := "Please fix the highlighted fields."
		if len(errs) == 1 && !pinOK {
			msg = pinMsg // only the PIN is wrong or locked: say why
		}
		return Result{Message: msg, FieldErrors: errs, NeedsPin: !pinOK}
	}
	if !a.busy.TryLock() {
		return fail("Another action is still running. Please wait.")
	}
	defer a.busy.Unlock()
	if _, err := a.svc.UpdateUser(a.ctx, userFromForm(f), pin); err != nil {
		if res, handled := a.pinRefused(err); handled {
			return res
		}
		var apiErr *api.Error
		if errors.As(err, &apiErr) && apiErr.Status == 400 {
			if fields := fieldErrorsFromDetails(apiErr); len(fields) > 0 {
				return Result{Message: "The server did not accept some of your details.", FieldErrors: fields}
			}
		}
		return a.failure(err)
	}
	a.mu.Lock()
	if a.sessionPin == "" || !a.unlockedUntil.After(a.now()) {
		// The server accepted this PIN: it opens the IT session like the Settings prompt does.
		a.unlockedUntil, a.sessionPin, a.pinFailures = a.now().Add(unlockSession), pin, 0
	}
	a.mu.Unlock()
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
	return fail(actionFriendly(err, server))
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

// actionFriendly words a failed PIN-gated action. Unlike Settings, signup, Update my details and Report now
// have no offline fallback: without the server the PIN cannot be checked.
func actionFriendly(err error, server string) string {
	if strings.Contains(err.Error(), "cannot reach") {
		return offlineActionMessage
	}
	return friendly(err, server)
}

// friendly turns an error into a sentence for the user.
func friendly(err error, server string) string {
	var apiErr *api.Error
	switch {
	case errors.Is(err, api.ErrUnauthorized):
		return reregisterMessage
	case errors.As(err, &apiErr):
		switch {
		case apiErr.Status == 403 && apiErr.Code == "wrong_pin":
			return "That PIN is not correct."
		case apiErr.Status == 429:
			return "Too many wrong PINs. Try again in a minute."
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
