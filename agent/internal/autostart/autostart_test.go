package autostart

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunCommandQuotesThePathAndAddsBackgroundFlag(t *testing.T) {
	got := runCommand(`C:\Program Files\PC_READER\pcreader-desktop.exe`)
	if got != `"C:\Program Files\PC_READER\pcreader-desktop.exe" --background` {
		t.Fatalf("got %s", got)
	}
}

func TestPlistRunsTheAppAtLoadInBackground(t *testing.T) {
	p := plist("/Applications/PC_READER.app/Contents/MacOS/pcreader-desktop")
	for _, want := range []string{
		"<string>" + AgentLabel + "</string>",
		"<string>/Applications/PC_READER.app/Contents/MacOS/pcreader-desktop</string>",
		"<string>--background</string>",
		"<key>RunAtLoad</key>\n  <true/>",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("plist is missing %q:\n%s", want, p)
		}
	}
	if !strings.Contains(plist("/a&b/app"), "/a&amp;b/app") {
		t.Fatal("path is not XML-escaped")
	}
}

func TestWriteAndRemovePlist(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "LaunchAgents")
	if err := writePlist(dir, "/x/app"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, AgentLabel+".plist")
	first, _ := os.Stat(path)
	if err := writePlist(dir, "/x/app"); err != nil { // unchanged: not rewritten
		t.Fatal(err)
	}
	second, _ := os.Stat(path)
	if !second.ModTime().Equal(first.ModTime()) {
		t.Fatal("rewrote an unchanged plist")
	}
	if err := writePlist(dir, "/moved/app"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); !strings.Contains(string(b), "/moved/app") {
		t.Fatal("moved app not repaired")
	}
	if err := removePlist(dir); err != nil {
		t.Fatal(err)
	}
	if err := removePlist(dir); err != nil { // already gone is fine
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("plist still there")
	}
}

func TestEnsureHonoursTheDisableSwitch(t *testing.T) {
	t.Setenv(EnvDisable, "1")
	if !Disabled() || Ensure() != nil {
		t.Fatal("Ensure must do nothing when disabled")
	}
}

func TestWritingThePlistRemovesTheLegacyOne(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, LegacyAgentLabel+".plist")
	if err := os.WriteFile(legacy, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writePlist(dir, "/x/app"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatal("the old LaunchAgent plist is still there")
	}
	if _, err := os.Stat(filepath.Join(dir, AgentLabel+".plist")); err != nil {
		t.Fatal("the new plist was not written")
	}
	if AgentLabel == LegacyAgentLabel {
		t.Fatal("the label must have changed")
	}
}

func TestRemovePlistAlsoRemovesTheLegacyOne(t *testing.T) {
	dir := t.TempDir()
	for _, l := range []string{AgentLabel, LegacyAgentLabel} {
		if err := os.WriteFile(filepath.Join(dir, l+".plist"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := removePlist(dir); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("left behind: %v", entries)
	}
}
