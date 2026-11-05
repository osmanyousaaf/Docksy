// docksy-agent runs on each server Docksy manages. It reads host metrics from
// /proc and container stats from the Docker socket, and pushes one small JSON
// report to the Docksy server every few seconds.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/osmanyousaaf/docksy/agent/internal/collect"
	"github.com/osmanyousaaf/docksy/agent/internal/docker"
	"github.com/osmanyousaaf/docksy/agent/internal/push"
	"github.com/osmanyousaaf/docksy/agent/internal/report"
)

// version is set at build time with -ldflags "-X main.version=1.2.3".
var version = "dev"

const usage = `docksy-agent %s: pushes server and container metrics to Docksy.

Usage:
  docksy-agent                 run forever, reporting every interval
  docksy-agent --once          print one report as JSON and exit (debugging)
  docksy-agent --version       print the version

Environment (flags override):
  DOCKSY_URL             Docksy base URL, e.g. https://docksy.example.com
  DOCKSY_AGENT_TOKEN     agent token for this server (dsa_...)
  DOCKSY_AGENT_INTERVAL  seconds between reports (default 10)
  DOCKER_HOST            unix:///path/to/docker.sock (default /var/run/docker.sock)

Flags:
`

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// rateLimited logs a message at most once per window for a given key.
type rateLimited struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func (r *rateLimited) logf(key string, window time.Duration, format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.last == nil {
		r.last = map[string]time.Time{}
	}
	if t, ok := r.last[key]; ok && time.Since(t) < window {
		return
	}
	r.last[key] = time.Now()
	log.Printf(format, args...)
}

type agent struct {
	host   *collect.Collector
	docker *docker.Client
	warn   rateLimited
}

// build gathers host and container data in parallel and returns a full report.
func (a *agent) build(ctx context.Context) report.Report {
	var (
		wg         sync.WaitGroup
		containers []report.Container
		derr       error
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		containers, derr = a.docker.Containers(ctx)
	}()
	r, herr := a.host.Collect(ctx)
	wg.Wait()

	if herr != nil && ctx.Err() == nil {
		a.warn.logf("host", 10*time.Minute, "some host metrics are unavailable: %v", herr)
	}
	if derr != nil && ctx.Err() == nil {
		a.warn.logf("docker", 10*time.Minute, "cannot read containers from Docker (reporting none): %v", derr)
	}
	r.AgentVersion = version
	r.TS = time.Now().UnixMilli()
	r.Containers = containers
	r.Normalize()
	return r
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("docksy-agent: ")

	fs := flag.NewFlagSet("docksy-agent", flag.ExitOnError)
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), usage, version)
		fs.PrintDefaults()
	}
	once := fs.Bool("once", false, "print one report as JSON to stdout and exit")
	showVersion := fs.Bool("version", false, "print the version and exit")
	baseURL := fs.String("url", envDefault("DOCKSY_URL", ""), "Docksy base URL (env DOCKSY_URL)")
	token := fs.String("token", "", "agent token (env DOCKSY_AGENT_TOKEN; prefer the env var, flags show up in ps)")
	intervalStr := fs.String("interval", envDefault("DOCKSY_AGENT_INTERVAL", "10"), "seconds between reports (env DOCKSY_AGENT_INTERVAL)")
	fs.Parse(os.Args[1:])

	if *showVersion {
		fmt.Printf("docksy-agent %s (%s/%s, %s)\n", version, runtime.GOOS, runtime.GOARCH, runtime.Version())
		return
	}

	// Stay small: the agent's budget is <15 MB RSS. Collect garbage more
	// eagerly than the default; the heap is tiny so this costs ~nothing.
	debug.SetGCPercent(50)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a := &agent{host: collect.New(), docker: docker.NewUnix(docker.SocketFromEnv())}

	if *once {
		r := a.build(ctx)
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(r); err != nil {
			log.Fatal(err)
		}
		return
	}

	tok := *token
	if tok == "" {
		tok = os.Getenv("DOCKSY_AGENT_TOKEN")
	}
	if *baseURL == "" || tok == "" {
		log.Print("DOCKSY_URL and DOCKSY_AGENT_TOKEN are required (they live in /etc/docksy/agent.env). Use --once to just print a report.")
		os.Exit(2)
	}
	u, err := url.Parse(*baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		log.Printf("DOCKSY_URL %q is not an http(s) URL", *baseURL)
		os.Exit(2)
	}
	secs, err := strconv.ParseFloat(*intervalStr, 64)
	if err != nil || secs <= 0 {
		log.Printf("DOCKSY_AGENT_INTERVAL %q is not a positive number; using 10", *intervalStr)
		secs = 10
	}
	interval := push.ClampInterval(time.Duration(secs * float64(time.Second)))

	if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		log.Printf("warning: %s is plain http, so the agent token travels unencrypted", u.Host)
	}
	log.Printf("%s starting: reporting to %s every %s", version, u.Host, interval)

	loop := &push.Loop{
		Client: &push.Client{
			URL:       push.ReportURL(*baseURL),
			Token:     tok,
			UserAgent: "docksy-agent/" + version,
		},
		Interval:   interval,
		MaxBackoff: push.DefaultMaxBackoff,
		Build: func(ctx context.Context) ([]byte, error) {
			r := a.build(ctx)
			return r.Marshal()
		},
		Logf: log.Printf,
	}
	if err := loop.Run(ctx); err != nil {
		log.Fatal(err)
	}
	log.Print("stopped")
}
