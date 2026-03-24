package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/Cozzytree/gosocket/internal/config"
	"github.com/Cozzytree/gosocket/pkg/socket"
)

func main() {
	addr := config.Addr()
	srv := socket.NewServer(nil)

	srv.OnConnect = func(c *socket.Client, r *http.Request) {
		// New connection
	}

	srv.On("headline", func(c *socket.Client, args []json.RawMessage, ack func(...interface{})) {
		log.Printf("Received headline from client: %s\n", string(args[0]))

		// Send an acknowledgment block back
		ack(map[string]interface{}{"status": "ok", "delivered": true})
	})

	http.HandleFunc("/ws", srv.ServeWS)
	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("socket server listening on %s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
