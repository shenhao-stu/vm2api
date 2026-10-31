// Experimental per-CLI HTTP budget. No OAuth, identity or policy rewriting.
package main

import (
	"bufio"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Grant struct {
	ID      string `json:"id"`
	Session string `json:"session_id"`
	Model   string `json:"model"`
	Expires int64  `json:"expires_at_ms"`
}

type Gate struct {
	Directory      string
	Session        string
	Upstream       string
	Certificate    tls.Certificate
	GetCertificate func(*tls.ClientHelloInfo) (*tls.Certificate, error)
	Transport      http.RoundTripper
	Attempts       atomic.Int64
	Denied         atomic.Int64
	Requests       atomic.Int64
	Normalized     atomic.Int64
	Active         atomic.Int64
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

func (g *Gate) consume(body []byte) error {
	var request struct {
		Model    string `json:"model"`
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	var identity struct {
		Session string `json:"session_id"`
	}
	var grant Grant
	if json.Unmarshal(body, &request) != nil || json.Unmarshal([]byte(request.Metadata.UserID), &identity) != nil || identity.Session != g.Session {
		return errors.New("native_session_mismatch")
	}
	data, err := os.ReadFile(filepath.Join(g.Directory, "grant.json"))
	if err != nil || json.Unmarshal(data, &grant) != nil || !uuidPattern.MatchString(grant.ID) ||
		grant.Session != g.Session || grant.Model != request.Model || grant.Expires < time.Now().UnixMilli() || grant.Expires > time.Now().Add(2*time.Minute).UnixMilli() {
		return errors.New("native_dispatch_not_authorized")
	}
	file, err := os.OpenFile(filepath.Join(g.Directory, grant.ID+".consumed.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("native_dispatch_already_consumed")
	}
	defer file.Close()
	hash := sha256.Sum256(body)
	if err = json.NewEncoder(file).Encode(map[string]any{"id": grant.ID, "session_id": g.Session, "model": request.Model, "at_ms": time.Now().UnixMilli(), "body_sha256": hex.EncodeToString(hash[:])}); err != nil {
		return err
	}
	return file.Sync()
}

func reply(conn net.Conn, status int, code string) {
	body, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]string{"type": "api_error", "code": code, "message": code}})
	response := &http.Response{StatusCode: status, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Close: true}
	_ = response.Write(conn)
}

func (g *Gate) forward(conn net.Conn, reader *bufio.Reader) {
	req, err := http.ReadRequest(reader)
	if err != nil {
		return
	}
	defer req.Body.Close()
	g.Requests.Add(1)
	requestHost := strings.ToLower(strings.TrimSuffix(req.Host, ":443"))
	requestHost = strings.TrimSuffix(requestHost, ".")
	if requestHost != "api.anthropic.com" {
		reply(conn, 400, "unexpected_host")
		return
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, 16*1024*1024+1))
	if err != nil || len(body) > 16*1024*1024 {
		reply(conn, 413, "body_limit")
		return
	}
	if req.Method == "POST" && req.URL.Path == "/v1/messages" {
		if err = g.consume(body); err != nil {
			g.Denied.Add(1)
			reply(conn, 429, err.Error())
			return
		}
		g.Attempts.Add(1)
	}
	req.URL.Scheme = "https"
	req.URL.Host = "api.anthropic.com"
	req.RequestURI = ""
	req.Close = true
	req.Body = io.NopCloser(bytes.NewReader(body))
	req.ContentLength = int64(len(body))
	req.TransferEncoding = nil
	if _, found := req.Header["User-Agent"]; !found {
		req.Header["User-Agent"] = []string{""}
	}
	response, err := g.Transport.RoundTrip(req)
	if err != nil {
		reply(conn, 502, "native_transport_error")
		return
	}
	defer response.Body.Close()
	response.Close = true
	// RFC 9112: 304 ends at the headers, regardless of a malformed chunk marker.
	if response.StatusCode == 304 || response.StatusCode == 204 || req.Method == "HEAD" {
		if response.StatusCode == 304 {
			g.Normalized.Add(1)
		}
		response.Body.Close()
		response.Body = http.NoBody
		response.TransferEncoding = nil
		response.ContentLength = 0
		response.Header.Del("Transfer-Encoding")
		response.Header.Del("Content-Length")
	}
	_ = response.Write(conn)
}

func (g *Gate) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.Method == "GET" && req.URL.Path == "/healthz" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"upstream_attempts": g.Attempts.Load(), "denied": g.Denied.Load(), "requests": g.Requests.Load(), "normalized_304": g.Normalized.Load()})
		return
	}
	active := g.Active.Add(1)
	defer g.Active.Add(-1)
	if active > 32 {
		http.Error(w, "private connection budget", 503)
		return
	}
	host, port, err := net.SplitHostPort(req.Host)
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if req.Method != "CONNECT" || err != nil || port != "443" || host == "" {
		http.Error(w, "CONNECT required", 400)
		return
	}
	conn, buffered, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(12 * time.Minute))
	if host != "api.anthropic.com" {
		upstream, err := net.DialTimeout("tcp", g.Upstream, 5*time.Second)
		if err != nil {
			reply(conn, 502, "native_proxy_unavailable")
			return
		}
		defer upstream.Close()
		_ = upstream.SetDeadline(time.Now().Add(12 * time.Minute))
		if req.Write(upstream) != nil {
			return
		}
		done := make(chan struct{})
		go func() {
			_, _ = io.Copy(upstream, buffered)
			if tcp, ok := upstream.(*net.TCPConn); ok {
				_ = tcp.CloseWrite()
			}
			close(done)
		}()
		_, _ = io.Copy(conn, upstream)
		_ = conn.Close()
		_ = upstream.Close()
		<-done
		return
	}
	if _, err = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	config := &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}}
	if g.GetCertificate != nil {
		config.GetCertificate = g.GetCertificate
	} else {
		config.Certificates = []tls.Certificate{g.Certificate}
	}
	tunnel := tls.Server(conn, config)
	defer tunnel.Close()
	if tunnel.Handshake() != nil {
		return
	}
	g.forward(tunnel, bufio.NewReader(tunnel))
}

func certificate(caFile, keyFile string) (tls.Certificate, *x509.CertPool, error) {
	ca, err := tls.LoadX509KeyPair(caFile, keyFile)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	issuer, err := x509.ParseCertificate(ca.Certificate[0])
	if err != nil || !issuer.IsCA {
		return tls.Certificate{}, nil, errors.New("native_ca_required")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	leaf := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "api.anthropic.com"}, DNSNames: []string{"api.anthropic.com"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, leaf, issuer, &key.PublicKey, ca.PrivateKey)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	roots := x509.NewCertPool()
	roots.AddCert(issuer)
	return tls.Certificate{Certificate: [][]byte{der, issuer.Raw}, PrivateKey: key}, roots, nil
}

// Renew only this native CA's transient transport leaf; never change its key or identity.
func rotatingCertificate(initial tls.Certificate, renew func() (tls.Certificate, error), now func() time.Time) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	var lock sync.Mutex
	current := initial
	return func(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
		lock.Lock()
		defer lock.Unlock()
		leaf, err := x509.ParseCertificate(current.Certificate[0])
		if err != nil {
			return nil, err
		}
		if now().Add(5 * time.Minute).After(leaf.NotAfter) {
			next, err := renew()
			if err != nil {
				return nil, err
			}
			current = next
		}
		result := current
		return &result, nil
	}
}

func main() {
	listen := flag.String("listen", "127.0.0.1:39258", "private loopback listener")
	upstream := flag.String("upstream", "127.0.0.1:38963", "original native proxy")
	directory := flag.String("directory", "", "private request grants")
	session := flag.String("session", "", "native CLI session UUID")
	ca := flag.String("ca", "", "own native CA certificate")
	key := flag.String("ca-key", "", "own native CA private key, never exported")
	flag.Parse()
	for _, address := range []string{*listen, *upstream} {
		host, _, err := net.SplitHostPort(address)
		if err != nil || host != "127.0.0.1" {
			log.Fatal("loopback required")
		}
	}
	if !uuidPattern.MatchString(*session) || *directory == "" {
		log.Fatal("session and private directory required")
	}
	cert, roots, err := certificate(*ca, *key)
	if err != nil {
		log.Fatal("cannot load own native CA")
	}
	proxy, _ := url.Parse("http://" + *upstream)
	transport := &http.Transport{Proxy: http.ProxyURL(proxy), TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, DisableKeepAlives: true, DisableCompression: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 120 * time.Second}
	renew := func() (tls.Certificate, error) { next, _, err := certificate(*ca, *key); return next, err }
	gate := &Gate{Directory: *directory, Session: *session, Upstream: *upstream, GetCertificate: rotatingCertificate(cert, renew, time.Now), Transport: transport}
	server := &http.Server{Addr: *listen, Handler: gate, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 65536, ErrorLog: log.New(io.Discard, "", 0)}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal("private listener unavailable")
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"listen": listener.Addr().String(), "session_id": *session})
	parent := os.Getppid()
	go func() {
		for range time.Tick(time.Second) {
			if os.Getppid() != parent {
				_ = listener.Close()
				return
			}
		}
	}()
	if err = server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("private listener stopped")
	}
}
