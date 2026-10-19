//go:build darwin

package autostart

import (
	"os"
	"path/filepath"
)

// Enable writes (or repairs) the current user's LaunchAgent for exe. launchd loads it at the
// next login; nothing is started now.
func Enable(exe string) error {
	dir, err := launchAgentsDir()
	if err != nil {
		return err
	}
	return writePlist(dir, exe)
}

// Disable removes the LaunchAgent.
func Disable() error {
	dir, err := launchAgentsDir()
	if err != nil {
		return err
	}
	return removePlist(dir)
}

// Enabled reports whether the LaunchAgent exists.
func Enabled() bool {
	dir, err := launchAgentsDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, AgentLabel+".plist"))
	return err == nil
}
