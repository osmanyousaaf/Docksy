// Package docker is a tiny Docker Engine API client over the unix socket,
// just enough to list containers with their live resource usage.
package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/osmanyousaaf/docksy/agent/internal/report"
)

const (
	// DefaultSocket is where dockerd listens on every distro we support.
	DefaultSocket = "/var/run/docker.sock"
	maxBody       = 32 << 20
)

// Client talks to the Docker Engine API. It remembers each container's last
// network counters so it can report bytes/s.
type Client struct {
	HTTP         *http.Client
	Base         string        // "http://docker" for the unix socket
	StatsTimeout time.Duration // per container, default 3s
	Concurrency  int           // parallel inspect+stats calls, default 8
	Now          func() time.Time

	mu   sync.Mutex
	prev map[string]netSample
}

type netSample struct {
	rx, tx uint64
	at     time.Time
}

// SocketFromEnv honours DOCKER_HOST=unix:///path, falling back to the default socket.
func SocketFromEnv() string {
	if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
		return strings.TrimPrefix(h, "unix://")
	}
	return DefaultSocket
}

// NewUnix returns a client for the Docker socket at path.
func NewUnix(path string) *Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
		MaxIdleConns:        4,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
	}
	return New("http://docker", &http.Client{Transport: tr})
}

// New returns a client for an arbitrary base URL (used by tests).
func New(base string, hc *http.Client) *Client {
	return &Client{HTTP: hc, Base: strings.TrimSuffix(base, "/"), StatsTimeout: 3 * time.Second, Concurrency: 8}
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body := io.LimitReader(resp.Body, maxBody)
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(body, 512))
		return fmt.Errorf("docker %s: %s: %s", path, resp.Status, strings.TrimSpace(string(msg)))
	}
	return json.NewDecoder(body).Decode(out)
}

// API shapes (only the fields we read).

type listEntry struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

type inspect struct {
	RestartCount int `json:"RestartCount"`
	State        struct {
		Status    string `json:"Status"`
		StartedAt string `json:"StartedAt"`
	} `json:"State"`
}

type cpuStats struct {
	CPUUsage struct {
		TotalUsage  uint64   `json:"total_usage"`
		PercpuUsage []uint64 `json:"percpu_usage"`
	} `json:"cpu_usage"`
	SystemUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs  uint32 `json:"online_cpus"`
}

// Stats is the subset of GET /containers/{id}/stats we use.
type Stats struct {
	Read        time.Time `json:"read"`
	CPUStats    cpuStats  `json:"cpu_stats"`
	PreCPUStats cpuStats  `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

// CPUPercent follows the docker CLI: share of host CPU time, scaled by the
// number of online CPUs, so a container saturating 2 cores reads 200%.
func CPUPercent(s *Stats) float64 {
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(s.CPUStats.SystemUsage) - float64(s.PreCPUStats.SystemUsage)
	online := float64(s.CPUStats.OnlineCPUs)
	if online == 0 {
		online = float64(len(s.CPUStats.CPUUsage.PercpuUsage))
	}
	if online == 0 {
		online = 1
	}
	if sysDelta > 0 && cpuDelta > 0 {
		return cpuDelta / sysDelta * online * 100
	}
	return 0
}

// MemUsed is usage minus page cache (inactive_file), like `docker stats`.
// cgroup v1 reports total_inactive_file; cgroup v2 reports inactive_file.
func MemUsed(s *Stats) uint64 {
	usage := s.MemoryStats.Usage
	if v, ok := s.MemoryStats.Stats["total_inactive_file"]; ok && v < usage {
		return usage - v
	}
	if v, ok := s.MemoryStats.Stats["inactive_file"]; ok && v < usage {
		return usage - v
	}
	return usage
}

// NetTotals sums rx/tx bytes over the container's interfaces.
func NetTotals(s *Stats) (rx, tx uint64) {
	for _, n := range s.Networks {
		rx += n.RxBytes
		tx += n.TxBytes
	}
	return rx, tx
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Containers lists every container (running or not) with restart counts and,
// for running ones, CPU/memory/network usage. Per-container failures (a
// container vanishing mid-scan, a slow stats call) only zero that container's
// numbers; an error is returned only when the list call itself fails.
func (c *Client) Containers(ctx context.Context) ([]report.Container, error) {
	listCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	var list []listEntry
	err := c.get(listCtx, "/containers/json?all=1", &list)
	cancel()
	if err != nil {
		return nil, err
	}

	out := make([]report.Container, len(list))
	stats := make([]*Stats, len(list))
	conc := c.Concurrency
	if conc <= 0 {
		conc = 8
	}
	timeout := c.StatsTimeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	sem := make(chan struct{}, conc)
	var wg sync.WaitGroup
	for i, e := range list {
		name := ""
		if len(e.Names) > 0 {
			name = strings.TrimPrefix(e.Names[0], "/")
		}
		labels := e.Labels
		if labels == nil {
			labels = map[string]string{}
		}
		out[i] = report.Container{
			ID: shortID(e.ID), Name: name, Image: e.Image, State: e.State,
			Status: e.Status, Labels: labels,
		}
		wg.Add(1)
		go func(i int, id string, running bool) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			ictx, cancel := context.WithTimeout(ctx, timeout)
			var in inspect
			if err := c.get(ictx, "/containers/"+url.PathEscape(id)+"/json", &in); err == nil {
				out[i].RestartCount = in.RestartCount
				if t, err := time.Parse(time.RFC3339Nano, in.State.StartedAt); err == nil && t.Year() > 1 {
					s := t.UTC().Format(time.RFC3339Nano)
					out[i].StartedAt = &s
				}
			}
			cancel()
			if !running {
				return
			}
			// stream=false waits for a second sample so precpu_stats is filled.
			sctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			var st Stats
			if err := c.get(sctx, "/containers/"+url.PathEscape(id)+"/stats?stream=false", &st); err == nil {
				stats[i] = &st
			}
		}(i, e.ID, e.State == "running")
	}
	wg.Wait()

	c.mu.Lock()
	defer c.mu.Unlock()
	next := make(map[string]netSample, len(list))
	for i, st := range stats {
		if st == nil {
			continue
		}
		o := &out[i]
		o.CPUPercent = CPUPercent(st)
		o.MemUsed = MemUsed(st)
		o.MemLimit = st.MemoryStats.Limit
		rx, tx := NetTotals(st)
		at := st.Read
		if at.IsZero() || at.Year() <= 1 {
			at = c.now()
		}
		cur := netSample{rx: rx, tx: tx, at: at}
		if p, ok := c.prev[list[i].ID]; ok {
			o.NetRx, o.NetTx = rate(p, cur)
		}
		next[list[i].ID] = cur
	}
	c.prev = next // forget containers that are gone
	return out, nil
}

func rate(p, cur netSample) (rx, tx float64) {
	secs := cur.at.Sub(p.at).Seconds()
	if secs <= 0 {
		return 0, 0
	}
	if cur.rx >= p.rx {
		rx = float64(cur.rx-p.rx) / secs
	}
	if cur.tx >= p.tx {
		tx = float64(cur.tx-p.tx) / secs
	}
	return rx, tx
}
