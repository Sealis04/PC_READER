// Package contract gives tests access to the shared JSON Schemas and fixtures in ../contracts.
package contract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Dir is the absolute path of the repository's contracts/ directory.
func Dir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "contracts")
}

func Fixture(rel string) string { return filepath.Join(Dir(), "fixtures", rel) }

var (
	once    sync.Once
	schemas map[string]*jsonschema.Schema
	initErr error
)

func load() {
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	files := map[string]string{
		"payload":  "scan-payload.v1.schema.json",
		"register": "agent-api/register.request.schema.json",
		"scans":    "agent-api/scans.request.schema.json",
		// network.request $refs network-snapshot, so both are loaded.
		"network":          "agent-api/network.request.schema.json",
		"network-snapshot": "agent-api/network-snapshot.schema.json",
		"logs":             "agent-api/logs.request.schema.json",
		"request-complete": "agent-api/request-complete.request.schema.json",
		"events-message":   "agent-api/events.message.schema.json",
	}
	// Register every schema under its $id so cross-file $refs resolve offline.
	for _, rel := range files {
		doc, err := readJSON(filepath.Join(Dir(), rel))
		if err != nil {
			initErr = err
			return
		}
		id, _ := doc.(map[string]any)["$id"].(string)
		if err := c.AddResource(id, doc); err != nil {
			initErr = err
			return
		}
	}
	schemas = map[string]*jsonschema.Schema{}
	for name, rel := range files {
		doc, _ := readJSON(filepath.Join(Dir(), rel))
		id, _ := doc.(map[string]any)["$id"].(string)
		s, err := c.Compile(id)
		if err != nil {
			initErr = err
			return
		}
		schemas[name] = s
	}
}

func readJSON(path string) (any, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return jsonschema.UnmarshalJSON(bytes.NewReader(b))
}

// Validate checks a Go value (marshalled to JSON) against a named schema: payload, register or scans.
func Validate(schema string, v any) error {
	once.Do(load)
	if initErr != nil {
		return initErr
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(b))
	if err != nil {
		return err
	}
	s, ok := schemas[schema]
	if !ok {
		return fmt.Errorf("unknown schema %q", schema)
	}
	return s.Validate(doc)
}
