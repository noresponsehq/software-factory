package connectors

import "github.com/noresponsehq/noresponse/apps/identity/internal/connector"

type Network string

func (network Network) String() string { return string(network) }

type Egress struct{ Network Network }

func (egress Egress) Direct() bool { return egress.Network == "" }

type Need struct{ Egress Egress }
type Declaration struct {
	ID    string
	Known connector.Known
	Need  Need
}

var All = []Declaration{{ID: "github"}}

func Declared(id string) (Declaration, bool) {
	if id == "residential" {
		return Declaration{ID: id, Need: Need{Egress: Egress{Network: "residential"}}}, true
	}
	return All[0], id == "github"
}
