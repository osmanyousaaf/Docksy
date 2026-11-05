// Package report defines the AgentReport wire format sent to the Docksy server.
//
// The JSON field names must match `AgentReport` in packages/shared/src/index.ts
// exactly. report_test.go pins the shape.
package report

import (
	"encoding/json"
	"math"
)

// Report is the body of POST /api/agent/v1/report.
type Report struct {
	AgentVersion string      `json:"agentVersion"`
	Hostname     string      `json:"hostname"`
	OS           string      `json:"os"`   // "ubuntu 24.04"
	Arch         string      `json:"arch"` // "amd64" | "arm64"
	UptimeSec    int64       `json:"uptimeSec"`
	TS           int64       `json:"ts"` // unix ms, agent clock
	CPU          CPU         `json:"cpu"`
	Mem          Mem         `json:"mem"`
	Disks        []Disk      `json:"disks"`
	Net          Net         `json:"net"`
	Containers   []Container `json:"containers"`
}

type CPU struct {
	Percent float64   `json:"percent"`
	Cores   int       `json:"cores"`
	PerCore []float64 `json:"perCore"`
	Load1   float64   `json:"load1"`
	Load5   float64   `json:"load5"`
	Load15  float64   `json:"load15"`
}

// Mem values are bytes. Used = total - available.
type Mem struct {
	Total     uint64 `json:"total"`
	Used      uint64 `json:"used"`
	Available uint64 `json:"available"`
	SwapTotal uint64 `json:"swapTotal"`
	SwapUsed  uint64 `json:"swapUsed"`
}

type Disk struct {
	Mount string `json:"mount"`
	FS    string `json:"fs"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

// Net is summed across physical-ish interfaces, in bytes per second.
type Net struct {
	RxBytesPerSec float64 `json:"rxBytesPerSec"`
	TxBytesPerSec float64 `json:"txBytesPerSec"`
}

// Container mirrors AgentContainer.
type Container struct {
	ID           string            `json:"id"` // 12-char short id
	Name         string            `json:"name"`
	Image        string            `json:"image"`
	State        string            `json:"state"`
	Status       string            `json:"status"`
	RestartCount int               `json:"restartCount"`
	StartedAt    *string           `json:"startedAt"`
	CPUPercent   float64           `json:"cpuPercent"`
	MemUsed      uint64            `json:"memUsed"`
	MemLimit     uint64            `json:"memLimit"`
	NetRx        float64           `json:"netRx"` // bytes/s
	NetTx        float64           `json:"netTx"` // bytes/s
	Labels       map[string]string `json:"labels"`
}

// ValidStates are the container states the server accepts.
var ValidStates = map[string]bool{
	"running": true, "exited": true, "restarting": true, "paused": true,
	"created": true, "dead": true, "removing": true,
}

// Normalize makes the report safe to marshal and friendly to the server:
// slices and maps are never null, floats are finite and rounded to 2 decimals.
func (r *Report) Normalize() {
	if r.CPU.PerCore == nil {
		r.CPU.PerCore = []float64{}
	}
	if r.Disks == nil {
		r.Disks = []Disk{}
	}
	if r.Containers == nil {
		r.Containers = []Container{}
	}
	r.CPU.Percent = Round2(r.CPU.Percent)
	for i := range r.CPU.PerCore {
		r.CPU.PerCore[i] = Round2(r.CPU.PerCore[i])
	}
	r.CPU.Load1, r.CPU.Load5, r.CPU.Load15 = Round2(r.CPU.Load1), Round2(r.CPU.Load5), Round2(r.CPU.Load15)
	r.Net.RxBytesPerSec = Round2(r.Net.RxBytesPerSec)
	r.Net.TxBytesPerSec = Round2(r.Net.TxBytesPerSec)
	for i := range r.Containers {
		c := &r.Containers[i]
		if c.Labels == nil {
			c.Labels = map[string]string{}
		}
		if !ValidStates[c.State] {
			c.State = "exited"
		}
		c.CPUPercent = Round2(c.CPUPercent)
		c.NetRx = Round2(c.NetRx)
		c.NetTx = Round2(c.NetTx)
	}
}

// Marshal normalizes and encodes the report.
func (r *Report) Marshal() ([]byte, error) {
	r.Normalize()
	return json.Marshal(r)
}

// Round2 rounds to two decimals and maps NaN/Inf/negative values to 0.
func Round2(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0
	}
	return math.Round(v*100) / 100
}
