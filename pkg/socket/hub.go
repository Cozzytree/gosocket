package socket

import (
	"errors"
	"sync"
)

var ErrRoomRequired = errors.New("room is required")

// Hub manages connected clients and room membership.
type Hub struct {
	mu      sync.RWMutex
	rooms   map[string]map[*Client]struct{}
	clients map[*Client]struct{}
}

func NewHub() *Hub {
	return &Hub{
		rooms:   make(map[string]map[*Client]struct{}),
		clients: make(map[*Client]struct{}),
	}
}

func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
}

func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	delete(h.clients, c)
	for room, members := range h.rooms {
		if _, ok := members[c]; ok {
			delete(members, c)
			if len(members) == 0 {
				delete(h.rooms, room)
			}
		}
	}
}

func (h *Hub) Subscribe(c *Client, room string) error {
	if room == "" {
		return ErrRoomRequired
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.rooms[room]; !ok {
		h.rooms[room] = make(map[*Client]struct{})
	}
	h.rooms[room][c] = struct{}{}
	return nil
}

func (h *Hub) Unsubscribe(c *Client, room string) {
	if room == "" {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if members, ok := h.rooms[room]; ok {
		delete(members, c)
		if len(members) == 0 {
			delete(h.rooms, room)
		}
	}
}

// IsMember reports whether c is currently subscribed to room.
func (h *Hub) IsMember(c *Client, room string) bool {
	if room == "" {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.rooms[room][c]
	return ok
}

func (h *Hub) Publish(room string, msg []byte) error {
	if room == "" {
		return ErrRoomRequired
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	members := h.rooms[room]
	for c := range members {
		select {
		case <-c.done:
			// Client is closing; remove asynchronously.
			go c.Close()
		case c.send <- msg:
		default:
			// Slow client; remove asynchronously.
			go c.Close()
		}
	}

	return nil
}
