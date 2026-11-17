package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
)

type Token string
type Hex64 string
type V1 struct {
	V int `json:"v"`
}
type Success[T any] struct {
	OK    bool `json:"ok"`
	Value T    `json:"value"`
}
type Failure struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}
type WireSuccess[T any] struct {
	V1
	Success[T]
}
type WireFailure struct {
	V1
	Failure
}
type RelayAddress struct {
	Socket  string `json:"socket"`
	RelayID Token  `json:"relayId"`
}
type Owner struct {
	Host      string `json:"host"`
	SessionID string `json:"sessionId"`
}
type Recipient struct {
	ServerEpoch Token `json:"serverEpoch"`
	OpenID      Token `json:"openId"`
}
type Manifest struct {
	V1
	WireRevision int   `json:"wireRevision"`
	UIBuildID    Hex64 `json:"uiBuildId"`
	AssetDigest  Hex64 `json:"assetDigest"`
}
type Bootstrap struct {
	Manifest
	ServerEpoch Token `json:"serverEpoch"`
	ViewKey     Token `json:"viewKey"`
}
type UiIdentity struct {
	V1
	WireRevision int   `json:"wireRevision"`
	UIBuildID    Hex64 `json:"uiBuildId"`
}
type CodeRef struct {
	Kind   string `json:"kind"`
	OpenID Token  `json:"openId"`
}
type ChatRef struct {
	Kind   string `json:"kind"`
	PairID Token  `json:"pairId"`
}
type CodeApproval struct {
	Kind      string `json:"kind"`
	OpenID    Token  `json:"openId"`
	Method    string `json:"method"`
	Challenge Token  `json:"challenge"`
}
type ChatApproval = ChatRef
type ChatEnvelope struct {
	V1
	Kind      string       `json:"kind"`
	Relay     RelayAddress `json:"relay"`
	PairID    Token        `json:"pairId"`
	Secret    Token        `json:"secret"`
	ExpiresAt int64        `json:"expiresAt"`
}
type Binding struct {
	RelayID    Token           `json:"relayId"`
	Approval   json.RawMessage `json:"approval"`
	Recipient  Recipient       `json:"recipient"`
	Owner      Owner           `json:"owner"`
	Generation int64           `json:"generation"`
	Label      string          `json:"label"`
}
type Lease struct {
	Epoch int64 `json:"epoch"`
	ID    Token `json:"id"`
}
type Guard struct {
	RequestID  Token `json:"requestId"`
	RelayID    Token `json:"relayId"`
	GrantID    Token `json:"grantId"`
	Owner      Owner `json:"owner"`
	Generation int64 `json:"generation"`
	Lease      Lease `json:"lease"`
}
type Cursor struct {
	Generation int64  `json:"generation"`
	Revision   int64  `json:"revision"`
	LayoutRev  *int64 `json:"layoutRev"`
}

type HostApprove struct {
	V1
	Owner      Owner           `json:"owner"`
	Generation int64           `json:"generation"`
	Label      string          `json:"label"`
	Approval   json.RawMessage `json:"approval"`
}
type Approved struct {
	Relay     RelayAddress    `json:"relay"`
	Approval  json.RawMessage `json:"approval"`
	ExpiresAt int64           `json:"expiresAt"`
	Envelope  *ChatEnvelope   `json:"envelope"`
}
type ApprovalTarget struct {
	Kind     string          `json:"kind"`
	Approval json.RawMessage `json:"approval"`
}
type OperationTarget struct {
	Kind  string `json:"kind"`
	Scope Guard  `json:"scope"`
}
type GrantTarget struct {
	Kind    string `json:"kind"`
	GrantID Token  `json:"grantId"`
}
type GenerationTarget struct {
	Kind       string `json:"kind"`
	Owner      Owner  `json:"owner"`
	Generation int64  `json:"generation"`
}
type HostCheck struct {
	V1
	Target json.RawMessage `json:"target"`
}
type ApprovalChecked struct {
	Kind      string `json:"kind"`
	State     string `json:"state"`
	GrantID   *Token `json:"grantId"`
	ExpiresAt *int64 `json:"expiresAt"`
}
type OperationChecked struct {
	Kind string `json:"kind"`
}
type HostRevoke struct {
	V1
	Target json.RawMessage `json:"target"`
	Reason string          `json:"reason"`
}
type BrowserPairRequest struct {
	V1
	Generation int64 `json:"generation"`
}
type BrowserPairFrame struct {
	V1
	T          string `json:"t"`
	RequestID  Token  `json:"requestId"`
	Generation int64  `json:"generation"`
}
type BrowserPairAuthority struct {
	Owner      Owner  `json:"owner"`
	Generation int64  `json:"generation"`
	Label      string `json:"label"`
	PairID     Token  `json:"pairId"`
}
type HostBrowserPairReply struct {
	V1
	RequestID Token           `json:"requestId"`
	Result    json.RawMessage `json:"result"`
} // Success[BrowserPairAuthority] or Failure, no nested v

type CodeProof struct {
	Kind     string `json:"kind"`
	OpenID   Token  `json:"openId"`
	Method   string `json:"method"`
	Verifier Token  `json:"verifier"`
}
type ChatProof struct {
	Kind   string `json:"kind"`
	PairID Token  `json:"pairId"`
	Secret Token  `json:"secret"`
}
type Claim struct {
	V1
	RelayID   Token           `json:"relayId"`
	Recipient Recipient       `json:"recipient"`
	Proof     json.RawMessage `json:"proof"`
}
type Claimed struct {
	GrantID  Token   `json:"grantId"`
	GrantKey Token   `json:"grantKey"`
	Binding  Binding `json:"binding"`
}
type LeaseRequest struct {
	V1
	RelayID Token `json:"relayId"`
	Lease   Lease `json:"lease"`
	Active  bool  `json:"active"`
}
type RelayPull struct {
	V1
	RelayID Token   `json:"relayId"`
	Lease   Lease   `json:"lease"`
	Cursor  *Cursor `json:"cursor"`
}
type RelayPullNext struct {
	V1
	RelayID Token `json:"relayId"`
	Lease   Lease `json:"lease"`
	ReadID  Token `json:"readId"`
	Part    int   `json:"part"`
}
type RelayCommand struct {
	V1
	RelayID Token           `json:"relayId"`
	Lease   Lease           `json:"lease"`
	Request json.RawMessage `json:"request"`
} // existing CommandRequest
// grant credential requires grantKey in Authorization, not in this JSON.
type GrantCredential struct {
	Kind    string `json:"kind"`
	GrantID Token  `json:"grantId"`
}
type ProofCredential struct {
	Kind      string          `json:"kind"`
	Recipient Recipient       `json:"recipient"`
	Proof     json.RawMessage `json:"proof"`
}
type Release struct {
	V1
	RelayID    Token           `json:"relayId"`
	Reason     string          `json:"reason"`
	Credential json.RawMessage `json:"credential"`
}
type CurrentPart struct {
	ReadID Token             `json:"readId"`
	Part   int               `json:"part"`
	Parts  int               `json:"parts"`
	Cursor Cursor            `json:"cursor"`
	Events []json.RawMessage `json:"events"`
} // existing whole ServerEvents

type AppCurrent struct {
	V1
	T      string  `json:"t"`
	Scope  Guard   `json:"scope"`
	Cursor *Cursor `json:"cursor"`
}
type AppCommand struct {
	V1
	T       string          `json:"t"`
	Scope   Guard           `json:"scope"`
	Request json.RawMessage `json:"request"`
}
type CurrentFrameValue struct {
	Kind  string      `json:"kind"`
	Chunk CurrentPart `json:"chunk"`
}
type CommandFrameValue struct {
	Kind  string          `json:"kind"`
	Reply json.RawMessage `json:"reply"`
} // existing successful command reply
// Result = Success[CurrentFrameValue|CommandFrameValue] or Failure, WITHOUT nested v.
type HostAppReply struct {
	V1
	Scope  Guard           `json:"scope"`
	Result json.RawMessage `json:"result"`
}

type CompleteOpen struct {
	V1
	OpenID Token        `json:"openId"`
	Relay  RelayAddress `json:"relay"`
}
type Completed struct {
	Status string `json:"status"`
}
type AppMount struct {
	UiIdentity
	AssetDigest Hex64 `json:"assetDigest"`
	ServerEpoch Token `json:"serverEpoch"`
	ViewKey     Token `json:"viewKey"`
}
type AppReset = UiIdentity
type Detached struct {
	Kind string `json:"kind"`
} // exactly detached
type ResetView struct {
	Bootstrap Bootstrap `json:"bootstrap"`
	State     Detached  `json:"state"`
}
type AppAuth struct {
	V1
	ServerEpoch Token `json:"serverEpoch"`
	ViewKey     Token `json:"viewKey"`
	MountKey    Token `json:"mountKey"`
}
type Source struct {
	Owner Owner  `json:"owner"`
	Label string `json:"label"`
}
type Attached struct {
	Kind       string `json:"kind"`
	Generation int64  `json:"generation"`
	Source     Source `json:"source"`
}
type Unattached struct {
	Kind string `json:"kind"`
} // detached or pending
type Mounted struct {
	MountKey Token           `json:"mountKey"`
	State    json.RawMessage `json:"state"`
}
type AppPull struct {
	AppAuth
	Cursor *Cursor `json:"cursor"`
}
type Pulled struct {
	State  json.RawMessage   `json:"state"`
	Cursor *Cursor           `json:"cursor"`
	Events []json.RawMessage `json:"events"`
}
type AppCommandRequest struct {
	AppAuth
	Request json.RawMessage `json:"request"`
}
type AppPair struct {
	AppAuth
	Envelope ChatEnvelope `json:"envelope"`
}
type AppDetach = AppAuth
type AppUnmount = AppAuth

// decodeAppJSON rejects duplicate members, unknown members and absent fields.
// RawMessage unions are decoded again by their consuming branch.
func decodeAppJSON(raw []byte, dst any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := scanAppValue(d); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	if err := checkAppFields(raw, reflect.TypeOf(dst)); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return validateAppValues(reflect.ValueOf(dst))
}

func scanAppValue(d *json.Decoder) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	switch t {
	case json.Delim('{'):
		seen := map[string]bool{}
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return err
			}
			s, ok := k.(string)
			if !ok || seen[s] {
				return errors.New("duplicate JSON member")
			}
			seen[s] = true
			if err := scanAppValue(d); err != nil {
				return err
			}
		}
		_, err = d.Token()
		return err
	case json.Delim('['):
		for d.More() {
			if err := scanAppValue(d); err != nil {
				return err
			}
		}
		_, err = d.Token()
		return err
	}
	return nil
}

var rawMessageType = reflect.TypeOf(json.RawMessage{})

func appFields(t reflect.Type, fields map[string]reflect.Type) {
	for i := range t.NumField() {
		f := t.Field(i)
		if f.PkgPath != "" {
			continue
		}
		if f.Anonymous && f.Tag.Get("json") == "" {
			ft := f.Type
			if ft.Kind() == reflect.Pointer {
				ft = ft.Elem()
			}
			if ft.Kind() == reflect.Struct {
				appFields(ft, fields)
				continue
			}
		}
		name := strings.Split(f.Tag.Get("json"), ",")[0]
		if name == "-" {
			continue
		}
		if name == "" {
			name = f.Name
		}
		fields[name] = f.Type
	}
}

func checkAppFields(raw []byte, t reflect.Type) error {
	for t.Kind() == reflect.Pointer {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil
		}
		t = t.Elem()
	}
	if t == rawMessageType {
		return nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return errors.New("unexpected null")
	}
	switch t.Kind() {
	case reflect.Struct:
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(raw, &obj); err != nil {
			return err
		}
		if obj == nil {
			return errors.New("expected object")
		}
		fields := map[string]reflect.Type{}
		appFields(t, fields)
		for name, ft := range fields {
			v, ok := obj[name]
			if !ok {
				return fmt.Errorf("missing field %s", name)
			}
			if err := checkAppFields(v, ft); err != nil {
				return err
			}
		}
		for name := range obj {
			if _, ok := fields[name]; !ok {
				return fmt.Errorf("unknown field %s", name)
			}
		}
	case reflect.Slice, reflect.Array:
		var arr []json.RawMessage
		if err := json.Unmarshal(raw, &arr); err != nil {
			return err
		}
		for _, v := range arr {
			if err := checkAppFields(v, t.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateAppValues(v reflect.Value) error {
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return nil
		}
		return validateAppValues(v.Elem())
	}
	if v.Type() == rawMessageType {
		return nil
	}
	if v.Type() == reflect.TypeOf(Token("")) {
		s := v.String()
		b, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil || len(b) != 32 || base64.RawURLEncoding.EncodeToString(b) != s {
			return errors.New("invalid token")
		}
	}
	if v.Type() == reflect.TypeOf(Hex64("")) {
		s := v.String()
		b, err := hex.DecodeString(s)
		if err != nil || len(b) != 32 || hex.EncodeToString(b) != s {
			return errors.New("invalid digest")
		}
	}
	switch v.Kind() {
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Field(i).CanInterface() {
				if err := validateAppValues(v.Field(i)); err != nil {
					return err
				}
			}
		}
	case reflect.Slice, reflect.Array:
		for i := range v.Len() {
			if err := validateAppValues(v.Index(i)); err != nil {
				return err
			}
		}
	case reflect.Int, reflect.Int64:
		if v.Int() > 9007199254740991 || v.Int() < -9007199254740991 {
			return errors.New("unsafe integer")
		}
	}
	return nil
}
