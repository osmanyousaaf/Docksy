// Package push sends reports to the Docksy server on a schedule, backing off
// on failure. Nothing is buffered: every attempt sends a freshly built report,
// so after an outage only the latest state is delivered.
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	MinInterval = time.Second
	MaxInterval = time.Hour
	// DefaultMaxBackoff caps the delay between failed attempts.
	DefaultMaxBackoff = 60 * time.Second
)

// Client posts one report.
type Client struct {
	URL       string // full report URL
	Token     string
	UserAgent string
	HTTP      *http.Client
}

// ReportURL turns a Docksy base URL into the agent report endpoint.
func ReportURL(base string) string {
	return strings.TrimRight(base, "/") + "/api/agent/v1/report"
}

// StatusError is a non-2xx answer from the server.
type StatusError struct {
	Code int
	Body string
}

func (e *StatusError) Error() string {
	if e.Code == http.StatusUnauthorized || e.Code == http.StatusForbidden {
		return fmt.Sprintf("server rejected the agent token (HTTP %d); re-provision the server to issue a new one", e.Code)
	}
	if e.Body != "" {
		return fmt.Sprintf("server answered HTTP %d: %s", e.Code, e.Body)
	}
	return fmt.Sprintf("server answered HTTP %d", e.Code)
}

// Send posts body and returns the server's requested interval (0 if absent).
func (c *Client) Send(ctx context.Context, body []byte) (time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(data))
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return 0, &StatusError{Code: resp.StatusCode, Body: msg}
	}
	var out struct {
		IntervalSec float64 `json:"intervalSec"`
	}
	if json.Unmarshal(data, &out) != nil || out.IntervalSec <= 0 {
		return 0, nil
	}
	return time.Duration(out.IntervalSec * float64(time.Second)), nil
}

// Backoff is the delay after `failures` consecutive failures: the interval,
// doubled per extra failure, capped at max.
func Backoff(interval time.Duration, failures int, max time.Duration) time.Duration {
	if max <= 0 {
		max = DefaultMaxBackoff
	}
	d := interval
	if d <= 0 {
		d = MinInterval
	}
	for i := 1; i < failures && d < max; i++ {
		d *= 2
	}
	return min(d, max)
}

// ClampInterval keeps a server-provided interval within sane bounds.
func ClampInterval(d time.Duration) time.Duration {
	return min(max(d, MinInterval), MaxInterval)
}

// Loop builds and sends a report every Interval until ctx is done.
type Loop struct {
	Client     *Client
	Interval   time.Duration
	MaxBackoff time.Duration
	Build      func(ctx context.Context) ([]byte, error)
	Logf       func(format string, args ...any)

	// Test hooks.
	Sleep func(ctx context.Context, d time.Duration) error
	Now   func() time.Time
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Run blocks until ctx is cancelled. It never gives up on the server.
func (l *Loop) Run(ctx context.Context) error {
	sleep, now, logf := l.Sleep, l.Now, l.Logf
	if sleep == nil {
		sleep = sleepCtx
	}
	if now == nil {
		now = time.Now
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	interval := ClampInterval(l.Interval)
	failures := 0
	for {
		start := now()
		body, err := l.Build(ctx)
		var next time.Duration
		if err == nil {
			next, err = l.Client.Send(ctx, body)
		}
		if ctx.Err() != nil {
			return nil
		}

		var wait time.Duration
		if err != nil {
			failures++
			wait = Backoff(interval, failures, l.MaxBackoff)
			logf("report failed (attempt %d): %v; retrying in %s", failures, err, wait)
		} else {
			if failures > 0 {
				logf("report delivered again after %d failed attempt(s)", failures)
			}
			failures = 0
			if next > 0 {
				if c := ClampInterval(next); c != interval {
					logf("server set report interval to %s", c)
					interval = c
				}
			}
			wait = interval - now().Sub(start)
		}
		if err := sleep(ctx, wait); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil
			}
			return err
		}
	}
}
