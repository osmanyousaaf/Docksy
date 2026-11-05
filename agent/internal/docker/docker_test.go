package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func loadStats(t *testing.T, name string) *Stats {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var s Stats
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return &s
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestCPUPercentDockerMath(t *testing.T) {
	// cgroup v2: delta 2e8 / 2e9 system * 4 cpus * 100 = 40%
	if got := CPUPercent(loadStats(t, "stats_cgroup2.json")); !near(got, 40) {
		t.Errorf("cgroup2 cpu = %v, want 40", got)
	}
	// cgroup v1 without online_cpus: falls back to len(percpu_usage)=2 → 1e8/1e9*2*100 = 20%
	if got := CPUPercent(loadStats(t, "stats_cgroup1.json")); !near(got, 20) {
		t.Errorf("cgroup1 cpu = %v, want 20", got)
	}
	// No system progress → 0, no division by zero.
	var s Stats
	s.CPUStats.CPUUsage.TotalUsage = 10
	if got := CPUPercent(&s); got != 0 {
		t.Errorf("zero system delta = %v", got)
	}
	// Counter going backwards (container restarted) never goes negative.
	s.PreCPUStats.CPUUsage.TotalUsage = 100
	s.CPUStats.SystemUsage, s.PreCPUStats.SystemUsage = 200, 100
	if got := CPUPercent(&s); got != 0 {
		t.Errorf("negative cpu delta = %v", got)
	}
}

func TestMemUsed(t *testing.T) {
	if got := MemUsed(loadStats(t, "stats_cgroup2.json")); got != 104857600-4194304 {
		t.Errorf("cgroup2 mem = %d", got)
	}
	if got := MemUsed(loadStats(t, "stats_cgroup1.json")); got != 104857600-20971520 {
		t.Errorf("cgroup1 mem = %d (must prefer total_inactive_file)", got)
	}
	if got := MemUsed(loadStats(t, "stats_first.json")); got != 1000 {
		t.Errorf("inactive > usage should fall back to usage, got %d", got)
	}
}

func TestNetTotals(t *testing.T) {
	rx, tx := NetTotals(loadStats(t, "stats_cgroup2.json"))
	if rx != 11000 || tx != 5500 {
		t.Errorf("net = %d/%d", rx, tx)
	}
}

// fakeDocker serves the fixture API; each stats call advances the counters.
func fakeDocker(t *testing.T) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	read := func(n string) []byte {
		b, err := os.ReadFile(filepath.Join("testdata", n))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	var statsCalls atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("all") != "1" {
			t.Errorf("list must ask for all=1")
		}
		w.Write(read("containers.json"))
	})
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.Split(strings.TrimPrefix(r.URL.Path, "/containers/"), "/")[0]
		switch {
		case strings.HasSuffix(r.URL.Path, "/json"):
			name := map[byte]string{'a': "inspect_web.json", 'b': "inspect_old.json", 'c': "inspect_flappy.json"}[id[0]]
			w.Write(read(name))
		case strings.HasSuffix(r.URL.Path, "/stats"):
			if r.URL.Query().Get("stream") != "false" {
				t.Errorf("stats must be one-shot (stream=false)")
			}
			if id[0] != 'a' {
				t.Errorf("stats requested for non-running container %s", id)
			}
			n := statsCalls.Add(1) - 1
			var s map[string]any
			json.Unmarshal(read("stats_cgroup2.json"), &s)
			s["read"] = time.Date(2026, 11, 1, 11, 0, 1+int(n)*2, 0, time.UTC).Format(time.RFC3339Nano)
			s["networks"] = map[string]any{"eth0": map[string]any{"rx_bytes": 10000 + n*4000, "tx_bytes": 5000 + n*2000}}
			json.NewEncoder(w).Encode(s)
		default:
			http.NotFound(w, r)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &statsCalls
}

func TestContainers(t *testing.T) {
	srv, calls := fakeDocker(t)
	c := New(srv.URL, srv.Client())

	cs, err := c.Containers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(cs) != 3 || calls.Load() != 1 {
		t.Fatalf("got %d containers, %d stats calls", len(cs), calls.Load())
	}
	web, old, flappy := cs[0], cs[1], cs[2]
	if web.ID != "aaaaaaaaaaaa" || web.Name != "dx-web-1a2b3c4d" || web.Image != "docksy/web:1a2b3c4d" ||
		web.State != "running" || web.Status != "Up 3 hours (healthy)" || web.Labels["docksy.app"] != "app_123" {
		t.Errorf("web = %+v", web)
	}
	if !near(web.CPUPercent, 40) || web.MemUsed != 104857600-4194304 || web.MemLimit != 2147483648 {
		t.Errorf("web usage = %+v", web)
	}
	if web.StartedAt == nil || *web.StartedAt != "2026-11-01T09:00:00.123456789Z" {
		t.Errorf("web startedAt = %v", web.StartedAt)
	}
	if web.NetRx != 0 || web.NetTx != 0 {
		t.Errorf("first scan has no rate yet: %v/%v", web.NetRx, web.NetTx)
	}
	if old.StartedAt != nil || old.Labels == nil || old.CPUPercent != 0 {
		t.Errorf("old = %+v (zero StartedAt must be null, labels non-nil)", old)
	}
	if flappy.RestartCount != 7 || flappy.State != "restarting" {
		t.Errorf("flappy = %+v", flappy)
	}

	// Second scan: +4000 rx / +2000 tx over 2s.
	cs, err = c.Containers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !near(cs[0].NetRx, 2000) || !near(cs[0].NetTx, 1000) {
		t.Errorf("rates = %v/%v, want 2000/1000", cs[0].NetRx, cs[0].NetTx)
	}
}

func TestStatsTimeoutDoesNotBlock(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) {
		var list []map[string]any
		for i := 0; i < 20; i++ {
			list = append(list, map[string]any{"Id": fmt.Sprintf("%064d", i), "Names": []string{"/c"}, "State": "running"})
		}
		json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/stats") {
			select { // hang until the client gives up
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
			return
		}
		w.Write([]byte(`{"RestartCount":1,"State":{}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := New(srv.URL, srv.Client())
	c.StatsTimeout = 100 * time.Millisecond
	c.Concurrency = 10
	start := time.Now()
	cs, err := c.Containers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Errorf("took %v; stats must run concurrently with a timeout", el)
	}
	if len(cs) != 20 || cs[5].RestartCount != 1 || cs[5].CPUPercent != 0 {
		t.Errorf("unexpected result %+v", cs[5])
	}
}

func TestListErrorIsReturned(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "permission denied", http.StatusForbidden)
	}))
	defer srv.Close()
	if _, err := New(srv.URL, srv.Client()).Containers(context.Background()); err == nil {
		t.Error("want error")
	}
}

func TestSocketFromEnv(t *testing.T) {
	t.Setenv("DOCKER_HOST", "unix:///run/user/1000/docker.sock")
	if got := SocketFromEnv(); got != "/run/user/1000/docker.sock" {
		t.Errorf("got %q", got)
	}
	t.Setenv("DOCKER_HOST", "tcp://1.2.3.4:2375")
	if got := SocketFromEnv(); got != DefaultSocket {
		t.Errorf("got %q", got)
	}
}
