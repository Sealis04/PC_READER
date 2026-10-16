package rawdata

import "testing"

func TestNormalizeMAC(t *testing.T) {
	cases := map[string]string{
		"d0-8e-79-00-00-01": "D0:8E:79:00:00:01",
		"f4:d4:88:0:0:3":    "F4:D4:88:00:00:03",
		"70:A8:D3:00:00:02": "70:A8:D3:00:00:02",
	}
	for in, want := range cases {
		if got := NormalizeMAC(in); got == nil || *got != want {
			t.Errorf("NormalizeMAC(%q) = %v, want %s", in, got, want)
		}
	}
	for _, bad := range []string{"", "N/A", "00:11:22:33:44", "zz:11:22:33:44:55"} {
		if got := NormalizeMAC(bad); got != nil {
			t.Errorf("NormalizeMAC(%q) = %q, want nil", bad, *got)
		}
	}
}

func TestJSONListAcceptsObjectOrArray(t *testing.T) {
	s := Set{"one.json": []byte(`{"a":1}`), "many.json": []byte(`[{"a":1},{"a":2}]`), "null.json": []byte("null"), "wrapped.json": []byte(`{"value":[{"a":1},{"a":2},{"a":3}],"Count":3}`)}
	for name, want := range map[string]int{"one.json": 1, "many.json": 2, "null.json": 0, "missing.json": 0, "wrapped.json": 3} {
		got, err := s.JSONList(name)
		if err != nil || len(got) != want {
			t.Errorf("%s: got %d items, err %v; want %d", name, len(got), err, want)
		}
	}
}
