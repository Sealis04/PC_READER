package darwin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// Runner runs a command and returns its stdout.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// CollectNetwork runs only the network commands (what ParseNetwork reads).
func CollectNetwork(ctx context.Context, run Runner) (rd.Set, error) {
	raw := rd.Set{}
	for _, o := range []struct {
		file string
		cmd  []string
	}{
		{PortsFile, []string{"/usr/sbin/networksetup", "-listallhardwareports"}},
		{IfconfigFile, []string{"/sbin/ifconfig"}},
		{RouteFile, []string{"/sbin/route", "-n", "get", "default"}},
		{DNSFile, []string{"/usr/sbin/scutil", "--dns"}},
	} {
		b, _ := run(ctx, o.cmd[0], o.cmd[1:]...)
		raw[o.file] = b
	}
	for _, p := range HardwarePorts(string(raw[PortsFile])) {
		if p.device == "" || strings.HasPrefix(p.device, "bridge") {
			continue
		}
		if b, err := run(ctx, "/usr/sbin/ipconfig", "getsummary", p.device); err == nil {
			raw[SummaryFile(p.device)] = b
		}
	}
	return raw, nil
}

// Collect runs system_profiler and the command-line tools, returning one raw file per source.
func Collect(ctx context.Context, run Runner) (rd.Set, error) {
	raw := rd.Set{}

	out, err := run(ctx, "/usr/sbin/system_profiler", append([]string{"-json", "-detailLevel", "full"}, DataTypes...)...)
	if err != nil {
		return nil, fmt.Errorf("system_profiler failed: %w", err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(out, &all); err != nil {
		return nil, fmt.Errorf("system_profiler output is not JSON: %w", err)
	}
	for _, t := range DataTypes {
		items := all[t]
		if len(items) == 0 {
			items = json.RawMessage("[]")
		}
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, []byte(fmt.Sprintf(`{%q:%s}`, t, items)), "", "  "); err != nil {
			return nil, fmt.Errorf("%s: %w", t, err)
		}
		pretty.WriteByte('\n')
		raw[t+".json"] = pretty.Bytes()
	}

	// One sysctl call per key: an unknown key (hw.cpufrequency on Apple Silicon) fails on its own.
	var sysctl bytes.Buffer
	for _, k := range SysctlKeys {
		if line, err := run(ctx, "/usr/sbin/sysctl", k); err == nil {
			sysctl.Write(line)
		}
	}
	raw[SysctlFile] = sysctl.Bytes()

	optional := []struct {
		file string
		cmd  []string
	}{
		{SwVersFile, []string{"/usr/bin/sw_vers"}},
		{ComputerNameFile, []string{"/usr/sbin/scutil", "--get", "ComputerName"}},
		{PortsFile, []string{"/usr/sbin/networksetup", "-listallhardwareports"}},
		{IfconfigFile, []string{"/sbin/ifconfig"}},
		{RouteFile, []string{"/sbin/route", "-n", "get", "default"}},
		{DNSFile, []string{"/usr/sbin/scutil", "--dns"}},
		{DFFile, []string{"/bin/df", "-k"}},
	}
	for _, o := range optional {
		b, _ := run(ctx, o.cmd[0], o.cmd[1:]...) // e.g. no default route when offline
		raw[o.file] = b
	}
	if len(bytes.TrimSpace(raw[ComputerNameFile])) == 0 {
		if b, err := run(ctx, "/bin/hostname", "-s"); err == nil {
			raw[ComputerNameFile] = b
		}
	}

	for _, p := range HardwarePorts(string(raw[PortsFile])) {
		if p.device == "" || strings.HasPrefix(p.device, "bridge") {
			continue
		}
		if b, err := run(ctx, "/usr/sbin/ipconfig", "getsummary", p.device); err == nil {
			raw[SummaryFile(p.device)] = b
		}
	}
	return raw, nil
}
