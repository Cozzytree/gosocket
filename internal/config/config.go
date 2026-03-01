package config

import "os"

func Addr() string {
	if v := os.Getenv("ADDR"); v != "" {
		return v
	}
	return ":8080"
}
