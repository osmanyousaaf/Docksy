package push

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBackoff(t *testing.T) {
	iv := 10 * time.Second
	want := []time.Duration{10 * time.Second, 20 * time.Second, 40 * time.Second, 60 * time.Second, 60 * time.Second}
	for i, w := range want {
		if got := Backoff(iv, i+1, 60*time.Second); got != w {
			t.Errorf("failures=%d: got %s want %s", i+1, got, w)
		}
	}
	if got := Backoff(2*time.Minute, 1, 60*time.Second); got != 60*time.Second {
		t.Errorf("interval above cap: %s", got)
	}
	if got := Backoff(time.Second, 100, 0); got != DefaultMaxBackoff {
		t.Errorf("default cap: %s", got)
	}
}

func TestReportURL(t *testing.T) {
	for _, base := range []string{"https://docksy.example.com", "https://docksy.example.com/"} {
		if got := ReportURL(base); got != "https://docksy.example.com/api/agent/v1/report" {
			t.Errorf("%q → %q", base, got)
		}
	}
}

// TestLoopBackoffAndInterval drives the loop against an httptest server that
// fails three times, then succeeds and asks for a 5s interval.
func TestLoopBackoffAndInterval(t *testing.T) {
	var mu sync.Mutex
	var bodies []string
	attempt := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/agent/v1/report" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer dsa_test" {
			t.Errorf("auth header = %q", got)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type = %q", ct)
		}
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		attempt++
		n := attempt
		mu.Unlock()
		if n <= 3 {
			http.Error(w, `{"error":"down"}`, http.StatusServiceUnavailable)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "intervalSec": 5})
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var sleeps []time.Duration
	built := 0
	clock := time.Unix(0, 0)
	l := &Loop{
		Client:     &Client{URL: ReportURL(srv.URL), Token: "dsa_test", HTTP: srv.Client()},
		Interval:   10 * time.Second,
		MaxBackoff: 60 * time.Second,
		Build: func(context.Context) ([]byte, error) {
			built++
			return []byte(`{"n":` + string(rune('0'+built)) + `}`), nil
		},
		Now: func() time.Time { return clock },
		Sleep: func(ctx context.Context, d time.Duration) error {
			sleeps = append(sleeps, d)
			if len(sleeps) == 5 {
				cancel()
				return ctx.Err()
			}
			return nil
		},
	}
	if err := l.Run(ctx); err != nil {
		t.Fatal(err)
	}
	want := []time.Duration{10 * time.Second, 20 * time.Second, 40 * time.Second, 5 * time.Second, 5 * time.Second}
	if len(sleeps) != len(want) {
		t.Fatalf("sleeps = %v", sleeps)
	}
	for i := range want {
		if sleeps[i] != want[i] {
			t.Errorf("sleep[%d] = %s, want %s (all: %v)", i, sleeps[i], want[i], sleeps)
		}
	}
	// Each attempt sends a fresh report: no replay of stale buffered ones.
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 5 || bodies[0] != `{"n":1}` || bodies[3] != `{"n":4}` {
		t.Errorf("bodies = %v", bodies)
	}
}

func TestLoopSubtractsCollectionTime(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"intervalSec":10}`))
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	clock := time.Unix(0, 0)
	var got time.Duration
	l := &Loop{
		Client:   &Client{URL: srv.URL, Token: "t", HTTP: srv.Client()},
		Interval: 10 * time.Second,
		Build: func(context.Context) ([]byte, error) {
			clock = clock.Add(1500 * time.Millisecond) // docker stats take a while
			return []byte(`{}`), nil
		},
		Now:   func() time.Time { return clock },
		Sleep: func(ctx context.Context, d time.Duration) error { got = d; cancel(); return ctx.Err() },
	}
	l.Run(ctx)
	if got != 8500*time.Millisecond {
		t.Errorf("wait = %s, want 8.5s", got)
	}
}

func TestLoopBuildErrorBacksOff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var sleeps []time.Duration
	l := &Loop{
		Client:   &Client{URL: "http://127.0.0.1:1/never", Token: "t"},
		Interval: 30 * time.Second,
		Build:    func(context.Context) ([]byte, error) { return nil, errors.New("boom") },
		Sleep: func(ctx context.Context, d time.Duration) error {
			sleeps = append(sleeps, d)
			if len(sleeps) == 3 {
				cancel()
				return ctx.Err()
			}
			return nil
		},
	}
	l.Run(ctx)
	if len(sleeps) != 3 || sleeps[0] != 30*time.Second || sleeps[1] != 60*time.Second || sleeps[2] != 60*time.Second {
		t.Errorf("sleeps = %v", sleeps)
	}
}

func TestSendErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := &Client{URL: srv.URL, Token: "bad", HTTP: srv.Client()}
	_, err := c.Send(context.Background(), []byte(`{}`))
	var se *StatusError
	if !errors.As(err, &se) || se.Code != 401 || !strings.Contains(err.Error(), "token") {
		t.Errorf("err = %v", err)
	}
}

func TestClampInterval(t *testing.T) {
	if ClampInterval(0) != MinInterval || ClampInterval(5*time.Hour) != MaxInterval || ClampInterval(7*time.Second) != 7*time.Second {
		t.Error("clamp")
	}
}
