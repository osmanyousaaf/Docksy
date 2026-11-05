package report

import (
	"encoding/json"
	"math"
	"sort"
	"strings"
	"testing"
)

// expected mirrors `AgentReport` / `AgentContainer` in packages/shared/src/index.ts.
// "number", "string", "null|string", "object" (record) or a nested shape.
var expected = map[string]any{
	"agentVersion": "string",
	"hostname":     "string",
	"os":           "string",
	"arch":         "string",
	"uptimeSec":    "number",
	"ts":           "number",
	"cpu": map[string]any{
		"percent": "number", "cores": "number", "perCore": "[]number",
		"load1": "number", "load5": "number", "load15": "number",
	},
	"mem": map[string]any{
		"total": "number", "used": "number", "available": "number",
		"swapTotal": "number", "swapUsed": "number",
	},
	"disks": []any{map[string]any{"mount": "string", "fs": "string", "total": "number", "used": "number"}},
	"net":   map[string]any{"rxBytesPerSec": "number", "txBytesPerSec": "number"},
	"containers": []any{map[string]any{
		"id": "string", "name": "string", "image": "string", "state": "string", "status": "string",
		"restartCount": "number", "startedAt": "null|string", "cpuPercent": "number",
		"memUsed": "number", "memLimit": "number", "netRx": "number", "netTx": "number",
		"labels": "object",
	}},
}

func sample() Report {
	started := "2026-11-01T10:00:00Z"
	return Report{
		AgentVersion: "1.0.0", Hostname: "vps-1", OS: "ubuntu 24.04", Arch: "amd64",
		UptimeSec: 100, TS: 1_700_000_000_000,
		CPU:   CPU{Percent: 12.345, Cores: 2, PerCore: []float64{10, 14.7}, Load1: 0.5, Load5: 0.4, Load15: 0.3},
		Mem:   Mem{Total: 4 << 30, Used: 1 << 30, Available: 3 << 30, SwapTotal: 1 << 30, SwapUsed: 0},
		Disks: []Disk{{Mount: "/", FS: "ext4", Total: 80 << 30, Used: 20 << 30}},
		Net:   Net{RxBytesPerSec: 1024, TxBytesPerSec: 2048},
		Containers: []Container{
			{ID: "abcdef123456", Name: "web", Image: "nginx", State: "running", Status: "Up", StartedAt: &started,
				Labels: map[string]string{"docksy.app": "app_1"}},
			{ID: "123456abcdef", Name: "old", Image: "busybox", State: "exited", Status: "Exited (0)"},
		},
	}
}

func checkShape(t *testing.T, path string, want any, got any) {
	t.Helper()
	switch w := want.(type) {
	case string:
		ok := false
		switch w {
		case "string":
			_, ok = got.(string)
		case "number":
			_, ok = got.(float64)
		case "null|string":
			_, isStr := got.(string)
			ok = got == nil || isStr
		case "object":
			_, ok = got.(map[string]any)
		case "[]number":
			arr, isArr := got.([]any)
			ok = isArr
			for _, v := range arr {
				if _, n := v.(float64); !n {
					ok = false
				}
			}
		}
		if !ok {
			t.Errorf("%s: want %s, got %T (%v)", path, w, got, got)
		}
	case []any:
		arr, ok := got.([]any)
		if !ok {
			t.Fatalf("%s: want array, got %T", path, got)
		}
		for i, v := range arr {
			checkShape(t, path+"[]", w[0], v)
			_ = i
		}
	case map[string]any:
		obj, ok := got.(map[string]any)
		if !ok {
			t.Fatalf("%s: want object, got %T", path, got)
		}
		var wantKeys, gotKeys []string
		for k := range w {
			wantKeys = append(wantKeys, k)
		}
		for k := range obj {
			gotKeys = append(gotKeys, k)
		}
		sort.Strings(wantKeys)
		sort.Strings(gotKeys)
		if strings.Join(wantKeys, ",") != strings.Join(gotKeys, ",") {
			t.Errorf("%s keys:\n want %v\n got  %v", path, wantKeys, gotKeys)
		}
		for k, sub := range w {
			if v, ok := obj[k]; ok {
				checkShape(t, path+"."+k, sub, v)
			}
		}
	}
}

func TestJSONShapeMatchesSharedType(t *testing.T) {
	r := sample()
	b, err := r.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	checkShape(t, "report", expected, got)

	cs := got["containers"].([]any)
	if cs[1].(map[string]any)["startedAt"] != nil {
		t.Errorf("startedAt should be null for nil pointer")
	}
	if l, ok := cs[1].(map[string]any)["labels"].(map[string]any); !ok || len(l) != 0 {
		t.Errorf("labels should be {} when empty, got %v", cs[1].(map[string]any)["labels"])
	}
}

func TestEmptyReportHasNoNulls(t *testing.T) {
	var r Report
	b, err := r.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, frag := range []string{`"perCore":[]`, `"disks":[]`, `"containers":[]`} {
		if !strings.Contains(s, frag) {
			t.Errorf("missing %s in %s", frag, s)
		}
	}
	if strings.Contains(s, "null") {
		t.Errorf("unexpected null in %s", s)
	}
}

func TestNormalize(t *testing.T) {
	r := Report{CPU: CPU{Percent: math.NaN(), PerCore: []float64{math.Inf(1), 33.333}},
		Containers: []Container{{State: "weird", CPUPercent: 1.006}}}
	r.Normalize()
	if r.CPU.Percent != 0 || r.CPU.PerCore[0] != 0 || r.CPU.PerCore[1] != 33.33 {
		t.Errorf("bad float normalization: %+v", r.CPU)
	}
	if r.Containers[0].State != "exited" || r.Containers[0].CPUPercent != 1.01 {
		t.Errorf("bad container normalization: %+v", r.Containers[0])
	}
}
