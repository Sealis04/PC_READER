package locallog

import (
	"path/filepath"
	"strings"
	"testing"
)

func openTest(t *testing.T, limit int) *Store {
	t.Helper()
	s, err := open(filepath.Join(t.TempDir(), DefaultFile), limit)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestAddNextDelete(t *testing.T) {
	s := openTest(t, Cap)
	for _, m := range []string{"a", "b", "c"} {
		if err := s.Add(Info, System, m); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.Next(2)
	if err != nil || len(got) != 2 || got[0].Message != "a" || got[1].Message != "b" || got[0].ID >= got[1].ID {
		t.Fatalf("Next(2) = %+v, %v", got, err)
	}
	if got[0].LoggedAt.IsZero() || got[0].Level != Info || got[0].Category != System {
		t.Fatalf("fields not stored: %+v", got[0])
	}
	if err := s.Delete([]int64{got[0].ID}); err != nil {
		t.Fatal(err)
	}
	rest, _ := s.Next(10)
	if len(rest) != 2 || rest[0].Message != "b" {
		t.Fatalf("after delete: %+v", rest)
	}
}

func TestIDsKeepIncreasingAfterDeletingEverything(t *testing.T) {
	s := openTest(t, Cap)
	_ = s.Add(Info, System, "one")
	first, _ := s.Next(1)
	_ = s.Delete([]int64{first[0].ID})
	_ = s.Add(Info, System, "two")
	second, _ := s.Next(1)
	if second[0].ID <= first[0].ID {
		t.Fatalf("id reused: %d then %d", first[0].ID, second[0].ID)
	}
}

func TestCapDropsOldestWithWarning(t *testing.T) {
	s := openTest(t, 10)
	for i := 0; i < 10; i++ {
		_ = s.Add(Info, System, "m"+string(rune('0'+i)))
	}
	if n, _ := s.Count(); n != 10 {
		t.Fatalf("count = %d, want 10", n)
	}
	if err := s.Add(Info, Scan, "new"); err != nil {
		t.Fatal(err)
	}
	n, _ := s.Count()
	if n != 10 {
		t.Fatalf("count after trim = %d, want the cap (10)", n)
	}
	all, _ := s.Next(20)
	last, prev := all[len(all)-1], all[len(all)-2]
	if last.Level != Warning || !strings.Contains(last.Message, "dropped the 2 oldest") {
		t.Fatalf("last entry = %+v, want the trim warning", last)
	}
	if prev.Message != "new" || all[0].Message != "m2" {
		t.Fatalf("unexpected contents: first %q, before warning %q", all[0].Message, prev.Message)
	}
}

func TestLongMessagesAreTruncatedToTheContractLimit(t *testing.T) {
	s := openTest(t, Cap)
	_ = s.Add(Info, System, strings.Repeat("x", 5000))
	got, _ := s.Next(1)
	if len(got[0].Message) != 1000 {
		t.Fatalf("len = %d", len(got[0].Message))
	}
}

func TestReopenKeepsEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), DefaultFile)
	s, _ := Open(path)
	_ = s.Add(Info, System, "kept")
	_ = s.Close()
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if got, _ := s2.Next(5); len(got) != 1 || got[0].Message != "kept" {
		t.Fatalf("got %+v", got)
	}
}
