package windows

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf16"

	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// Runner runs a command and returns its stdout.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// script queries every CIM class in one PowerShell process (starting PowerShell
// is the slow part) and prints {"<Class>": [instances...] | null}.
func script() string { return scriptFor(nil) }

// scriptFor is script limited to the named classes (all when only is empty).
func scriptFor(only []string) string {
	var b strings.Builder
	b.WriteString("$ErrorActionPreference = 'Stop'\n")
	b.WriteString("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n")
	// Windows PowerShell 5.1 otherwise serializes arrays as {"value":[...],"Count":n}.
	b.WriteString("try { Remove-TypeData System.Array -ErrorAction Stop } catch {}\n")
	b.WriteString("$classes = @(\n")
	for _, c := range selected(only) {
		props := "'" + strings.Join(strings.Split(c.Props, ","), "','") + "'"
		fmt.Fprintf(&b, "  @{ Name = '%s'; Namespace = '%s'; Props = @(%s) }\n", c.Name, c.Namespace, props)
	}
	b.WriteString(`)
$out = [ordered]@{}
foreach ($c in $classes) {
  try {
    $q = @{ ClassName = $c.Name }
    if ($c.Namespace) { $q.Namespace = $c.Namespace }
    $out[$c.Name] = @(Get-CimInstance @q | Select-Object -Property $c.Props)
  } catch {
    $out[$c.Name] = $null
  }
}
$out | ConvertTo-Json -Depth 4 -Compress
`)
	return b.String()
}

type class = struct {
	Name      string
	Namespace string
	Props     string
}

func selected(only []string) []class {
	if len(only) == 0 {
		return Classes
	}
	var out []class
	for _, c := range Classes {
		for _, n := range only {
			if c.Name == n {
				out = append(out, c)
			}
		}
	}
	return out
}

// encodedCommand is the UTF-16LE base64 form PowerShell's -EncodedCommand expects,
// which avoids quoting problems and execution-policy prompts for script files.
func encodedCommand(s string) string {
	units := utf16.Encode([]rune(s))
	buf := make([]byte, len(units)*2)
	for i, u := range units {
		buf[i*2] = byte(u)
		buf[i*2+1] = byte(u >> 8)
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// Collect runs the CIM query and netsh, returning one raw file per class.
func Collect(ctx context.Context, run Runner) (rd.Set, error) { return collect(ctx, run, nil) }

// CollectNetwork is Collect limited to the network classes and netsh (what ParseNetwork reads).
func CollectNetwork(ctx context.Context, run Runner) (rd.Set, error) {
	return collect(ctx, run, NetworkClasses)
}

func collect(ctx context.Context, run Runner, only []string) (rd.Set, error) {
	out, err := run(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(scriptFor(only)))
	if err != nil {
		return nil, fmt.Errorf("PowerShell CIM query failed: %w", err)
	}
	var byClass map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimPrefix(bytes.TrimSpace(out), []byte("\xef\xbb\xbf")), &byClass); err != nil {
		return nil, fmt.Errorf("PowerShell output is not JSON: %w", err)
	}
	raw := rd.Set{}
	for _, c := range selected(only) {
		var pretty bytes.Buffer
		data := byClass[c.Name]
		if len(data) == 0 {
			data = json.RawMessage("null")
		}
		if err := json.Indent(&pretty, data, "", "    "); err != nil {
			return nil, fmt.Errorf("%s: %w", c.Name, err)
		}
		pretty.WriteByte('\n')
		raw[c.Name+".json"] = pretty.Bytes()
	}
	// No Wi-Fi hardware or WLAN service: netsh fails, and the SSID stays null.
	wlan, _ := run(ctx, "netsh", "wlan", "show", "interfaces")
	raw[NetshFile] = wlan
	return raw, nil
}
