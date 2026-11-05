//go:build !linux

package collect

import "errors"

// The agent only targets Linux; this keeps `go vet` happy elsewhere.
func statfs(string) (uint64, uint64, error) {
	return 0, 0, errors.New("statfs: unsupported platform")
}
