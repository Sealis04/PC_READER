package rawdata

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Str returns a trimmed string field, or nil when missing, null or blank.
func Str(m map[string]any, key string) *string {
	if m == nil {
		return nil
	}
	switch v := m[key].(type) {
	case string:
		return StrPtr(v)
	case float64:
		s := strconv.FormatFloat(v, 'f', -1, 64)
		return &s
	case json.Number:
		s := v.String()
		return &s
	}
	return nil
}

// Int returns an integer field (JSON number or numeric string), or nil.
func Int(m map[string]any, key string) *int64 {
	if m == nil {
		return nil
	}
	switch v := m[key].(type) {
	case float64:
		n := int64(v)
		return &n
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			return &n
		}
	}
	return nil
}

// Bool returns a boolean field, or nil.
func Bool(m map[string]any, key string) *bool {
	if m == nil {
		return nil
	}
	if v, ok := m[key].(bool); ok {
		return &v
	}
	return nil
}

// Strings returns a string array field (a lone string counts as one element).
func Strings(m map[string]any, key string) []string {
	out := []string{}
	if m == nil {
		return out
	}
	switch v := m[key].(type) {
	case []any:
		for _, e := range v {
			if s, ok := e.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
	case string:
		if strings.TrimSpace(v) != "" {
			out = append(out, strings.TrimSpace(v))
		}
	}
	return out
}

// StrPtr trims s and returns nil when it is empty.
func StrPtr(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func IntPtr(n int64) *int64 { return &n }
func BoolPtr(b bool) *bool  { return &b }

// Deref returns *s or "" for nil.
func Deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// NormalizeMAC upper-cases a MAC and uses colons, e.g. "d0-8e-79-00-00-01" -> "D0:8E:79:00:00:01".
// Returns nil if the input is not a 6-byte MAC.
func NormalizeMAC(s string) *string {
	s = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(s), "-", ":"))
	parts := strings.Split(s, ":")
	if len(parts) != 6 {
		return nil
	}
	for i, p := range parts {
		if len(p) == 1 {
			p = "0" + p
		}
		if len(p) != 2 || strings.Trim(p, "0123456789ABCDEF") != "" {
			return nil
		}
		parts[i] = p
	}
	out := strings.Join(parts, ":")
	return &out
}

// IsLinkLocal reports IPv6 link-local addresses (fe80::/10), which are left out of payloads.
func IsLinkLocal(ip string) bool {
	return strings.HasPrefix(strings.ToLower(ip), "fe80:")
}
