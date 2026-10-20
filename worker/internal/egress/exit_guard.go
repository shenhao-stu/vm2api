package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ExitGuardConfig struct {
	ExpectedIP      string `json:"expected_ip"`
	Revision        string `json:"revision"`
	StatePath       string `json:"state_path"`
	ProbeURL        string `json:"probe_url,omitempty"`
	IntervalSeconds int    `json:"interval_seconds,omitempty"`
}

type ExitGuardState struct {
	Version    int    `json:"version"`
	Ready      bool   `json:"ready"`
	Latched    bool   `json:"latched"`
	Reason     string `json:"reason"`
	ExpectedIP string `json:"expected_ip"`
	ObservedIP string `json:"observed_ip"`
	Revision   string `json:"revision"`
	CheckedAt  string `json:"checked_at"`
	SocksAddr  string `json:"socks_addr"`
	PID        int    `json:"pid"`
}

type exitGuard struct {
	cfg      ExitGuardConfig
	mu       sync.Mutex
	probeMu  sync.Mutex
	state    ExitGuardState
	conns    map[*guardConn]struct{}
	client   *http.Client
	canceled context.Context
	cancel   context.CancelFunc
}

func newExitGuard(cfg ExitGuardConfig, dial func(context.Context, string, string) (net.Conn, error)) (*exitGuard, error) {
	if cfg.StatePath == "" {
		return nil, errors.New("exit guard state path required")
	}
	if cfg.ProbeURL == "" {
		cfg.ProbeURL = "https://api.ipify.org"
	}
	u, err := url.Parse(cfg.ProbeURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return nil, errors.New("exit guard probe requires HTTPS URL without credentials or fragment")
	}
	if cfg.IntervalSeconds <= 0 {
		cfg.IntervalSeconds = 15
	}
	if cfg.IntervalSeconds > 60 {
		return nil, errors.New("exit guard interval exceeds 60 seconds")
	}
	g := &exitGuard{cfg: cfg, conns: map[*guardConn]struct{}{}, state: ExitGuardState{Version: 1, ExpectedIP: cfg.ExpectedIP, Revision: cfg.Revision, PID: os.Getpid(), Reason: "exit_guard_checking", CheckedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	g.canceled, g.cancel = context.WithCancel(context.Background())
	g.client = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DialContext: dial, DisableKeepAlives: true}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("exit guard redirects forbidden") }}
	previous, readErr := os.ReadFile(cfg.StatePath)
	var prior ExitGuardState
	reason := ""
	if readErr == nil {
		if json.Unmarshal(previous, &prior) != nil || prior.Version != 1 || prior.PID <= 0 || prior.Reason == "" || (prior.Ready && prior.Latched) {
			reason = "exit_guard_state_invalid"
		} else if prior.Revision == cfg.Revision {
			reason = "exit_guard_restart_requires_rearm"
		}
	} else if !os.IsNotExist(readErr) {
		reason = "exit_guard_state_unreadable"
	}
	ip, ipErr := netip.ParseAddr(cfg.ExpectedIP)
	if ipErr != nil || ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		reason = "exit_ip_required"
	}
	if cfg.Revision == "" {
		reason = "exit_guard_revision_required"
	}
	if reason != "" {
		g.state.Latched = true
		g.state.Reason = reason
		g.cancel()
	}
	if err := g.persistLocked(); err != nil {
		g.state.Ready = false
		g.state.Latched = true
		g.state.Reason = "exit_guard_state_write_failed"
		g.cancel()
	}
	return g, nil
}

func (g *exitGuard) persistLocked() error {
	data, err := json.Marshal(g.state)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(g.cfg.StatePath), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(g.cfg.StatePath), ".exit-guard-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(data, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, g.cfg.StatePath)
	}
	if err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(g.cfg.StatePath))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (g *exitGuard) snapshot() ExitGuardState { g.mu.Lock(); defer g.mu.Unlock(); return g.state }

func (g *exitGuard) blockLocked(reason, observed string) {
	g.state.Ready = false
	g.state.Latched = true
	g.state.Reason = reason
	g.state.ObservedIP = observed
	g.cancel()
	// Do not call guardConn.Close while holding mu: it unregisters itself.
	for c := range g.conns {
		_ = c.Conn.Close()
	}
	g.conns = map[*guardConn]struct{}{}
	if g.persistLocked() != nil {
		g.state.Reason = "exit_guard_state_write_failed"
	}
}

func (g *exitGuard) verify(ctx context.Context) error {
	g.probeMu.Lock()
	defer g.probeMu.Unlock()
	g.mu.Lock()
	if g.state.Latched {
		reason := g.state.Reason
		g.mu.Unlock()
		return errors.New(reason)
	}
	g.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.cfg.ProbeURL, nil)
	var observed string
	if err == nil {
		var resp *http.Response
		resp, err = g.client.Do(req)
		if err == nil {
			if resp.StatusCode != http.StatusOK {
				err = errors.New("probe status")
			} else {
				var raw []byte
				raw, err = io.ReadAll(io.LimitReader(resp.Body, 129))
				if err == nil {
					if len(raw) > 128 {
						err = errors.New("oversized probe")
					} else {
						var ip netip.Addr
						ip, err = netip.ParseAddr(strings.TrimSpace(string(raw)))
						if err == nil {
							observed = ip.Unmap().String()
						}
					}
				}
			}
			_ = resp.Body.Close()
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state.Latched {
		return errors.New(g.state.Reason)
	}
	g.state.CheckedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err != nil {
		g.blockLocked("exit_ip_probe_failed", "")
		return errors.New(g.state.Reason)
	}
	expected, _ := netip.ParseAddr(g.cfg.ExpectedIP)
	if observed != expected.Unmap().String() {
		g.blockLocked("exit_ip_mismatch", observed)
		return errors.New(g.state.Reason)
	}
	g.state.Ready = true
	g.state.Reason = "verified"
	g.state.ObservedIP = observed
	if err = g.persistLocked(); err != nil {
		g.blockLocked("exit_guard_state_write_failed", observed)
		return errors.New(g.state.Reason)
	}
	return nil
}

func (g *exitGuard) monitor(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(g.cfg.IntervalSeconds) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			g.mu.Lock()
			g.blockLocked("exit_guard_stopped", g.state.ObservedIP)
			g.mu.Unlock()
			return
		case <-ticker.C:
			if g.verify(ctx) != nil {
				return
			}
		}
	}
}

func (g *exitGuard) register(conn net.Conn) (net.Conn, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.state.Ready || g.state.Latched {
		_ = conn.Close()
		return nil, errors.New(g.state.Reason)
	}
	wrapped := &guardConn{Conn: conn, guard: g}
	g.conns[wrapped] = struct{}{}
	return wrapped, nil
}

type guardConn struct {
	net.Conn
	guard *exitGuard
	once  sync.Once
}

func (c *guardConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.guard.mu.Lock(); delete(c.guard.conns, c); c.guard.mu.Unlock() })
	return err
}

func (s *Server) VerifyExit(ctx context.Context) error {
	if s.guard == nil {
		return nil
	}
	return s.guard.verify(ctx)
}
func (s *Server) ExitGuardState() *ExitGuardState {
	if s.guard == nil {
		return nil
	}
	state := s.guard.snapshot()
	return &state
}

func (s *Server) guardedDial(ctx context.Context, network, address string) (net.Conn, error) {
	if s.guard == nil {
		return s.dialer.DialContext(ctx, network, address)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(s.guard.canceled, cancel)
	defer stop()
	conn, err := s.dialer.DialContext(ctx, network, address)
	if err != nil {
		return nil, err
	}
	return s.guard.register(conn)
}

func (s *Server) startGuardSOCKS(ctx context.Context) (net.Listener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s.guard.mu.Lock()
	s.guard.state.SocksAddr = ln.Addr().String()
	err = s.guard.persistLocked()
	if err != nil {
		s.guard.blockLocked("exit_guard_state_write_failed", "")
	}
	s.guard.mu.Unlock()
	if err != nil {
		ln.Close()
		return nil, err
	}
	go func() { <-ctx.Done(); ln.Close() }()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.handleGuardSOCKS(ctx, conn)
		}
	}()
	return ln, nil
}

func (s *Server) handleGuardSOCKS(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	var header [2]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil || header[0] != 5 {
		return
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}
	accepted := false
	for _, m := range methods {
		accepted = accepted || m == 0
	}
	if !accepted {
		_, _ = conn.Write([]byte{5, 255})
		return
	}
	if _, err := conn.Write([]byte{5, 0}); err != nil {
		return
	}
	var request [4]byte
	if _, err := io.ReadFull(conn, request[:]); err != nil || request[0] != 5 || request[1] != 1 || request[2] != 0 {
		return
	}
	var host string
	switch request[3] {
	case 1:
		raw := make([]byte, 4)
		if _, err := io.ReadFull(conn, raw); err != nil {
			return
		}
		host = net.IP(raw).String()
	case 4:
		raw := make([]byte, 16)
		if _, err := io.ReadFull(conn, raw); err != nil {
			return
		}
		host = net.IP(raw).String()
	case 3:
		var size [1]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil || size[0] == 0 {
			return
		}
		raw := make([]byte, int(size[0]))
		if _, err := io.ReadFull(conn, raw); err != nil {
			return
		}
		host = string(raw)
	default:
		return
	}
	var port [2]byte
	if _, err := io.ReadFull(conn, port[:]); err != nil {
		return
	}
	dest := net.JoinHostPort(host, fmt.Sprint(int(port[0])*256+int(port[1])))
	_ = conn.SetDeadline(time.Time{})
	err := s.forwardTCP(ctx, conn, dest, func() error { _, err := conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); return err })
	if err != nil {
		_, _ = conn.Write([]byte{5, 2, 0, 1, 0, 0, 0, 0, 0, 0})
	}
}

func (c *guardConn) CloseWrite() error {
	if half, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return c.Close()
}
