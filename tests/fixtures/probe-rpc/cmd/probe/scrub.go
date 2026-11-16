package main

import (
	"io"
	"slices"
	"strings"
	"sync"
)

const redacted = "[redacted]"

const minSecret = 4

type scrubber struct {
	mu      sync.Mutex
	secrets []string
}

func (secrets *scrubber) add(values ...string) {
	secrets.mu.Lock()
	defer secrets.mu.Unlock()
	for _, value := range values {
		if len(value) >= minSecret && !slices.Contains(secrets.secrets, value) {
			secrets.secrets = append(secrets.secrets, value)
		}
	}
	slices.SortFunc(secrets.secrets, func(a, b string) int { return len(b) - len(a) })
}

func (secrets *scrubber) scrub(text string) string {
	secrets.mu.Lock()
	defer secrets.mu.Unlock()
	for _, secret := range secrets.secrets {
		text = strings.ReplaceAll(text, secret, redacted)
	}
	return text
}

func (secrets *scrubber) writer(next io.Writer) io.Writer {
	return writerFunc(func(data []byte) (int, error) {
		if _, err := io.WriteString(next, secrets.scrub(string(data))); err != nil {
			return 0, err
		}
		return len(data), nil
	})
}

type writerFunc func([]byte) (int, error)

func (write writerFunc) Write(data []byte) (int, error) { return write(data) }
