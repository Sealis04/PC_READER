// Package scan collects raw hardware data for the current OS and parses it into a payload.
package scan

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/payload"
	"github.com/sealis04/pc_reader/agent/internal/scan/darwin"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
	"github.com/sealis04/pc_reader/agent/internal/scan/windows"
)

const Timeout = 2 * time.Minute

// Exec runs a command, returning stdout; stderr is included in the error.
func Exec(ctx context.Context, name string, args ...string) ([]byte, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	hideWindow(cmd)
	if err := cmd.Run(); err != nil {
		msg := bytes.TrimSpace(stderr.Bytes())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return stdout.Bytes(), fmt.Errorf("%s: %w: %s", name, err, msg)
	}
	return stdout.Bytes(), nil
}

// OSType maps runtime.GOOS to the payload's os_type.
func OSType() (string, error) {
	switch runtime.GOOS {
	case "windows":
		return "windows", nil
	case "darwin":
		return "macos", nil
	}
	return "", fmt.Errorf("scanning is supported on Windows and macOS only (this is %s)", runtime.GOOS)
}

// CollectRaw runs this OS's scanner commands.
func CollectRaw(ctx context.Context) (rd.Set, error) {
	os, err := OSType()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	if os == "windows" {
		return windows.Collect(ctx, Exec)
	}
	return darwin.Collect(ctx, Exec)
}

// DetectOS tells which platform a raw set came from.
func DetectOS(raw rd.Set) (string, error) {
	switch {
	case raw["Win32_ComputerSystem.json"] != nil:
		return "windows", nil
	case raw["SPHardwareDataType.json"] != nil:
		return "macos", nil
	}
	return "", fmt.Errorf("raw data is neither Windows (Win32_ComputerSystem.json) nor macOS (SPHardwareDataType.json)")
}

// Parse turns a raw set from either platform into a payload.
func Parse(raw rd.Set, agentVersion string) (*payload.Scan, error) {
	os, err := DetectOS(raw)
	if err != nil {
		return nil, err
	}
	if os == "windows" {
		return windows.Parse(raw, agentVersion)
	}
	return darwin.Parse(raw, agentVersion)
}
