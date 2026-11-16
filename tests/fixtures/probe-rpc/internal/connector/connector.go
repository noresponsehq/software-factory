package connector

import "time"

type Known struct {
	By, Present, Absent         string
	Fields                      []string
	Supplied, PresentOnly, Paid bool
}

func (Known) Valid() error { return nil }
func (Known) Zero() bool   { return false }

const Trials = 5
const Admitted = 5 * time.Second

type Query struct{ By, Value string }
