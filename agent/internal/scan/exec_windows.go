//go:build windows

package scan

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

// hideWindow stops Windows opening a console window for each command the desktop app starts.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
