package socket

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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
	ID     string
	conn   *websocket.Conn
	server *Server
	send   chan []byte
	done   chan struct{}

	rooms     []string
	closeOnce sync.Once
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// fallback: timestamp-based, should never happen
		return hex.EncodeToString([]byte(time.Now().String()))
	}
	return hex.EncodeToString(b)
}

func NewClient(conn *websocket.Conn, server *Server) *Client {
	return &Client{
		ID:     newID(),
		conn:   conn,
		server: server,
		send:   make(chan []byte, 64),
		done:   make(chan struct{}),
	}
}

// run is the internal entry point called by ServeWS after hub registration and OnConnect.
func (c *Client) run() {
	go c.writePump()
	c.readPump()
}

func (c *Client) Close() {
	c.closeOnce.Do(func() {
		if c.server.OnDisconnect != nil {
			c.server.OnDisconnect(c)
		}
		c.server.hub.Unregister(c)
		close(c.done)
		_ = c.conn.Close()
	})
}

func (c *Client) Join(room string) error {
	return c.server.hub.Subscribe(c, room)
}

func (c *Client) Leave(room string) {
	c.server.hub.Unsubscribe(c, room)
}

func (c *Client) Emit(event string, args ...interface{}) {
	rawArgs := make([]json.RawMessage, len(args))
	for i, arg := range args {
		b, _ := json.Marshal(arg)
		rawArgs[i] = b
	}

	p := Packet{
		Type:  MessageTypeEvent,
		Event: event,
		Args:  rawArgs,
	}

	b, _ := p.MarshalJSON()
	c.push(b)
}

func (c *Client) Ack(id int, args ...interface{}) {
	rawArgs := make([]json.RawMessage, len(args))
	for i, arg := range args {
		b, _ := json.Marshal(arg)
		rawArgs[i] = b
	}

	p := Packet{
		Type:  MessageTypeAck,
		AckID: &id,
		Args:  rawArgs,
	}

	b, _ := p.MarshalJSON()
	c.push(b)
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
		_, rawMsg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws read error: %v", err)
			}
			break
		}

		// Parse custom Socket.IO-like array: ["event", arg1, arg2...]
		var arr []json.RawMessage
		if err := json.Unmarshal(rawMsg, &arr); err != nil {
			continue // ignore invalid
		}
		if len(arr) == 0 {
			continue
		}

		// Protocol:
		//   no ack:   ["eventName", ...args]
		//   with ack: [ackID, "eventName", ...args]   (ackID is a positive integer)
		var ackID *int
		offset := 0

		var potentialAck int
		if err := json.Unmarshal(arr[0], &potentialAck); err == nil {
			// First element is a number → it is the ack ID.
			ackID = &potentialAck
			offset = 1
		}

		if len(arr) <= offset {
			continue
		}

		var eventName string
		if err := json.Unmarshal(arr[offset], &eventName); err != nil {
			continue // expected a string event name
		}

		args := arr[offset+1:]

		packet := Packet{
			Type:  MessageTypeEvent,
			Event: eventName,
			Args:  args,
			AckID: ackID,
		}

		if c.server.OnMessage != nil {
			c.server.OnMessage(c, packet)
		}

		// Fire targeted event callback if registered on Server.
		c.server.fireEvent(c, eventName, args, ackID)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Close()
	}()

	for {
		select {
		case msg := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-c.done:
			// Send a clean WebSocket close frame before exiting.
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			_ = c.conn.WriteMessage(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			)
			return
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) push(msg []byte) {
	select {
	case <-c.done:
		return
	case c.send <- msg:
	default:
		go c.Close()
	}
}
