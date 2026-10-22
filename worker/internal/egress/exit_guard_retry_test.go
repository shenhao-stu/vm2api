package egress

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type guardRoundTripFunc func(*http.Request) (*http.Response, error)

func (f guardRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func guardIPResponse(ip string) *http.Response {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(ip))}
}

func TestExitGuardTransientProbePausesAdmissionWithoutDroppingLiveFlow(t *testing.T) {
	f := newGuardFixture(t)
	if err := f.server.VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	live, peer := net.Pipe()
	defer peer.Close()
	wrapped, err := f.server.guard.register(live)
	if err != nil {
		t.Fatal(err)
	}
	defer wrapped.Close()
	entered, resume := make(chan struct{}), make(chan struct{})
	defer close(resume)
	var attempts atomic.Int32
	f.server.guard.client.Transport = guardRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if attempts.Add(1) == 1 {
			return nil, io.ErrUnexpectedEOF
		}
		close(entered)
		select {
		case <-resume:
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
		return guardIPResponse("203.0.113.9"), nil
	})
	done := make(chan error, 1)
	go func() { done <- f.server.VerifyExit(context.Background()) }()
	select {
	case <-entered:
	case err := <-done:
		t.Fatalf("one transient error permanently blocked the slot: %v", err)
	case <-time.After(time.Second):
		t.Fatal("retry not started")
	}
	state := f.server.ExitGuardState()
	if state.Ready || state.Latched || state.Reason != "exit_guard_checking" {
		t.Fatalf("pending state=%+v", state)
	}
	newConn, newPeer := net.Pipe()
	defer newPeer.Close()
	if _, err := f.server.guard.register(newConn); err == nil {
		t.Fatal("pending probe admitted new connection")
	}
	written := make(chan error, 1)
	go func() { _, err := peer.Write([]byte("ok")); written <- err }()
	wrapped.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := io.ReadFull(wrapped, make([]byte, 2)); err != nil {
		t.Fatalf("live flow interrupted on transient failure: %v", err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	resume <- struct{}{}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	state = f.server.ExitGuardState()
	if !state.Ready || state.Latched || state.ObservedIP != "203.0.113.9" || attempts.Load() != 2 {
		t.Fatalf("same-IP recheck=%+v attempts=%d", state, attempts.Load())
	}
}

func TestExitGuardRetryNeverAcceptsMismatchOrReopensLatch(t *testing.T) {
	f := newGuardFixture(t)
	var attempts int
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, io.ErrUnexpectedEOF
		}
		if attempts == 2 {
			return guardIPResponse("203.0.113.10"), nil
		}
		return guardIPResponse("203.0.113.9"), nil
	})
	if err := f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("mismatch accepted")
	}
	state := f.server.ExitGuardState()
	if !state.Latched || state.Reason != "exit_ip_mismatch" || state.ObservedIP != "203.0.113.10" || attempts != 2 {
		t.Fatalf("mismatch state=%+v attempts=%d", state, attempts)
	}
	if err := f.server.VerifyExit(context.Background()); err == nil || attempts != 2 {
		t.Fatal("normal verify retried a latched guard")
	}
}

func TestExitGuardRetriesAreBounded(t *testing.T) {
	f := newGuardFixture(t)
	var attempts int
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) {
		attempts++
		return nil, io.ErrUnexpectedEOF
	})
	if err := f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("unverified exit admitted")
	}
	if !f.server.ExitGuardState().Latched || attempts != 3 {
		t.Fatalf("latch=%+v attempts=%d", f.server.ExitGuardState(), attempts)
	}
}

func TestExitGuardCanceledCallerDoesNotLatchHealthyProxy(t *testing.T) {
	f := newGuardFixture(t)
	if err := f.server.VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := f.server.VerifyExit(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled caller=%v", err)
	}
	if state := f.server.ExitGuardState(); state.Latched || !state.Ready {
		t.Fatalf("caller cancellation changed proxy health: %+v", state)
	}
}

func TestExitGuardCallerCanceledDuringProbeStillRequiresVerifiedExit(t *testing.T) {
	f := newGuardFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.server.guard.client.Transport = guardRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		cancel()
		if r.Context().Err() != nil {
			t.Fatal("caller cancellation canceled shared exit verification")
		}
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > exitProbeTimeout {
			t.Fatal("probe lost its bounded deadline")
		}
		return guardIPResponse("203.0.113.9"), nil
	})
	if err := f.server.VerifyExit(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request=%v", err)
	}
	if state := f.server.ExitGuardState(); state.Latched || !state.Ready {
		t.Fatalf("verified exit=%+v", state)
	}
}

func TestExitGuardOnlyRetriesTransientFailures(t *testing.T) {
	for _, tc := range []struct {
		kind   string
		status int
		retry  bool
	}{
		{"unexpected_eof", 0, true}, {"timeout", 0, true}, {"network", 0, true},
		{"http_status", 429, true}, {"http_status", 503, true},
		{"http_status", 403, false}, {"http_status", 501, false},
		{"tls_certificate", 0, false}, {"redirect", 302, false},
		{"invalid_ip", 200, false}, {"oversized_response", 200, false},
		{"request_invalid", 0, false}, {"canceled", 0, false}, {"", 200, false},
	} {
		if got := retryableExitProbe(ExitGuardProbe{ErrorKind: tc.kind, HTTPStatus: tc.status}); got != tc.retry {
			t.Errorf("%s/%d retry=%t", tc.kind, tc.status, got)
		}
	}
}
