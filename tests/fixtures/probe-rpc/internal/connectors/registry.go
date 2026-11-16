package connectors

import "github.com/noresponsehq/noresponse/apps/identity/internal/connector"

type Need struct{ Egress string }
type Declaration struct {
	ID    string
	Known connector.Known
	Need  Need
}

var All = []Declaration{{ID: "github"}}

func Declared(id string) (Declaration, bool) { return All[0], id == "github" }
