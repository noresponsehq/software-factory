package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/noresponsehq/noresponse/apps/identity/internal/connector"
	"github.com/noresponsehq/noresponse/apps/identity/internal/connectors"
)

func main() {
	if len(os.Args) != 3 {
		os.Exit(2)
	}
	id := os.Args[2]
	declaration, ok := connectors.Declared(id)
	if !ok {
		os.Exit(2)
	}
	if os.Args[1] == "control" {
		if declaration.Known.Valid() != nil || declaration.Known.Zero() {
			os.Exit(2)
		}
		_ = json.NewEncoder(os.Stdout).Encode(struct {
			Known      connector.Known `json:"known"`
			Trials     int             `json:"trials"`
			AdmittedMS int64           `json:"admitted_ms"`
		}{declaration.Known, connector.Trials, connector.Admitted.Milliseconds()})
		return
	}
	if os.Args[1] != "lookup" {
		os.Exit(2)
	}
	var request struct {
		By      string `json:"by"`
		Value   string `json:"value"`
		Session string `json:"session"`
		Proxies string `json:"proxies"`
	}
	if json.NewDecoder(io.LimitReader(os.Stdin, 65536)).Decode(&request) != nil {
		os.Exit(2)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	secrets := &scrubber{}
	inputs, err := readSession(request.Session, id, declaration.Need, secrets)
	if err != nil {
		os.Exit(2)
	}
	routes, err := readProxies(request.Proxies, declaration.Need.Egress, secrets)
	if err != nil {
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	asker, closeAll, err := bind(ctx, id, declaration.Need, inputs, routes, logger, false)
	if err != nil {
		os.Exit(2)
	}
	defer closeAll()
	result := lookUp(ctx, asker, connector.Query{By: request.By, Value: request.Value})
	_ = json.NewEncoder(os.Stdout).Encode(result)
}
