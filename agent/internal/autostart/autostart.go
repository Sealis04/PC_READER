// Package autostart makes PC_READER start when the user logs in: a per-user Run entry on Windows
// (HKCU\Software\Microsoft\Windows\CurrentVersion\Run) and a per-user LaunchAgent on macOS
// (~/Library/LaunchAgents). It needs no administrator rights. The entry starts the app with
// --background so it stays in the tray until the user opens it.
package autostart

import (
	"fmt"
	"html"
	"os"
	"path/filepath"
	"strings"
)

// BackgroundFlag is passed by the login entry: start hidden in the tray.
const BackgroundFlag = "--background"

// EnvDisable turns start-at-login off for testing: when set to 1, Ensure does nothing.
const EnvDisable = "PCREADER_NO_AUTOSTART"

// Name is the Run value name (Windows) and the LaunchAgent label (macOS).
const (
	RunValueName = "PC_READER"
	AgentLabel   = "ph.gov.intramuros.pcreader"
)

// Disabled reports whether start-at-login is switched off by the environment.
func Disabled() bool { return os.Getenv(EnvDisable) == "1" }

// Ensure enables start-at-login for the running executable (called on every launch, so a
// moved app or a removed entry is repaired) unless it is disabled by the environment.
func Ensure() error {
	if Disabled() {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	return Enable(exe)
}

// runCommand is the Windows Run value: the quoted path and the background flag.
func runCommand(exe string) string { return `"` + exe + `" ` + BackgroundFlag }

// plist is the macOS LaunchAgent that opens the app at login.
func plist(exe string) string {
	var b strings.Builder
	fmt.Fprintf(&b, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>%s</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`, AgentLabel, html.EscapeString(exe), BackgroundFlag)
	return b.String()
}

// writePlist writes the LaunchAgent into dir (~/Library/LaunchAgents) if it differs.
func writePlist(dir, exe string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, AgentLabel+".plist")
	want := plist(exe)
	if cur, err := os.ReadFile(path); err == nil && string(cur) == want {
		return nil
	}
	return os.WriteFile(path, []byte(want), 0o644)
}

func removePlist(dir string) error {
	err := os.Remove(filepath.Join(dir, AgentLabel+".plist"))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func launchAgentsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents"), nil
}
