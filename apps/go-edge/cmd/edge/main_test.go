package main

import (
	"runtime"
	"strings"
	"testing"
)

func TestDecideMemoryLimit(t *testing.T) {
	cases := []struct {
		raw       string
		wantApply bool
		wantBytes int64
		noteHas   string
	}{
		{"", false, 0, "unset"},
		{"   ", false, 0, "unset"},
		{"512", true, 512 << 20, "applied"},
		{" 256 ", true, 256 << 20, "applied"},
		{"1", true, 1 << 20, "applied"},
		{"0", false, 0, "invalid"},
		{"-5", false, 0, "invalid"},
		{"abc", false, 0, "invalid"},
		{"12.5", false, 0, "invalid"},
		{"512MB", false, 0, "invalid"},
	}
	for _, c := range cases {
		dec := decideMemoryLimit(c.raw)
		if dec.apply != c.wantApply {
			t.Errorf("decideMemoryLimit(%q).apply = %v, want %v", c.raw, dec.apply, c.wantApply)
		}
		if dec.bytes != c.wantBytes {
			t.Errorf("decideMemoryLimit(%q).bytes = %d, want %d", c.raw, dec.bytes, c.wantBytes)
		}
		if !strings.Contains(dec.note, c.noteHas) {
			t.Errorf("decideMemoryLimit(%q).note = %q, want it to mention %q", c.raw, dec.note, c.noteHas)
		}
	}
}

func TestFormatHeapStats(t *testing.T) {
	var ms runtime.MemStats
	ms.HeapInuse = 12 << 20
	ms.HeapAlloc = 3 << 20
	ms.Sys = 40 << 20
	ms.NumGC = 3
	// Most recent pause for NumGC=3 sits at ring index (3+255)%256 = 2.
	ms.PauseNs[2] = 7_500_000

	line := formatHeapStats(ms, 42)
	for _, want := range []string{
		"heap ",
		"inuse_mb=12",
		"alloc_mb=3",
		"sys_mb=40",
		"gc_count=3",
		"last_gc_pause_ms=7",
		"conns=42",
	} {
		if !strings.Contains(line, want) {
			t.Errorf("formatHeapStats = %q, want it to contain %q", line, want)
		}
	}
	if strings.Count(line, "\n") != 0 {
		t.Errorf("formatHeapStats must be one line, got %q", line)
	}

	// No GC yet: pause must read 0, not a stale ring entry.
	line = formatHeapStats(runtime.MemStats{}, 0)
	if !strings.Contains(line, "gc_count=0") || !strings.Contains(line, "last_gc_pause_ms=0") {
		t.Errorf("formatHeapStats(zero) = %q, want gc_count=0 and last_gc_pause_ms=0", line)
	}
}
