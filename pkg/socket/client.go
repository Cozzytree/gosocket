package socket

import (
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 64 * 1024
)

// Client is a single websocket connection.
type Client struct {
	conn *websocket.Conn
	hub  *Hub
	send chan Envelope
	done chan struct{}

	closeOnce sync.Once
}

func NewClient(conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		conn: conn,
		hub:  hub,
		send: make(chan Envelope, 64),
		done: make(chan struct{}),
	}
}

func (c *Client) Run() {
	c.hub.Register(c)
	go c.writePump()
	c.readPump()
}

func (c *Client) Close() {
	c.closeOnce.Do(func() {
		c.hub.Unregister(c)
		close(c.done)
		_ = c.conn.Close()
	})
}

func (c *Client) readPump() {
	defer c.Close()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		var msg Envelope
		if err := c.conn.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws read error: %v", err)
			}
			break
		}

		switch msg.Type {
		case TypeSubscribe:
			if err := c.hub.Subscribe(c, msg.Room); err != nil {
				c.push(Envelope{Type: TypeError, Event: "subscribe_failed", Payload: []byte(`{"error":"room is required"}`)})
				continue
			}
			c.push(Envelope{Type: TypeInfo, Event: "subscribed", Room: msg.Room})
		case TypeUnsubscribe:
			c.hub.Unsubscribe(c, msg.Room)
			c.push(Envelope{Type: TypeInfo, Event: "unsubscribed", Room: msg.Room})
		case TypePublish:
			if msg.Event == "" {
				msg.Event = "message"
			}

			payloadType := msg.PayloadType
			if payloadType == "" {
				payloadType = PayloadTypeJSON
			}
			if err := validatePayload(msg.Payload, payloadType); err != nil {
				c.push(Envelope{Type: TypeError, Event: "publish_failed", Payload: errorPayload(err.Error())})
				continue
			}

			out := Envelope{
				Type:        TypeMessage,
				Room:        msg.Room,
				Event:       msg.Event,
				PayloadType: payloadType,
				Payload:     msg.Payload,
			}
			if err := c.hub.Publish(msg.Room, out); err != nil {
				c.push(Envelope{Type: TypeError, Event: "publish_failed", Payload: []byte(`{"error":"room is required"}`)})
			}
		default:
			c.push(Envelope{Type: TypeError, Event: "unknown_type", Payload: []byte(`{"error":"unknown message type"}`)})
		}
	}
}

func validatePayload(payload json.RawMessage, payloadType string) error {
	if !IsValidPayloadType(payloadType) {
		return errors.New("payloadType must be one of: json, text, binary")
	}

	if payloadType == PayloadTypeText || payloadType == PayloadTypeBinary {
		var val string
		if err := json.Unmarshal(payload, &val); err != nil {
			return errors.New("payload must be a JSON string when payloadType is '" + payloadType + "'")
		}
	}

	return nil
}

func errorPayload(message string) []byte {
	data, err := json.Marshal(map[string]string{"error": message})
	if err != nil {
		return []byte(`{"error":"internal error"}`)
	}
	return data
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteJSON(msg); err != nil {
				return
			}
		case <-c.done:
			return
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) push(msg Envelope) {
	select {
	case <-c.done:
		return
	case c.send <- msg:
	default:
		go c.Close()
	}
}
