package egress

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestExitGuardSharesOnlyProofCompletedAfterCallerArrival(t *testing.T) {
	f := newGuardFixture(t)
	var probes atomic.Int32
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) {
		probes.Add(1)
		return guardIPResponse("203.0.113.9"), nil
	})
	arrived := time.Now()
	done := make(chan error, 12)
	for range 12 {
		go func() { done <- f.server.guard.verifyAfter(context.Background(), arrived) }()
	}
	for range 12 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if got := probes.Load(); got != 1 {
		t.Fatalf("overlapping callers performed %d probes, want one fresh completed proof", got)
	}
	if err := f.server.VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := probes.Load(); got != 2 {
		t.Fatalf("a later caller reused an old proof: probes=%d", got)
	}
}

func TestExitGuardSharedProofDoesNotInheritAnotherCallersCancellation(t *testing.T) {
	f := newGuardFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	probes := 0
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) {
		probes++
		cancel()
		return guardIPResponse("203.0.113.9"), nil
	})
	arrived := time.Now()
	if err := f.server.guard.verifyAfter(ctx, arrived); !errors.Is(err, context.Canceled) {
		t.Fatalf("leader cancellation=%v", err)
	}
	if err := f.server.guard.verifyAfter(context.Background(), arrived); err != nil {
		t.Fatalf("independent caller inherited cancellation: %v", err)
	}
	if probes != 1 {
		t.Fatalf("shared success performed %d probes", probes)
	}
}

func TestExitGuardSharedMismatchStaysLatched(t *testing.T) {
	f := newGuardFixture(t)
	probes := 0
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) { probes++; return guardIPResponse("203.0.113.10"), nil })
	arrived := time.Now()
	for range 3 {
		if err := f.server.guard.verifyAfter(context.Background(), arrived); err == nil {
			t.Fatal("mismatch admitted caller")
		}
	}
	if probes != 1 || !f.server.ExitGuardState().Latched {
		t.Fatalf("probes=%d state=%+v", probes, f.server.ExitGuardState())
	}
}

func TestExitGuardSharedFailureCannotReuseOlderSuccess(t *testing.T) {
	f := newGuardFixture(t)
	probes := 0
	fail := false
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) {
		probes++
		if fail {
			return &http.Response{StatusCode: 503, Body: http.NoBody}, nil
		}
		return guardIPResponse("203.0.113.9"), nil
	})
	if err := f.server.VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	fail = true
	arrived := time.Now()
	for range 4 {
		if err := f.server.guard.verifyAfter(context.Background(), arrived); err == nil {
			t.Fatal("failed cohort reused earlier success")
		}
	}
	if probes != 4 || f.server.ExitGuardState().Ready {
		t.Fatalf("probes=%d state=%+v", probes, f.server.ExitGuardState())
	}
	fail = false
	if err := f.server.VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if probes != 5 {
		t.Fatalf("new caller did not recheck: %d", probes)
	}
}
