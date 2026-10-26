//go:build !darwin

package main

// allowSystemQuit: only macOS needs it. On Windows, shutting down sends WM_QUERYENDSESSION, which Wails
// leaves to the default handler, so the app never blocks it.
func allowSystemQuit() {}
