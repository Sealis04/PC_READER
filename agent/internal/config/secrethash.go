package config

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"
)

// HashIterations is the PBKDF2 work factor for new hashes; each stored hash records its own.
// It is a variable only so tests can lower it.
var HashIterations = 600_000

const hashAlgorithm = "pbkdf2-sha256"

// MaxSecretLength bounds what is hashed (the enrollment key is a long random string, not a password).
const MaxSecretLength = 256

// ErrSecretFormat means the secret is empty or too long to store a hash of.
var ErrSecretFormat = errors.New("the enrollment key must be 1 to 256 characters")

// SecretHash is a secret as stored in config.json: a salted, slow hash, never the secret itself.
// It holds the enrollment key's hash, which lets IT open Settings when the server is unreachable.
type SecretHash struct {
	Algorithm  string `json:"algorithm"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"` // base64, 16 random bytes
	Hash       string `json:"hash"` // base64, 32 bytes
}

// NewSecretHash hashes secret (surrounding spaces ignored) with a fresh random salt.
func NewSecretHash(secret string) (*SecretHash, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" || len(secret) > MaxSecretLength {
		return nil, ErrSecretFormat
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	sum, err := pbkdf2.Key(sha256.New, secret, salt, HashIterations, 32)
	if err != nil {
		return nil, err
	}
	return &SecretHash{
		Algorithm:  hashAlgorithm,
		Iterations: HashIterations,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Hash:       base64.StdEncoding.EncodeToString(sum),
	}, nil
}

// Verify reports whether secret matches, in constant time for the hash comparison.
func (p *SecretHash) Verify(secret string) bool {
	if p == nil || p.Algorithm != hashAlgorithm || p.Iterations < 1 {
		return false
	}
	secret = strings.TrimSpace(secret)
	if secret == "" || len(secret) > MaxSecretLength {
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
	got, err := pbkdf2.Key(sha256.New, secret, salt, p.Iterations, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}
