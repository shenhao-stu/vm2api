package egress

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	kinproxy "github.com/dofastted/kin-gateway/worker/internal/proxy"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func TestExitGuardMissingIntentRejectsEvenLocalDNS(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"proxy_url": "socks5h://127.0.0.1:1", "listen_tcp": "127.0.0.1:0", "dns_empty_types": []int{28},
		"exit_guard": map[string]any{"state_path": filepath.Join(t.TempDir(), "state.json")},
	})
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	srv, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	name, _ := dnsmessage.NewName("synthetic.invalid.")
	query, _ := (&dnsmessage.Message{Questions: []dnsmessage.Question{{Name: name, Type: dnsmessage.TypeAAAA, Class: dnsmessage.ClassINET}}}).Pack()
	if _, err := srv.ResolveDNS(context.Background(), query); err == nil {
		t.Fatal("missing expected IP admitted a guest DNS request")
	}
}

type oneConnListener struct {
	net.Listener
	conn net.Conn
}

func (l oneConnListener) Accept() (net.Conn, error) { return l.conn, nil }

type guardFixture struct {
	server    *Server
	reflector *httptest.Server
	answer    atomic.Value
	probes    atomic.Int32
	config    Config
}

func newGuardFixture(t *testing.T) *guardFixture {
	t.Helper()
	f := &guardFixture{}
	f.answer.Store("203.0.113.9")
	f.reflector = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { f.probes.Add(1); fmt.Fprint(w, f.answer.Load().(string)) }))
	t.Cleanup(f.reflector.Close)
	socks, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { socks.Close() })
	go func() {
		for {
			conn, err := socks.Accept()
			if err != nil {
				return
			}
			go serveTestSOCKS(t, oneConnListener{Listener: socks, conn: conn})
		}
	}()
	f.config = Config{ProxyURL: "socks5h://" + socks.Addr().String(), ListenTCP: "127.0.0.1:0", ExitGuard: &ExitGuardConfig{ExpectedIP: "203.0.113.9", Revision: "operator-1", StatePath: filepath.Join(t.TempDir(), "guard.json"), ProbeURL: f.reflector.URL, IntervalSeconds: 1}}
	f.server = f.restart(t, "operator-1")
	return f
}
func (f *guardFixture) restart(t *testing.T, revision string) *Server {
	t.Helper()
	cfg := f.config
	guard := *cfg.ExitGuard
	guard.Revision = revision
	cfg.ExitGuard = &guard
	server, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(f.reflector.Certificate())
	server.guard.client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: roots}
	return server
}
func TestExitGuardMismatchLatchesAcrossSuccessAndRestart(t *testing.T) {
	f := newGuardFixture(t)
	if err := f.server.VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.answer.Store("203.0.113.10")
	if err := f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("drift allowed")
	}
	if state := f.server.ExitGuardState(); !state.Latched || state.Reason != "exit_ip_mismatch" {
		t.Fatalf("state=%+v", state)
	}
	attempts := f.probes.Load()
	f.answer.Store("203.0.113.9")
	if err := f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("normal probe reopened latch")
	}
	if f.probes.Load() != attempts {
		t.Fatal("latched guard sent another probe")
	}
	if err := f.restart(t, "operator-1").VerifyExit(context.Background()); err == nil {
		t.Fatal("restart reopened latch")
	}
	if err := f.restart(t, "operator-2").VerifyExit(context.Background()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(f.config.ExitGuard.StatePath)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("state permissions", info, err)
	}
}
func TestExitGuardFailuresNeverAdmit(t *testing.T) {
	for _, tc := range []struct{ name, value string }{{"invalid", "not an IP"}, {"oversized", strings.Repeat("1", 129)}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newGuardFixture(t)
			f.answer.Store(tc.value)
			if err := f.server.VerifyExit(context.Background()); err == nil {
				t.Fatal("bad response allowed")
			}
			if !f.server.ExitGuardState().Latched {
				t.Fatal("not latched")
			}
		})
	}
	t.Run("TLS", func(t *testing.T) {
		f := newGuardFixture(t)
		f.server.guard.client.Transport.(*http.Transport).TLSClientConfig = nil
		if err := f.server.VerifyExit(context.Background()); err == nil {
			t.Fatal("untrusted TLS accepted")
		}
	})
	t.Run("redirect", func(t *testing.T) {
		f := newGuardFixture(t)
		f.reflector.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://example.invalid", 302) })
		if err := f.server.VerifyExit(context.Background()); err == nil {
			t.Fatal("redirect accepted")
		}
	})
	t.Run("state write", func(t *testing.T) {
		f := newGuardFixture(t)
		if err := os.Remove(f.config.ExitGuard.StatePath); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(f.config.ExitGuard.StatePath, 0700); err != nil {
			t.Fatal(err)
		}
		if err := f.server.VerifyExit(context.Background()); err == nil {
			t.Fatal("unpersisted success allowed")
		}
		if !f.server.ExitGuardState().Latched {
			t.Fatal("not latched")
		}
	})
	t.Run("corrupt restart", func(t *testing.T) {
		f := newGuardFixture(t)
		if err := os.WriteFile(f.config.ExitGuard.StatePath, []byte("broken"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := f.restart(t, "operator-2").VerifyExit(context.Background()); err == nil {
			t.Fatal("corrupt persisted latch ignored")
		}
	})
	t.Run("ready restart", func(t *testing.T) {
		f := newGuardFixture(t)
		if err := f.server.VerifyExit(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := f.restart(t, "operator-1").VerifyExit(context.Background()); err == nil {
			t.Fatal("restart with reused permission admitted")
		}
	})
}
func TestExitGuardClosesLiveTCPAndPreventsRedial(t *testing.T) {
	f := newGuardFixture(t)
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	var accepted atomic.Int32
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() { defer conn.Close(); io.Copy(conn, conn) }()
		}
	}()
	client, peer := net.Pipe()
	defer client.Close()
	finished := make(chan error, 1)
	go func() { finished <- f.server.ForwardTCP(context.Background(), peer, echo.Addr().String()) }()
	client.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err = client.Write([]byte("ok")); err != nil {
		t.Fatal(err)
	}
	var response [2]byte
	if _, err = io.ReadFull(client, response[:]); err != nil {
		t.Fatal(err)
	}
	f.answer.Store("203.0.113.10")
	if err = f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("drift allowed")
	}
	if _, err = client.Read(response[:]); err == nil {
		t.Fatal("live connection remained open")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("forwarder leaked after block")
	}
	another, remote := net.Pipe()
	defer another.Close()
	defer remote.Close()
	if err = f.server.ForwardTCP(context.Background(), remote, echo.Addr().String()); err == nil {
		t.Fatal("blocked forwarder admitted")
	}
	if accepted.Load() != 1 {
		t.Fatalf("business target accepted %d connections", accepted.Load())
	}
}
func TestExitGuardHostSOCKSUsesSameGateAndMonitor(t *testing.T) {
	f := newGuardFixture(t)
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		conn, err := echo.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		io.Copy(conn, conn)
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.server.Serve(ctx) }()
	deadline := time.Now().Add(2 * time.Second)
	for !f.server.ExitGuardState().Ready && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	state := f.server.ExitGuardState()
	if !state.Ready {
		t.Fatalf("not ready: %+v", state)
	}
	dialer, err := kinproxy.New("socks5h://"+state.SocksAddr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := dialer.DialContext(ctx, "tcp", echo.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(4 * time.Second))
	if _, err = conn.Write([]byte("ok")); err != nil {
		t.Fatal(err)
	}
	var response [2]byte
	if _, err = io.ReadFull(conn, response[:]); err != nil {
		t.Fatal(err)
	}
	f.answer.Store("203.0.113.10")
	if _, err = conn.Read(response[:]); err == nil {
		t.Fatal("periodic drift left host flow open")
	}
	if !f.server.ExitGuardState().Latched {
		t.Fatal("monitor failed to latch")
	}
	if _, err = dialer.DialContext(ctx, "tcp", echo.Addr().String()); err == nil {
		t.Fatal("host SOCKS reopened")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("server did not stop")
	}
}

func TestExitGuardTwoBusinessConnectionsRemainConcurrent(t *testing.T) {
	f := newGuardFixture(t)
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	var active atomic.Int32
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			active.Add(1)
			go func() { defer active.Add(-1); defer conn.Close(); io.Copy(conn, conn) }()
		}
	}()
	clients := make([]net.Conn, 0, 2)
	done := make(chan error, 2)
	for range 2 {
		client, peer := net.Pipe()
		clients = append(clients, client)
		defer client.Close()
		go func() { done <- f.server.ForwardTCP(context.Background(), peer, echo.Addr().String()) }()
		client.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := client.Write([]byte("ok")); err != nil {
			t.Fatal(err)
		}
		var reply [2]byte
		if _, err := io.ReadFull(client, reply[:]); err != nil {
			t.Fatal(err)
		}
	}
	if active.Load() != 2 {
		t.Fatalf("active business flows=%d, want 2", active.Load())
	}
	if f.probes.Load() != 2 {
		t.Fatalf("fresh probes=%d, want one per connection", f.probes.Load())
	}
	f.answer.Store("203.0.113.10")
	_ = f.server.VerifyExit(context.Background())
	for range 2 {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("flow not closed")
		}
	}
}

func TestExitGuardProbeTimeoutClosesAdmission(t *testing.T) {
	f := newGuardFixture(t)
	f.reflector.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	f.server.guard.client.Timeout = 25 * time.Millisecond
	if err := f.server.VerifyExit(context.Background()); err == nil {
		t.Fatal("timeout admitted")
	}
	state := f.server.ExitGuardState()
	if state.Ready || state.Latched || state.Reason != "exit_guard_retrying" {
		t.Fatalf("state=%+v", state)
	}
}

func TestExitGuardMissingStateSchemaCannotRearm(t *testing.T) {
	f := newGuardFixture(t)
	if err := os.WriteFile(f.config.ExitGuard.StatePath, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := f.restart(t, "operator-2").VerifyExit(context.Background()); err == nil {
		t.Fatal("structurally corrupt state reopened")
	}
}
