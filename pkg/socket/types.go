package socket

import "encoding/json"

// Envelope is the JSON message format used over the socket.
type Envelope struct {
	Type        string          `json:"type"`
	Room        string          `json:"room,omitempty"`
	Event       string          `json:"event,omitempty"`
	PayloadType string          `json:"payloadType,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
}

const (
	TypeSubscribe   = "subscribe"
	TypeUnsubscribe = "unsubscribe"
	TypePublish     = "publish"
	TypeMessage     = "message"
	TypeError       = "error"
	TypeInfo        = "info"
)

const (
	PayloadTypeJSON   = "json"
	PayloadTypeText   = "text"
	PayloadTypeBinary = "binary"
)

func IsValidPayloadType(payloadType string) bool {
	switch payloadType {
	case PayloadTypeJSON, PayloadTypeText, PayloadTypeBinary:
		return true
	default:
		return false
	}
}
