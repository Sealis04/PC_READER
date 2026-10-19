// Command pcreader-desktop is the PC_READER window: IT setup, signup, "My computer" and
// "Update my details". This directory is its own Go module (see go.mod) so that Wails'
// bindings generator, which compiles the package without any build tags, can build it; a
// build tag would hide main.go from it. The logic the window calls is in ../internal/bound.
//
// The app also runs in the background: it starts at login (hidden, tray only), holds the
// connection to the server and acts on dashboard requests (../internal/background). Closing the
// window only hides it; there is no quit item, so it runs until the user logs out.
package main

import (
	"context"
	"embed"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/autostart"
	"github.com/sealis04/pc_reader/agent/internal/background"
	"github.com/sealis04/pc_reader/agent/internal/bound"
	"github.com/sealis04/pc_reader/agent/internal/locallog"
)

//go:embed all:frontend/dist
var assets embed.FS

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

// removeAutostartFlag removes the start-at-login entry and exits (for testing: see agent/README.md).
const removeAutostartFlag = "--remove-autostart"

func hasArg(flag string) bool {
	for _, a := range os.Args[1:] {
		if a == flag {
			return true
		}
	}
	return false
}

// shell is the desktop app's background half: the tray, the connection and the window hooks.
type shell struct {
	svc  *app.Service
	app  *bound.App
	log  *locallog.Store
	tray *tray

	mu     sync.Mutex
	ctx    context.Context // Wails' context; nil until the window runtime started
	cancel context.CancelFunc
}

func (s *shell) wailsCtx() context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ctx
}

func (s *shell) showWindow() {
	ctx := s.wailsCtx()
	if ctx == nil {
		return
	}
	// Show works for a window hidden by --background or by the close button; the brief
	// always-on-top toggle brings it in front of other windows (focus-stealing rules on Windows).
	wruntime.WindowUnminimise(ctx)
	wruntime.WindowShow(ctx)
	wruntime.WindowSetAlwaysOnTop(ctx, true)
	wruntime.WindowSetAlwaysOnTop(ctx, false)
}

// reportNow is the tray's "Report now": the same scan and upload as the window's button.
func (s *shell) reportNow() {
	go func() {
		s.app.ReportNow()
		s.emit("reported")
	}()
}

func (s *shell) emit(event string) {
	if ctx := s.wailsCtx(); ctx != nil {
		wruntime.EventsEmit(ctx, event)
	}
}

// ready runs once IT setup or signup is done (and on launch of a set-up computer): turn on
// start-at-login and (re)start the background connection.
func (s *shell) ready() {
	if err := autostart.Ensure(); err != nil {
		_ = s.log.Add(locallog.Warning, locallog.System, "Start at login could not be turned on")
	}
	s.startRunner()
}

// startRunner replaces any running connection with a fresh one (new token, new server address).
func (s *shell) startRunner() {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.mu.Unlock()

	r := &background.Runner{
		Svc:     s.svc,
		Log:     s.log,
		Version: version,
		OnStatus: func(st background.Status) {
			s.tray.SetStatus(st.Label())
			s.app.SetConnection(string(st), st.Label())
			s.emit("connection")
		},
		OnPrompt: func() {
			s.app.RaisePrompt()
			s.showWindow()
			s.emit("prompt-details")
		},
	}
	go func() { _ = r.Run(ctx) }()
}

// openLog opens the local log, falling back to a temporary file so logging never blocks startup.
func openLog() *locallog.Store {
	if store, err := background.OpenLog(); err == nil {
		return store
	}
	store, err := locallog.Open(filepath.Join(os.TempDir(), "pcreader-"+locallog.DefaultFile))
	if err != nil {
		panic(err)
	}
	return store
}

func main() {
	if hasArg(removeAutostartFlag) {
		if err := autostart.Disable(); err != nil {
			println("error:", err.Error())
			os.Exit(1)
		}
		return
	}

	svc := app.New(version)
	s := &shell{svc: svc, log: openLog()}
	defer s.log.Close()
	svc.Log = func(level, category, message string) { _ = s.log.Add(level, category, message) }
	s.app = bound.New(svc, version)
	s.app.OnReady = s.ready
	s.tray = newTray(s.showWindow, s.reportNow)

	err := wails.Run(&options.App{
		Title:     "PC_READER",
		Width:     980,
		Height:    760,
		MinWidth:  720,
		MinHeight: 560,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		// Closing the window hides it; the app keeps running (tray) until the user logs out.
		HideWindowOnClose: true,
		// The start-at-login entry passes --background: tray only until the user opens the app.
		StartHidden: hasArg(autostart.BackgroundFlag),
		// Launching PC_READER again shows the window of the running copy.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "gov.ph.intramuros.pc-reader",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) { s.showWindow() },
		},
		OnStartup: func(ctx context.Context) {
			s.mu.Lock()
			s.ctx = ctx
			s.mu.Unlock()
			s.app.Startup(ctx)
			s.tray.Start()
			// A computer that is already set up (registered) connects at once.
			if st, err := svc.Status(); err == nil && st.Registered && st.TokenErr == nil {
				s.ready()
			}
		},
		OnShutdown: func(context.Context) {
			s.mu.Lock()
			if s.cancel != nil {
				s.cancel()
			}
			s.mu.Unlock()
			s.tray.Stop()
		},
		Bind:    []interface{}{s.app},
		Windows: &windows.Options{Theme: windows.SystemDefault},
		Mac:     &mac.Options{Appearance: mac.DefaultAppearance},
	})
	if err != nil {
		println("error:", err.Error())
	}
}
