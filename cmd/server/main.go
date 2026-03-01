package main

import (
	"log"
	"net/http"

	"gosocket/internal/config"
	"gosocket/pkg/socket"
)

func main() {
	addr := config.Addr()
	srv := socket.NewServer(nil)

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
