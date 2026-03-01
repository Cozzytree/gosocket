package socket

import (
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

// Server exposes an HTTP websocket endpoint and routes messages to the hub.
type Server struct {
	hub      *Hub
	upgrader websocket.Upgrader
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
	}
}

func (s *Server) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}
	client := NewClient(conn, s.hub)
	client.Run()
}

func (s *Server) Hub() *Hub {
	return s.hub
}
