package egress

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func persistedProbe(t *testing.T, f *guardFixture) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(f.config.ExitGuard.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	probe, ok := state["probe"].(map[string]any)
	if !ok {
		t.Fatal("persisted state lost probe diagnostics")
	}
	return probe
}

func TestExitGuardProbeFailureDiagnosticsSurviveRestart(t *testing.T) {
	f := newGuardFixture(t)
	f.reflector.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	f.server.guard.client.Timeout = 25 * time.Millisecond
	if err := f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("timeout admitted a request")
	}
	first := *f.server.ExitGuardState()
	probe := persistedProbe(t, f)
	if probe["error_kind"] != "timeout" || probe["stage"] != "response_headers" || probe["duration_ms"].(float64) < 20 {
		t.Fatalf("unhelpful timeout evidence: %v", probe)
	}
	restarted := f.restart(t, "operator-1")
	if err := restarted.VerifyExit(context.Background()); err == nil {
		t.Fatal("restart reopened admission")
	}
	state := restarted.ExitGuardState()
	if state.Reason != "exit_guard_restart_requires_rearm" || state.CheckedAt != first.CheckedAt || !state.Latched || state.Ready {
		t.Fatalf("restart overwrote the first failure: %+v", state)
	}
	if got := persistedProbe(t, f); got["error_kind"] != "timeout" || got["duration_ms"] != probe["duration_ms"] {
		t.Fatalf("restart changed probe evidence: %v", got)
	}
	rearmed := f.restart(t, "operator-2")
	rearmed.guard.client.Timeout = 25 * time.Millisecond
	if err := rearmed.VerifyExit(context.Background()); err == nil {
		t.Fatal("fresh permission accepted a still failing probe")
	}
}

func TestExitGuardWaitsForSlowVerifiedProbeBeforeAdmission(t *testing.T) {
	f := newGuardFixture(t)
	entered := make(chan struct{})
	f.reflector.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		timer := time.NewTimer(6 * time.Second)
		defer timer.Stop()
		select {
		case <-r.Context().Done():
		case <-timer.C:
			w.Write([]byte("203.0.113.9"))
		}
	})
	done := make(chan error, 1)
	go func() { done <- f.server.VerifyExit(context.Background()) }()
	<-entered
	if f.server.ExitGuardState().Ready {
		t.Fatal("probe in progress opened admission")
	}
	if err := <-done; err != nil {
		t.Fatalf("healthy slow proxy was permanently locked: %v", err)
	}
	if state := f.server.ExitGuardState(); !state.Ready || state.Latched || state.ObservedIP != "203.0.113.9" {
		t.Fatalf("verified response not admitted: %+v", state)
	}
}

func TestExitGuardMismatchEvidenceSurvivesShutdownAndRestart(t *testing.T) {
	f := newGuardFixture(t)
	f.answer.Store("203.0.113.10")
	if err := f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("IP mismatch admitted a request")
	}
	first := *f.server.ExitGuardState()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.server.guard.monitor(ctx)
	state := f.restart(t, "operator-1").ExitGuardState()
	if state.Reason != "exit_ip_mismatch" || state.ObservedIP != first.ObservedIP || state.CheckedAt != first.CheckedAt || !state.Latched {
		t.Fatalf("original mismatch evidence overwritten: %+v", state)
	}
	f.answer.Store("203.0.113.9")
	rearmed := f.restart(t, "operator-2")
	if err := rearmed.VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state := rearmed.ExitGuardState(); !state.Ready || state.Latched || state.Reason != "verified" {
		t.Fatalf("explicit fresh permission did not recover: %+v", state)
	}
}

func TestExitGuardHTTPFailureRecordsOnlySafeMetadata(t *testing.T) {
	f := newGuardFixture(t)
	const secret = "not-for-state-or-logs"
	f.server.guard.cfg.ProbeURL += "?token=" + secret
	f.reflector.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(secret))
	})
	if err := f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("HTTP error admitted a request")
	}
	probe := persistedProbe(t, f)
	if probe["error_kind"] != "http_status" || probe["http_status"] != float64(429) {
		t.Fatalf("HTTP cause lost: %v", probe)
	}
	raw, err := os.ReadFile(f.config.ExitGuard.StatePath)
	if err != nil || strings.Contains(string(raw), secret) || strings.Contains(string(raw), f.reflector.URL) {
		t.Fatal("probe leaked response or URL into state")
	}
}
