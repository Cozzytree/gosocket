package socket

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// Server exposes an HTTP websocket endpoint and routes messages to the hub.
type Server struct {
	hub      *Hub
	upgrader websocket.Upgrader

	OnConnect    func(c *Client, r *http.Request)
	OnDisconnect func(c *Client)
	OnMessage    func(c *Client, msg Packet)

	eventHandlers map[string]func(*Client, []json.RawMessage, func(...interface{}))
	mu            sync.RWMutex
}

func NewServer(checkOrigin func(*http.Request) bool) *Server {
	if checkOrigin == nil {
		checkOrigin = func(r *http.Request) bool { return true }
	}

	return &Server{
		hub: NewHub(),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin:     checkOrigin,
		},
		eventHandlers: make(map[string]func(*Client, []json.RawMessage, func(...interface{}))),
	}
}

// On registers a custom event handler for a specific event name.
func (s *Server) On(event string, handler func(c *Client, args []json.RawMessage, ack func(...interface{}))) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eventHandlers[event] = handler
}

func (s *Server) fireEvent(c *Client, event string, args []json.RawMessage, ackID *int) {
	s.mu.RLock()
	handler, ok := s.eventHandlers[event]
	s.mu.RUnlock()

	var ackFn func(...interface{})
	if ackID != nil {
		id := *ackID
		ackFn = func(resArgs ...interface{}) {
			c.Ack(id, resArgs...)
		}
	} else {
		ackFn = func(...interface{}) {} // no-op if no ack requested
	}

	if ok {
		handler(c, args, ackFn)
	}
}

func (s *Server) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}
	client := NewClient(conn, s)

	// Register before firing OnConnect so the client is visible in the hub
	// from the moment the callback runs.
	s.hub.Register(client)

	if s.OnConnect != nil {
		s.OnConnect(client, r)
	}

	client.run()
}

func (s *Server) Hub() *Hub {
	return s.hub
}
