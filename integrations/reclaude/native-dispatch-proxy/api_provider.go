package main

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A response-header receipt is diagnostic evidence, never proof of final usage.
func (g *Gate) recordAPIStatus(id string, status int) {
	file, err := os.OpenFile(filepath.Join(g.Directory, id+".provider-status.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		g.TraceFailures.Add(1)
		return
	}
	defer file.Close()
	if err := json.NewEncoder(file).Encode(map[string]any{"grant_id": id, "status": status}); err != nil || file.Sync() != nil {
		g.TraceFailures.Add(1)
	}
}

func apiProviderURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("explicit_https_api_origin_required")
	}
	return u, nil
}

func (g *Gate) serveAPI(w http.ResponseWriter, req *http.Request) {
	// The caller cannot use this private gateway as an arbitrary HTTP proxy.
	host, _, err := net.SplitHostPort(req.Host)
	if err != nil || host != "127.0.0.1" || req.Method != "POST" ||
		(req.URL.Path != "/v1/messages" && req.URL.Path != "/v1/messages/count_tokens") ||
		req.URL.IsAbs() || req.URL.RawPath != "" {
		http.Error(w, "unsupported_api_operation", http.StatusBadRequest)
		return
	}
	conn, _, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(12 * time.Minute))
	g.forwardRequest(conn, req)
}

func serveAPIProvider(listen, raw, directory, session string) {
	base, err := apiProviderURL(raw)
	host, _, addressErr := net.SplitHostPort(listen)
	if err != nil || addressErr != nil || host != "127.0.0.1" || !uuidPattern.MatchString(session) || directory == "" {
		log.Fatal("invalid_private_api_provider_configuration")
	}
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, DisableCompression: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 120 * time.Second}
	gate := &Gate{Directory: directory, Session: session, APIBase: base, Transport: transport}
	server := &http.Server{Handler: gate, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 65536, ErrorLog: log.New(io.Discard, "", 0)}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatal("private_listener_unavailable")
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"listen": listener.Addr().String(), "session_id": session})
	parent := os.Getppid()
	go func() {
		for range time.Tick(time.Second) {
			if os.Getppid() != parent {
				_ = server.Close()
				return
			}
		}
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) && !strings.Contains(err.Error(), "closed network connection") {
		log.Fatal("private_listener_stopped")
	}
}
