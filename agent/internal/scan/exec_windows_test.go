//go:build windows

package scan

import (
	"os/exec"
	"testing"
)

func TestHideWindowSetsNoWindowFlags(t *testing.T) {
	cmd := exec.Command("cmd.exe")
	hideWindow(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatalf("console window not hidden: %+v", cmd.SysProcAttr)
	}
}
