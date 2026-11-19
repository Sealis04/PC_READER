package config

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
)

// NormalizeRecoveryKey is how the recovery key (the enrollment key since M7) is typed and hashed:
// surrounding spaces trimmed, upper-case, without dashes or spaces ("k7qm-2xrp 9wdf-h4tn" is
// "K7QM2XRP9WDFH4TN"). The server hashes the same form.
func NormalizeRecoveryKey(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '-' || unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToUpper(r)
	}, s)
}

// VerifyRecoveryKey checks a typed recovery key: its normalized form (hashes saved since M7 and pushed
// by the server), then as typed, so a hash saved at setup before M7 (of the raw key) keeps working.
func (p *SecretHash) VerifyRecoveryKey(typed string) bool {
	if n := NormalizeRecoveryKey(typed); n != "" && p.Verify(n) {
		return true
	}
	return p.Verify(typed)
}

// MaxHashIterations bounds a hash received from the server, so a bad value cannot stall the PC.
const MaxHashIterations = 10_000_000

// ParseSecretHash reads a recovery key hash sent by the server and checks its shape.
func ParseSecretHash(raw json.RawMessage) (*SecretHash, error) {
	var h SecretHash
	if err := json.Unmarshal(raw, &h); err != nil {
		return nil, err
	}
	if h.Algorithm != hashAlgorithm || h.Iterations < 1 || h.Iterations > MaxHashIterations {
		return nil, errors.New("unsupported recovery key hash")
	}
	salt, err := base64.StdEncoding.DecodeString(h.Salt)
	if err != nil || len(salt) < 8 {
		return nil, errors.New("invalid recovery key hash salt")
	}
	sum, err := base64.StdEncoding.DecodeString(h.Hash)
	if err != nil || len(sum) != 32 {
		return nil, errors.New("invalid recovery key hash")
	}
	return &h, nil
}
