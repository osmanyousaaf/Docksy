package collect

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/osmanyousaaf/docksy/agent/internal/report"
)

// StatfsFunc returns total and used bytes for the filesystem at path.
type StatfsFunc func(path string) (total, used uint64, err error)

// Collector samples host metrics. CPU and network are rates, so it keeps the
// previous sample between calls. Safe for use from one goroutine at a time.
type Collector struct {
	Proc   string        // procfs root, default "/proc"
	Etc    string        // dir holding os-release, default "/etc"
	Statfs StatfsFunc    // default: syscall.Statfs
	Warmup time.Duration // gap between the two samples on the very first Collect
	Now    func() time.Time

	mu      sync.Mutex
	primed  bool
	prevAll CPUTimes
	prevPer []CPUTimes
	prevNet NetCounters
	prevAt  time.Time
}

// New returns a Collector for the real host.
func New() *Collector {
	return &Collector{Proc: "/proc", Etc: "/etc", Statfs: statfs, Warmup: time.Second, Now: time.Now}
}

type sample struct {
	all          CPUTimes
	per          []CPUTimes
	net          NetCounters
	at           time.Time
	cpuOK, netOK bool
	err          error
}

func (c *Collector) path(parts ...string) string {
	return filepath.Join(append([]string{c.Proc}, parts...)...)
}

func (c *Collector) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Collector) take() sample {
	s := sample{at: c.now()}
	var errs []error
	if f, err := os.Open(c.path("stat")); err != nil {
		errs = append(errs, err)
	} else {
		s.all, s.per, err = ParseStat(f)
		f.Close()
		if err != nil {
			errs = append(errs, err)
		}
		s.cpuOK = err == nil
	}
	if f, err := os.Open(c.path("net", "dev")); err != nil {
		errs = append(errs, err)
	} else {
		s.net, err = ParseNetDev(f)
		f.Close()
		if err != nil {
			errs = append(errs, err)
		}
		s.netOK = err == nil
	}
	s.err = errors.Join(errs...)
	return s
}

// Collect fills every host field of a report (everything but containers,
// agentVersion and ts). Partial failures are returned as a joined error
// alongside a best-effort report, so a missing file never blocks a push.
func (c *Collector) Collect(ctx context.Context) (report.Report, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.primed {
		s := c.take()
		c.prevAll, c.prevPer, c.prevNet, c.prevAt = s.all, s.per, s.net, s.at
		c.primed = true
		if c.Warmup > 0 {
			t := time.NewTimer(c.Warmup)
			select {
			case <-ctx.Done():
				t.Stop()
				return report.Report{}, ctx.Err()
			case <-t.C:
			}
		}
	}

	var errs []error
	s := c.take()
	if s.err != nil {
		errs = append(errs, s.err)
	}

	r := report.Report{Arch: runtime.GOARCH}
	r.CPU.Cores = len(s.per)
	if r.CPU.Cores == 0 {
		r.CPU.Cores = runtime.NumCPU()
	}
	r.CPU.Percent = CPUPercent(c.prevAll, s.all)
	r.CPU.PerCore = make([]float64, len(s.per))
	for i, cur := range s.per {
		if i < len(c.prevPer) {
			r.CPU.PerCore[i] = CPUPercent(c.prevPer[i], cur)
		}
	}
	if secs := s.at.Sub(c.prevAt).Seconds(); secs > 0 {
		if s.net.Rx >= c.prevNet.Rx {
			r.Net.RxBytesPerSec = float64(s.net.Rx-c.prevNet.Rx) / secs
		}
		if s.net.Tx >= c.prevNet.Tx {
			r.Net.TxBytesPerSec = float64(s.net.Tx-c.prevNet.Tx) / secs
		}
	}
	if s.cpuOK {
		c.prevAll, c.prevPer = s.all, s.per
	}
	if s.netOK {
		c.prevNet, c.prevAt = s.net, s.at
	}

	if f, err := os.Open(c.path("meminfo")); err != nil {
		errs = append(errs, err)
	} else {
		r.Mem, err = ParseMeminfo(f)
		f.Close()
		if err != nil {
			errs = append(errs, err)
		}
	}
	if f, err := os.Open(c.path("loadavg")); err != nil {
		errs = append(errs, err)
	} else {
		r.CPU.Load1, r.CPU.Load5, r.CPU.Load15, err = ParseLoadavg(f)
		f.Close()
		if err != nil {
			errs = append(errs, err)
		}
	}
	if f, err := os.Open(c.path("uptime")); err != nil {
		errs = append(errs, err)
	} else {
		up, err := ParseUptime(f)
		f.Close()
		if err != nil {
			errs = append(errs, err)
		}
		r.UptimeSec = int64(up)
	}

	r.Disks = []report.Disk{}
	if f, err := os.Open(c.path("mounts")); err != nil {
		errs = append(errs, err)
	} else {
		mounts, err := ParseMounts(f)
		f.Close()
		if err != nil {
			errs = append(errs, err)
		}
		sf := c.Statfs
		if sf == nil {
			sf = statfs
		}
		for _, m := range mounts {
			total, used, err := sf(m.Point)
			if err != nil || total == 0 {
				continue // unmounted meanwhile, permission denied, or empty
			}
			r.Disks = append(r.Disks, report.Disk{Mount: m.Point, FS: m.FS, Total: total, Used: used})
		}
	}

	r.OS = "linux"
	etc := c.Etc
	if etc == "" {
		etc = "/etc"
	}
	for _, p := range []string{filepath.Join(etc, "os-release"), "/usr/lib/os-release"} {
		if f, err := os.Open(p); err == nil {
			r.OS = ParseOSRelease(f)
			f.Close()
			break
		}
	}

	if h, err := os.Hostname(); err == nil {
		r.Hostname = h
	} else {
		errs = append(errs, fmt.Errorf("hostname: %w", err))
	}
	return r, errors.Join(errs...)
}
