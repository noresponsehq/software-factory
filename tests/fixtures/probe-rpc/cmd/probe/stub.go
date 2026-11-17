package main

import (
	"context"
	"errors"
	"github.com/noresponsehq/noresponse/apps/identity/internal/connector"
	"github.com/noresponsehq/noresponse/apps/identity/internal/connectors"
	"log/slog"
)

type Reading struct {
	Found   bool                `json:"found"`
	Fields  []string            `json:"fields"`
	Values  map[string][]string `json:"values,omitempty"`
	Sources []string            `json:"sources,omitempty"`
}
type Lookup struct {
	Reading
	Error  string `json:"error,omitempty"`
	Cause  string `json:"cause,omitempty"`
	TookMS int64  `json:"took_ms"`
}

func readSession(string, string, connectors.Need, *scrubber) (any, error) { return nil, nil }
func readProxies(path string, egress connectors.Egress, _ *scrubber) (any, error) {
	if egress.Direct() && path != "" || !egress.Direct() && path == "" {
		return nil, errors.New("wrong proxy path")
	}
	return nil, nil
}
func bind(context.Context, string, connectors.Need, any, any, *slog.Logger, bool) (any, func(), error) {
	return nil, func() {}, nil
}
func lookUp(_ context.Context, _ any, q connector.Query) *Lookup {
	if q.Value == "network_failure_fixture" {
		return &Lookup{Reading: Reading{Fields: []string{}}, Error: "unavailable", Cause: "private failure detail"}
	}
	return &Lookup{Reading: Reading{Found: true, Fields: []string{"identifier", "id"}, Values: map[string][]string{"identifier": {q.Value}, "id": {"independent-id-9"}}, Sources: []string{"https://example.invalid/profile/" + q.Value}}, Cause: "private debug detail", TookMS: 1}
}
