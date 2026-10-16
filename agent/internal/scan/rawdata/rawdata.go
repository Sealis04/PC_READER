// Package rawdata holds unprocessed scanner command output, keyed by file name
// (e.g. "Win32_Processor.json", "sysctl.txt"), matching contracts/fixtures/raw/<os>/.
package rawdata

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Set map[string][]byte

// Load reads every file in dir into a Set.
func Load(dir string) (Set, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	set := Set{}
	for _, e := range entries {
		if e.IsDir() || strings.EqualFold(e.Name(), "README.md") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		set[e.Name()] = b
	}
	return set, nil
}

// Save writes every entry of the set into dir.
func (s Set) Save(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for name, b := range s {
		if err := os.WriteFile(filepath.Join(dir, filepath.Base(name)), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (s Set) Names() []string {
	names := make([]string, 0, len(s))
	for n := range s {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func (s Set) Text(name string) string {
	return strings.ReplaceAll(string(s[name]), "\r\n", "\n")
}

// JSONList decodes a file holding either one object or an array of objects
// (PowerShell's ConvertTo-Json emits a bare object for single instances).
func (s Set) JSONList(name string) ([]map[string]any, error) {
	b := s[name]
	trimmed := strings.TrimSpace(string(b))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var list []map[string]any
		if err := json.Unmarshal(b, &list); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		return list, nil
	}
	var one map[string]any
	if err := json.Unmarshal(b, &one); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	// Windows PowerShell 5.1 can wrap arrays as {"value": [...], "Count": n}.
	if inner, ok := one["value"].([]any); ok && len(one) == 2 && one["Count"] != nil {
		list := make([]map[string]any, 0, len(inner))
		for _, e := range inner {
			if m, ok := e.(map[string]any); ok {
				list = append(list, m)
			}
		}
		return list, nil
	}
	return []map[string]any{one}, nil
}

// JSONObject decodes a file holding a single JSON object.
func (s Set) JSONObject(name string) (map[string]any, error) {
	list, err := s.JSONList(name)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return list[0], nil
}
