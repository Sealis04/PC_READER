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

// tray is the notification-area / menu-bar icon: "Open PC_READER", "Report now" and a status
// line. It has no quit item on purpose: the app runs until the user logs out.
//
// Windows: the tray's hidden window and the message loop that feeds it must live on the same OS
// thread, and Wails' OnStartup runs on a goroutine with no loop. So the tray gets its own
// goroutine, locked to one thread, running the library's own loop (systray.Run). Left-click
// (and double-click) opens the window; right-click shows the menu.
//
// macOS: Wails owns the main thread, so the tray joins it (RunWithExternalLoop).
type tray struct {
	open   func()
	report func()

	mu     sync.Mutex
	status *systray.MenuItem
	text   string
	end    func()
}

func newTray(open, report func()) *tray {
	return &tray{open: open, report: report, text: "Starting…"}
}

// runPinned runs fn on a goroutine locked to its own OS thread (what a Windows message loop needs).
func runPinned(fn func()) {
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		fn()
	}()
}

// Start adds the icon. Call it once the GUI loop is running (Wails' OnStartup).
func (t *tray) Start() {
	// Left-click / double-click opens the window; the right-click menu is the library default.
	systray.SetOnTapped(t.open)
	if runtime.GOOS == "windows" {
		t.mu.Lock()
		t.end = systray.Quit
		t.mu.Unlock()
		runPinned(func() { systray.Run(t.onReady, func() {}) })
		return
	}
	start, end := systray.RunWithExternalLoop(t.onReady, func() {})
	t.mu.Lock()
	t.end = end
	t.mu.Unlock()
	// nativeStart creates the NSStatusItem, which AppKit only allows on the main thread; Wails'
	// OnStartup runs on a goroutine. Later menu updates are marshalled by the library itself.
	runOnMainThread(start)
}

func (t *tray) onReady() {
	if runtime.GOOS == "windows" {
		systray.SetIcon(trayICO)
	} else {
		systray.SetTemplateIcon(trayPNG, trayPNG)
	}
	systray.SetTooltip("PC_READER")
	openItem := systray.AddMenuItem("Open PC_READER", "Show the PC_READER window")
	reportItem := systray.AddMenuItem("Report now", "Send this computer's details to IT now")
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
	go func() {
		for range reportItem.ClickedCh {
			t.report()
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
	t.mu.Lock()
	end := t.end
	t.mu.Unlock()
	if end != nil {
		end()
	}
}
