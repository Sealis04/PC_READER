// Command pcreader-desktop is the PC_READER window: IT setup, signup, "My computer" and
// "Update my details". This directory is its own Go module (see go.mod) so that Wails'
// bindings generator, which compiles the package without any build tags, can build it; a
// build tag would hide main.go from it. The logic the window calls is in ../internal/bound.
package main

import (
	"context"
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/bound"
)

//go:embed all:frontend/dist
var assets embed.FS

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

// backgroundFlag is passed by the start-at-login entry: start hidden in the tray.
const backgroundFlag = "--background"

func hasArg(flag string) bool {
	for _, a := range os.Args[1:] {
		if a == flag {
			return true
		}
	}
	return false
}

func main() {
	a := bound.New(app.New(version), version)
	var ctx context.Context
	showWindow := func() {
		if ctx == nil {
			return
		}
		wruntime.WindowUnminimise(ctx)
		wruntime.WindowShow(ctx)
	}
	t := newTray(showWindow)
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
		StartHidden:       hasArg(backgroundFlag),
		// Launching PC_READER again shows the window of the running copy.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "gov.ph.intramuros.pc-reader",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) { showWindow() },
		},
		OnStartup: func(c context.Context) {
			ctx = c
			a.Startup(c)
			t.Start()
		},
		OnShutdown: func(context.Context) { t.Stop() },
		Bind:       []interface{}{a},
		Windows:    &windows.Options{Theme: windows.SystemDefault},
		Mac:        &mac.Options{Appearance: mac.DefaultAppearance},
	})
	if err != nil {
		println("error:", err.Error())
	}
}
