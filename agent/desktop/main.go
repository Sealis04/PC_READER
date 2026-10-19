//go:build desktop

// Command pcreader-desktop is the PC_READER window: IT setup, signup, "My computer" and
// "Update my details". It needs the Wails toolchain and the OS webview, so it is built only
// with `wails build` (which sets -tags desktop); the logic it calls is in ./bound.
package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"github.com/sealis04/pc_reader/agent/desktop/bound"
	"github.com/sealis04/pc_reader/agent/internal/app"
)

//go:embed all:frontend/dist
var assets embed.FS

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

func main() {
	a := bound.New(app.New(version), version)
	err := wails.Run(&options.App{
		Title:     "PC_READER",
		Width:     980,
		Height:    760,
		MinWidth:  720,
		MinHeight: 560,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: a.Startup,
		Bind:      []interface{}{a},
		Windows:   &windows.Options{Theme: windows.SystemDefault},
		Mac:       &mac.Options{Appearance: mac.DefaultAppearance},
	})
	if err != nil {
		println("error:", err.Error())
	}
}
