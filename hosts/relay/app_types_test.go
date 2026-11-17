package main

import "testing"

func TestDecodeAppJSONStrict(t *testing.T) {
	const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	valid := `{"v":1,"relayId":"` + token + `","lease":{"epoch":1,"id":"` + token + `"},"cursor":null}`
	var q RelayPull
	if err := decodeAppJSON([]byte(valid), &q); err != nil {
		t.Fatalf("valid: %v", err)
	}
	for _, raw := range []string{
		`{"v":1,"v":1,"relayId":"` + token + `","lease":{"epoch":1,"id":"` + token + `"},"cursor":null}`,
		`{"v":1,"relayId":"` + token + `","lease":{"epoch":1,"id":"` + token + `","extra":0},"cursor":null}`,
		`{"v":1,"relayId":"` + token + `","lease":{"epoch":1,"id":"` + token + `"}}`,
		`{"v":1,"relayId":"` + token + `","lease":null,"cursor":null}`,
		`{"v":1,"relayId":"` + token + `","lease":{"epoch":9007199254740992,"id":"` + token + `"},"cursor":null}`,
		valid + ` {}`,
	} {
		if err := decodeAppJSON([]byte(raw), &q); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
