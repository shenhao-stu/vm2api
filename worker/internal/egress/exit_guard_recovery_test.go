package egress

import (
	"context"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestExitGuardTimeoutWindowPausesThenRecoversSameIP(t *testing.T) {
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
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded })
	if f.server.VerifyExit(context.Background()) == nil {
		t.Fatal("unknown exit admitted")
	}
	s := f.server.ExitGuardState()
	if s.Ready || s.Latched || s.Reason != "exit_guard_retrying" {
		t.Fatalf("ordinary timeout permanently stopped the slot: %+v", s)
	}
	other, otherPeer := net.Pipe()
	defer otherPeer.Close()
	if _, err := f.server.guard.register(other); err == nil {
		t.Fatal("unverified exit admitted a new connection")
	}
	written := make(chan error, 1)
	go func() { _, err := peer.Write([]byte("ok")); written <- err }()
	wrapped.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := io.ReadFull(wrapped, make([]byte, 2)); err != nil {
		t.Fatalf("live request interrupted: %v", err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) { return guardIPResponse("203.0.113.9"), nil })
	if err := f.server.VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s := f.server.ExitGuardState(); !s.Ready || s.Latched || s.ObservedIP != "203.0.113.9" {
		t.Fatalf("same-IP recovery=%+v", s)
	}
}

func TestExitGuardMonitorKeepsCheckingAfterTransientWindow(t *testing.T) {
	f := newGuardFixture(t)
	f.server.guard.cfg.IntervalSeconds = 1
	var attempts atomic.Int32
	f.server.guard.client.Transport = guardRoundTripFunc(func(*http.Request) (*http.Response, error) {
		if attempts.Add(1) <= 3 {
			return nil, io.ErrUnexpectedEOF
		}
		return guardIPResponse("203.0.113.9"), nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { f.server.guard.monitor(ctx); close(done) }()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) && !f.server.ExitGuardState().Ready {
		select {
		case <-done:
			t.Fatal("monitor exited after a transient network failure")
		case <-time.After(25 * time.Millisecond):
		}
	}
	if !f.server.ExitGuardState().Ready {
		t.Fatal("monitor did not recover")
	}
	cancel()
	<-done
	if !f.server.ExitGuardState().Latched {
		t.Fatal("stopped helper admitted connections")
	}
}
