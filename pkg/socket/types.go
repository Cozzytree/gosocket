package socket

import "encoding/json"

// Message Type matches Socket.IO Engine packet types (simplified for our demo)
const (
	MessageTypeEvent        = 2
	MessageTypeAck          = 3
	MessageTypeError        = 4 // Custom internal for error emitting
)

// Packet represents a parsed Socket.IO frame. 
// Typically: [Type, EventName, ...Args, AckID(optional)]
type Packet struct {
	Type   int
	Event  string
	Args   []json.RawMessage
	AckID  *int
}

// MarshalJSON converts the Packet back to a Socket.IO array structure
func (p Packet) MarshalJSON() ([]byte, error) {
	// A standard Socket.IO event array looks like:
	// ["event_name", arg1, arg2...]
	
	var arr []interface{}
	
	if p.Type == MessageTypeAck {
		if p.AckID == nil {
			return nil, nil // Invalid Ack
		}
		// Acks in some Socket.IO versions are just the array of args sent to the parser.
		// However, standard Engine.io prefixes it with packet type, but for simplicity
		// in gosocket, an Ack payload will simply be `[AckID, ...Args]` where AckID is negative to distinguish
		// or we can use the `event_name` space for `_ack_` to avoid breaking changes.
		// Let's use `_ack_` as the event for routing back to client's generic parser.
		arr = []interface{}{"_ack_", *p.AckID}
		for _, arg := range p.Args {
			arr = append(arr, arg)
		}
		return json.Marshal(arr)
	}

	arr = make([]interface{}, 0, 1+len(p.Args)+1)
	arr = append(arr, p.Event)
	for _, arg := range p.Args {
		arr = append(arr, arg)
	}
	
	return json.Marshal(arr)
}
