//go:build !windows && !darwin

package autostart

// Start at login is only implemented for Windows and macOS.

func Enable(string) error { return nil }
func Disable() error      { return nil }
func Enabled() bool       { return false }
