package collect

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func open(t *testing.T, name string) *os.File {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestStatDeltas(t *testing.T) {
	a1, p1, err := ParseStat(open(t, "stat1"))
	if err != nil {
		t.Fatal(err)
	}
	a2, p2, err := ParseStat(open(t, "stat2"))
	if err != nil {
		t.Fatal(err)
	}
	if a1.Total != 10000 || a1.Idle != 8500 {
		t.Fatalf("stat1 aggregate = %+v", a1)
	}
	if len(p1) != 2 || len(p2) != 2 {
		t.Fatalf("want 2 cores, got %d/%d", len(p1), len(p2))
	}
	if got := CPUPercent(a1, a2); !near(got, 40) {
		t.Errorf("total cpu = %v, want 40", got)
	}
	if got := CPUPercent(p1[0], p2[0]); !near(got, 50) {
		t.Errorf("cpu0 = %v, want 50", got)
	}
	if got := CPUPercent(p1[1], p2[1]); !near(got, 30) {
		t.Errorf("cpu1 = %v, want 30", got)
	}
	// No progress or counter reset → 0, never negative.
	if got := CPUPercent(a2, a1); got != 0 {
		t.Errorf("reset = %v, want 0", got)
	}
	if got := CPUPercent(a1, a1); got != 0 {
		t.Errorf("same = %v, want 0", got)
	}
}

func TestStatErrors(t *testing.T) {
	if _, _, err := ParseStat(strings.NewReader("intr 1 2 3\n")); err == nil {
		t.Error("want error without cpu line")
	}
	if _, _, err := ParseStat(strings.NewReader("cpu 1 2 x 4 5\n")); err == nil {
		t.Error("want error for bad field")
	}
}

func TestMeminfo(t *testing.T) {
	m, err := ParseMeminfo(open(t, "meminfo"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Total != 4025360*1024 || m.Available != 2512340*1024 || m.Used != (4025360-2512340)*1024 {
		t.Errorf("mem = %+v", m)
	}
	if m.SwapTotal != 2097148*1024 || m.SwapUsed != (2097148-1572860)*1024 {
		t.Errorf("swap = %+v", m)
	}

	old, err := ParseMeminfo(open(t, "meminfo_old"))
	if err != nil {
		t.Fatal(err)
	}
	if old.Available != 400*1024 || old.Used != 600*1024 {
		t.Errorf("fallback available = %+v", old)
	}
	if _, err := ParseMeminfo(strings.NewReader("MemFree: 1 kB\n")); err == nil {
		t.Error("want error without MemTotal")
	}
}

func TestLoadavgUptime(t *testing.T) {
	l1, l5, l15, err := ParseLoadavg(open(t, "loadavg"))
	if err != nil || l1 != 0.52 || l5 != 0.41 || l15 != 0.30 {
		t.Errorf("loadavg = %v %v %v %v", l1, l5, l15, err)
	}
	up, err := ParseUptime(open(t, "uptime"))
	if err != nil || up != 123456.78 {
		t.Errorf("uptime = %v %v", up, err)
	}
}

func TestNetDevFiltering(t *testing.T) {
	n, err := ParseNetDev(open(t, "net_dev"))
	if err != nil {
		t.Fatal(err)
	}
	// Only eth0 + ens5: lo, docker0, br-*, veth* are excluded.
	if n.Rx != 3_000_000 || n.Tx != 2_000_000 {
		t.Errorf("net = %+v, want rx 3000000 tx 2000000", n)
	}
	for name, skip := range map[string]bool{
		"lo": true, "veth9f": true, "docker0": true, "br-abc": true,
		"eth0": false, "ens3": false, "enp0s3": false, "wg0": false, "bond0": false, "lo2": false,
	} {
		if SkipInterface(name) != skip {
			t.Errorf("SkipInterface(%q) = %v, want %v", name, !skip, skip)
		}
	}
}

func TestMountsFiltering(t *testing.T) {
	ms, err := ParseMounts(open(t, "mounts"))
	if err != nil {
		t.Fatal(err)
	}
	want := []Mount{
		{Device: "/dev/vda1", Point: "/", FS: "ext4"},
		{Device: "/dev/vda15", Point: "/boot/efi", FS: "vfat"},
		{Device: "/dev/sdb1", Point: "/mnt/my data", FS: "xfs"},
	}
	if !reflect.DeepEqual(ms, want) {
		t.Errorf("mounts =\n %+v\nwant\n %+v", ms, want)
	}
}

func TestBindMountKeepsShortestPoint(t *testing.T) {
	in := "/dev/sda1 /srv/data ext4 rw 0 0\n/dev/sda1 / ext4 rw 0 0\n"
	ms, _ := ParseMounts(strings.NewReader(in))
	if len(ms) != 1 || ms[0].Point != "/" {
		t.Errorf("got %+v", ms)
	}
}

func TestOSRelease(t *testing.T) {
	if got := ParseOSRelease(open(t, "os-release")); got != "ubuntu 24.04" {
		t.Errorf("ubuntu: %q", got)
	}
	if got := ParseOSRelease(open(t, "os-release-alpine")); got != "alpine 3.20.3" {
		t.Errorf("alpine: %q", got)
	}
	if got := ParseOSRelease(strings.NewReader("")); got != "linux" {
		t.Errorf("empty: %q", got)
	}
}

// copyFixture writes a fixture into a fake procfs dir under the given name.
func copyFixture(t *testing.T, dir, fixture, name string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCollectorEndToEnd(t *testing.T) {
	proc := t.TempDir()
	etc := t.TempDir()
	copyFixture(t, proc, "stat1", "stat")
	copyFixture(t, proc, "net_dev", "net/dev")
	copyFixture(t, proc, "meminfo", "meminfo")
	copyFixture(t, proc, "loadavg", "loadavg")
	copyFixture(t, proc, "uptime", "uptime")
	copyFixture(t, proc, "mounts", "mounts")
	copyFixture(t, etc, "os-release", "os-release")

	clock := time.Unix(1_700_000_000, 0)
	c := &Collector{
		Proc: proc, Etc: etc,
		Now: func() time.Time { return clock },
		Statfs: func(p string) (uint64, uint64, error) {
			if p == "/boot/efi" {
				return 0, 0, nil // skipped: empty
			}
			return 100 << 30, 25 << 30, nil
		},
	}

	// First call primes (Warmup 0 here) and compares the same sample: 0%.
	r, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if r.CPU.Percent != 0 || r.CPU.Cores != 2 {
		t.Errorf("first sample cpu = %+v", r.CPU)
	}

	copyFixture(t, proc, "stat2", "stat")
	copyFixture(t, proc, "net_dev2", "net/dev")
	clock = clock.Add(2 * time.Second)
	r, err = c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !near(r.CPU.Percent, 40) || !near(r.CPU.PerCore[0], 50) || !near(r.CPU.PerCore[1], 30) {
		t.Errorf("cpu = %+v", r.CPU)
	}
	if !near(r.Net.RxBytesPerSec, 10000) || !near(r.Net.TxBytesPerSec, 10000) {
		t.Errorf("net = %+v (docker0/lo growth must be ignored)", r.Net)
	}
	if r.Mem.Used != (4025360-2512340)*1024 || r.CPU.Load1 != 0.52 || r.UptimeSec != 123456 {
		t.Errorf("mem/load/uptime = %+v %+v %d", r.Mem, r.CPU, r.UptimeSec)
	}
	if len(r.Disks) != 2 || r.Disks[0].Mount != "/" || r.Disks[0].Used != 25<<30 || r.Disks[1].Mount != "/mnt/my data" {
		t.Errorf("disks = %+v", r.Disks)
	}
	if r.OS != "ubuntu 24.04" || r.Arch != runtime.GOARCH || r.Hostname == "" {
		t.Errorf("os/arch/host = %q %q %q", r.OS, r.Arch, r.Hostname)
	}
}

func TestCollectorPartialFailure(t *testing.T) {
	proc := t.TempDir()
	copyFixture(t, proc, "stat1", "stat")
	c := &Collector{Proc: proc, Etc: t.TempDir()}
	r, err := c.Collect(context.Background())
	if err == nil {
		t.Error("want joined error for missing files")
	}
	if r.CPU.Cores != 2 || r.Disks == nil {
		t.Errorf("best-effort report missing data: %+v", r)
	}
}
