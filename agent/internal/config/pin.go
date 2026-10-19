package config

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"regexp"
)

// PinIterations is the PBKDF2 work factor for new IT PINs; each stored hash records its own.
// It is a variable only so tests can lower it.
var PinIterations = 600_000

const pinAlgorithm = "pbkdf2-sha256"

var pinFormat = regexp.MustCompile(`^[0-9]{4,8}$`)

// ErrPinFormat means the PIN is not 4 to 8 digits.
var ErrPinFormat = errors.New("the PIN must be 4 to 8 digits")

// PinHash is the IT PIN as stored in config.json: a salted, slow hash, never the PIN.
type PinHash struct {
	Algorithm  string `json:"algorithm"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"` // base64, 16 random bytes
	Hash       string `json:"hash"` // base64, 32 bytes
}

// ValidPin reports whether pin is 4 to 8 digits.
func ValidPin(pin string) bool { return pinFormat.MatchString(pin) }

// NewPinHash hashes pin with a fresh random salt.
func NewPinHash(pin string) (*PinHash, error) {
	if !ValidPin(pin) {
		return nil, ErrPinFormat
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	sum, err := pbkdf2.Key(sha256.New, pin, salt, PinIterations, 32)
	if err != nil {
		return nil, err
	}
	return &PinHash{
		Algorithm:  pinAlgorithm,
		Iterations: PinIterations,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Hash:       base64.StdEncoding.EncodeToString(sum),
	}, nil
}

// Verify reports whether pin matches, in constant time for the hash comparison.
func (p *PinHash) Verify(pin string) bool {
	if p == nil || p.Algorithm != pinAlgorithm || p.Iterations < 1 {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(p.Salt)
	if err != nil {
		return false
	}
	want, err := base64.StdEncoding.DecodeString(p.Hash)
	if err != nil || len(want) == 0 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pin, salt, p.Iterations, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}
