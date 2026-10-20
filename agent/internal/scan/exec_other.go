//go:build !windows

package scan

import "os/exec"

// hideWindow is only needed on Windows.
func hideWindow(*exec.Cmd) {}
