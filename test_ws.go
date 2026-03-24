package main

// test_ws.go is a self-contained demo/integration server that exercises every
// feature of the gosocket library: callbacks, rooms, acks, broadcast, and
// disconnect cleanup.
//
// Run with:
//
//	go run test_ws.go

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/Cozzytree/gosocket/pkg/socket"
)

// connectedClients tracks the live connection count for the /stats endpoint.
var connectedClients atomic.Int64

func main() {
	srv := socket.NewServer(nil)

	// -------------------------------------------------------------------------
	// OnConnect – fires after the client is registered in the hub.
	// -------------------------------------------------------------------------
	srv.OnConnect = func(c *socket.Client, r *http.Request) {
		connectedClients.Add(1)
		log.Printf("[connect]  id=%s  remote=%s  total=%d",
			c.ID, r.RemoteAddr, connectedClients.Load())

		// Welcome the client immediately.
		c.Emit("welcome", map[string]interface{}{
			"id":      c.ID,
			"message": "connected to gosocket",
			"time":    time.Now().UTC().Format(time.RFC3339),
		})
	}

	// -------------------------------------------------------------------------
	// OnDisconnect – fires on any close (client-initiated or network error).
	// -------------------------------------------------------------------------
	srv.OnDisconnect = func(c *socket.Client) {
		connectedClients.Add(-1)
		log.Printf("[disconnect] id=%s  total=%d", c.ID, connectedClients.Load())
	}

	// -------------------------------------------------------------------------
	// OnMessage – raw catch-all before targeted handlers run.
	// -------------------------------------------------------------------------
	srv.OnMessage = func(c *socket.Client, msg socket.Packet) {
		log.Printf("[message]  id=%s  event=%q  args=%d", c.ID, msg.Event, len(msg.Args))
	}

	// -------------------------------------------------------------------------
	// subscribe – join a room, ack back with confirmation.
	// -------------------------------------------------------------------------
	srv.On("subscribe", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		if len(args) == 0 {
			ack(map[string]interface{}{"ok": false, "error": "room name required"})
			return
		}
		var room string
		if err := json.Unmarshal(args[0], &room); err != nil || room == "" {
			ack(map[string]interface{}{"ok": false, "error": "invalid room name"})
			return
		}
		if err := c.Join(room); err != nil {
			ack(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		log.Printf("[subscribe] id=%s  room=%q", c.ID, room)
		ack(map[string]interface{}{"ok": true, "room": room})
	})

	// -------------------------------------------------------------------------
	// unsubscribe – leave a room.
	// -------------------------------------------------------------------------
	srv.On("unsubscribe", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		if len(args) == 0 {
			ack(map[string]interface{}{"ok": false, "error": "room name required"})
			return
		}
		var room string
		if err := json.Unmarshal(args[0], &room); err != nil || room == "" {
			ack(map[string]interface{}{"ok": false, "error": "invalid room name"})
			return
		}
		c.Leave(room)
		log.Printf("[unsubscribe] id=%s  room=%q", c.ID, room)
		ack(map[string]interface{}{"ok": true, "room": room})
	})

	// -------------------------------------------------------------------------
	// broadcast – publish a payload to all members of a room.
	// Expects: ["broadcast", roomName, payload]
	// -------------------------------------------------------------------------
	srv.On("broadcast", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		if len(args) < 2 {
			ack(map[string]interface{}{"ok": false, "error": "usage: broadcast <room> <payload>"})
			return
		}
		var room string
		if err := json.Unmarshal(args[0], &room); err != nil || room == "" {
			ack(map[string]interface{}{"ok": false, "error": "invalid room"})
			return
		}
		if !srv.Hub().IsMember(c, room) {
			ack(map[string]interface{}{"ok": false, "error": "not a member of room " + room})
			return
		}
		// Build the outgoing packet: ["message", {from, payload}]
		type broadcastMsg struct {
			From    string          `json:"from"`
			Payload json.RawMessage `json:"payload"`
		}
		payload, _ := json.Marshal(broadcastMsg{From: c.ID, Payload: args[1]})
		frame, _ := (&socket.Packet{
			Type:  socket.MessageTypeEvent,
			Event: "message",
			Args:  []json.RawMessage{payload},
		}).MarshalJSON()
		if err := srv.Hub().Publish(room, frame); err != nil {
			ack(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		log.Printf("[broadcast] id=%s  room=%q", c.ID, room)
		ack(map[string]interface{}{"ok": true, "room": room})
	})

	// -------------------------------------------------------------------------
	// headline – demo event: server logs it and acks delivery.
	// -------------------------------------------------------------------------
	srv.On("headline", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		if len(args) == 0 {
			ack(map[string]interface{}{"ok": false, "error": "no payload"})
			return
		}
		log.Printf("[headline] id=%s  payload=%s", c.ID, string(args[0]))
		ack(map[string]interface{}{"ok": true, "delivered": true, "by": c.ID})
	})

	// -------------------------------------------------------------------------
	// ping – simple round-trip latency check.
	// -------------------------------------------------------------------------
	srv.On("ping", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		ack(map[string]interface{}{"pong": true, "time": time.Now().UnixMilli()})
	})

	// -------------------------------------------------------------------------
	// HTTP routes
	// -------------------------------------------------------------------------
	mux := http.NewServeMux()

	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		srv.ServeWS(w, r)
	})

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = fmt.Fprintln(w, "ok")
	})

	mux.HandleFunc("GET /stats", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"connected": connectedClients.Load(),
		})
	})

	addr := ":8080"
	log.Printf("gosocket demo server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
