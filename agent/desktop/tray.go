package main

import (
	_ "embed"
	"runtime"
	"sync"

	"fyne.io/systray"
)

// The macOS menu bar wants a black template image; Windows wants an .ico.
var (
	//go:embed assets/tray.png
	trayPNG []byte
	//go:embed assets/tray.ico
	trayICO []byte
)

// tray is the notification-area / menu-bar icon: "Open PC_READER" and a status line. It has
// no quit item on purpose: the app runs until the user logs out.
//
// fyne.io/systray is used with RunWithExternalLoop so it does not start a loop of its own:
// Wails owns the main thread (required on macOS) and the tray joins it. On Windows the
// library runs its own message loop on a locked OS thread.
type tray struct {
	open func()

	mu     sync.Mutex
	status *systray.MenuItem
	text   string
	end    func()
}

func newTray(open func()) *tray { return &tray{open: open, text: "Starting…"} }

// Start adds the icon. Call it once the GUI loop is running (Wails' OnStartup).
func (t *tray) Start() {
	start, end := systray.RunWithExternalLoop(t.onReady, func() {})
	t.end = end
	start()
}

func (t *tray) onReady() {
	if runtime.GOOS == "windows" {
		systray.SetIcon(trayICO)
	} else {
		systray.SetTemplateIcon(trayPNG, trayPNG)
	}
	systray.SetTooltip("PC_READER")
	openItem := systray.AddMenuItem("Open PC_READER", "Show the PC_READER window")
	systray.AddSeparator()
	t.mu.Lock()
	t.status = systray.AddMenuItem(t.text, "")
	t.status.Disable()
	t.mu.Unlock()
	go func() {
		for range openItem.ClickedCh {
			t.open()
		}
	}()
}

// SetStatus changes the status line ("Connected", "Offline", ...). Safe before Start.
func (t *tray) SetStatus(text string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.text = text
	if t.status != nil {
		t.status.SetTitle(text)
	}
}

// Stop removes the icon (the app is exiting).
func (t *tray) Stop() {
	if t.end != nil {
		t.end()
	}
}
