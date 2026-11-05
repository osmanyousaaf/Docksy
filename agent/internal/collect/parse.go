// Package collect reads host metrics straight from /proc (no cgo, no deps).
package collect

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/osmanyousaaf/docksy/agent/internal/report"
)

// CPUTimes is one line of /proc/stat reduced to busy+idle jiffies.
type CPUTimes struct {
	Total uint64
	Idle  uint64 // idle + iowait
}

// ParseStat returns the aggregate "cpu" line and each "cpuN" line in order.
func ParseStat(r io.Reader) (all CPUTimes, per []CPUTimes, err error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	found := false
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		t, perr := parseCPULine(fields[1:])
		if perr != nil {
			return all, nil, perr
		}
		if fields[0] == "cpu" {
			all, found = t, true
		} else {
			per = append(per, t)
		}
	}
	if err := sc.Err(); err != nil {
		return all, nil, err
	}
	if !found {
		return all, nil, fmt.Errorf("no cpu line in /proc/stat")
	}
	return all, per, nil
}

// Fields: user nice system idle iowait irq softirq steal guest guest_nice.
// guest/guest_nice are already counted in user/nice, so only the first 8 count.
func parseCPULine(f []string) (CPUTimes, error) {
	var t CPUTimes
	for i, s := range f {
		if i >= 8 {
			break
		}
		v, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return t, fmt.Errorf("bad /proc/stat field %q: %w", s, err)
		}
		t.Total += v
		if i == 3 || i == 4 {
			t.Idle += v
		}
	}
	return t, nil
}

// CPUPercent is the busy share between two samples, 0..100.
func CPUPercent(prev, cur CPUTimes) float64 {
	if cur.Total <= prev.Total {
		return 0
	}
	dt := float64(cur.Total - prev.Total)
	di := float64(0)
	if cur.Idle > prev.Idle {
		di = float64(cur.Idle - prev.Idle)
	}
	p := (dt - di) / dt * 100
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// ParseMeminfo converts /proc/meminfo (kB) into bytes. Used = total - available.
func ParseMeminfo(r io.Reader) (report.Mem, error) {
	vals := map[string]uint64{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		key, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		if len(fields) > 1 && fields[1] == "kB" {
			v *= 1024
		}
		vals[key] = v
	}
	if err := sc.Err(); err != nil {
		return report.Mem{}, err
	}
	total, ok := vals["MemTotal"]
	if !ok {
		return report.Mem{}, fmt.Errorf("MemTotal missing from /proc/meminfo")
	}
	avail, ok := vals["MemAvailable"]
	if !ok { // kernels before 3.14
		avail = vals["MemFree"] + vals["Buffers"] + vals["Cached"]
	}
	if avail > total {
		avail = total
	}
	m := report.Mem{Total: total, Available: avail, Used: total - avail, SwapTotal: vals["SwapTotal"]}
	if free := vals["SwapFree"]; free < m.SwapTotal {
		m.SwapUsed = m.SwapTotal - free
	}
	return m, nil
}

// ParseLoadavg reads the 1/5/15 minute load averages.
func ParseLoadavg(r io.Reader) (l1, l5, l15 float64, err error) {
	b, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return 0, 0, 0, err
	}
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return 0, 0, 0, fmt.Errorf("short /proc/loadavg")
	}
	var out [3]float64
	for i := range out {
		if out[i], err = strconv.ParseFloat(f[i], 64); err != nil {
			return 0, 0, 0, err
		}
	}
	return out[0], out[1], out[2], nil
}

// ParseUptime returns system uptime in seconds.
func ParseUptime(r io.Reader) (float64, error) {
	b, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return 0, err
	}
	f := strings.Fields(string(b))
	if len(f) < 1 {
		return 0, fmt.Errorf("empty /proc/uptime")
	}
	return strconv.ParseFloat(f[0], 64)
}

// NetCounters are cumulative byte counters.
type NetCounters struct{ Rx, Tx uint64 }

// SkipInterface reports whether an interface is loopback or container plumbing.
func SkipInterface(name string) bool {
	return name == "lo" ||
		strings.HasPrefix(name, "veth") ||
		strings.HasPrefix(name, "docker") ||
		strings.HasPrefix(name, "br-")
}

// ParseNetDev sums rx/tx bytes over the interfaces we care about.
func ParseNetDev(r io.Reader) (NetCounters, error) {
	var n NetCounters
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue // header lines
		}
		name = strings.TrimSpace(name)
		if SkipInterface(name) {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(f[0], 10, 64)
		tx, err2 := strconv.ParseUint(f[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		n.Rx += rx
		n.Tx += tx
	}
	return n, sc.Err()
}

// Mount is one real filesystem mount.
type Mount struct {
	Device, Point, FS string
}

// pseudoFS are filesystems that do not represent real disk space.
var pseudoFS = map[string]bool{
	"tmpfs": true, "devtmpfs": true, "overlay": true, "squashfs": true, "aufs": true,
	"proc": true, "sysfs": true, "cgroup": true, "cgroup2": true, "devpts": true,
	"mqueue": true, "debugfs": true, "tracefs": true, "securityfs": true, "pstore": true,
	"bpf": true, "autofs": true, "hugetlbfs": true, "configfs": true, "fusectl": true,
	"binfmt_misc": true, "ramfs": true, "nsfs": true, "rpc_pipefs": true, "efivarfs": true,
	"selinuxfs": true, "fuse.lxcfs": true, "nfsd": true, "shm": true, "iso9660": true,
	"fuse.gvfsd-fuse": true, "fuse.portal": true, "fuse.snapfuse": true, "zram": true,
}

var skipPrefixes = []string{"/proc", "/sys", "/dev", "/run", "/snap/", "/var/lib/docker/", "/var/lib/containerd/"}

func skipMountPoint(p string) bool {
	for _, pre := range skipPrefixes {
		if p == strings.TrimSuffix(pre, "/") || strings.HasPrefix(p, strings.TrimSuffix(pre, "/")+"/") {
			return true
		}
	}
	return false
}

// ParseMounts returns real filesystems from /proc/mounts. A device mounted in
// several places (bind mounts, btrfs subvolumes) is reported once, at its
// shortest mount point.
func ParseMounts(r io.Reader) ([]Mount, error) {
	var out []Mount
	byDev := map[string]int{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		m := Mount{Device: unescapeMount(f[0]), Point: unescapeMount(f[1]), FS: f[2]}
		if pseudoFS[m.FS] || skipMountPoint(m.Point) || m.Device == "none" {
			continue
		}
		if i, seen := byDev[m.Device]; seen {
			if len(m.Point) < len(out[i].Point) {
				out[i] = m
			}
			continue
		}
		byDev[m.Device] = len(out)
		out = append(out, m)
	}
	return out, sc.Err()
}

// unescapeMount decodes the octal escapes (\040 etc.) used in /proc/mounts.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// ParseOSRelease returns "<id> <version_id>", e.g. "ubuntu 24.04".
func ParseOSRelease(r io.Reader) string {
	vals := map[string]string{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok || strings.HasPrefix(k, "#") {
			continue
		}
		vals[k] = strings.Trim(v, `"'`)
	}
	id, ver := vals["ID"], vals["VERSION_ID"]
	switch {
	case id != "" && ver != "":
		return id + " " + ver
	case id != "":
		return id
	case vals["PRETTY_NAME"] != "":
		return vals["PRETTY_NAME"]
	}
	return "linux"
}
