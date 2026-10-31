package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTransportLeafRenewsWithoutChangingPreviouslyReturnedCertificate(t *testing.T) {
	makeLeaf := func(until time.Time) tls.Certificate {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		leaf := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: until}
		der, err := x509.CreateCertificate(rand.Reader, leaf, leaf, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	}
	now := time.Now()
	initial := makeLeaf(now.Add(10 * time.Minute))
	fresh := makeLeaf(now.Add(time.Hour))
	var renewals atomic.Int64
	get := rotatingCertificate(initial, func() (tls.Certificate, error) { renewals.Add(1); return fresh, nil }, func() time.Time { return now })
	old, err := get(nil)
	if err != nil || renewals.Load() != 0 {
		t.Fatal("valid leaf should be reused")
	}
	now = now.Add(6 * time.Minute)
	var wait sync.WaitGroup
	for range 40 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			next, err := get(nil)
			if err != nil || !bytes.Equal(next.Certificate[0], fresh.Certificate[0]) {
				t.Error("renewal failed")
			}
		}()
	}
	wait.Wait()
	if renewals.Load() != 1 || !bytes.Equal(old.Certificate[0], initial.Certificate[0]) {
		t.Fatal("renewal raced or mutated an in-flight certificate")
	}
	fail := rotatingCertificate(initial, func() (tls.Certificate, error) { return tls.Certificate{}, errors.New("own CA unavailable") }, func() time.Time { return now })
	if _, err := fail(nil); err == nil {
		t.Fatal("failed renewal must not use a stale leaf")
	}
}

func TestActualCLIOutputRecoveryCannotDispatchTwice(t *testing.T) {
	cli := os.Getenv("NATIVE_CLI")
	if cli == "" {
		t.Skip("set NATIVE_CLI for the actual offline executable")
	}
	cert, roots := fixtureCA(t)
	dir := t.TempDir()
	g := &Gate{Directory: dir, Session: testSession, Certificate: cert}
	g.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/v1/messages" {
			return &http.Response{StatusCode: 404, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{}, ContentLength: 0, Body: http.NoBody}, nil
		}
		stop, text, tokens := "max_tokens", "PARTIAL", 1024
		if g.Attempts.Load() > 1 {
			stop, text, tokens = "end_turn", "RESUMED_NEW_TURN", 5
			request, _ := io.ReadAll(req.Body)
			if !bytes.Contains(request, []byte("PARTIAL")) || !bytes.Contains(request, []byte("A genuinely new caller turn.")) || bytes.Contains(request, []byte("native_dispatch_already_consumed")) {
				t.Error("native resume lost the original assistant boundary or replayed the recovery error")
			}
		}
		events := []map[string]any{
			{"type": "message_start", "message": map[string]any{"id": "msg_offline_budget", "type": "message", "role": "assistant", "model": "claude-haiku-5-5", "content": []any{}, "stop_reason": nil, "usage": map[string]int{"input_tokens": 2, "output_tokens": 0}}},
			{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}},
			{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}},
			{"type": "content_block_stop", "index": 0},
			{"type": "message_delta", "delta": map[string]string{"stop_reason": stop}, "usage": map[string]int{"output_tokens": tokens}},
			{"type": "message_stop"},
		}
		var body bytes.Buffer
		for _, event := range events {
			data, _ := json.Marshal(event)
			body.WriteString("event: " + event["type"].(string) + "\ndata: " + string(data) + "\n\n")
		}
		return &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, ContentLength: -1, Body: io.NopCloser(&body)}, nil
	})
	proxy := httptest.NewServer(g)
	defer proxy.Close()
	// Test CA is synthetic and confined to this isolated fixture profile.
	ca := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[1]}), 0600); err != nil {
		t.Fatal(err)
	}
	_ = roots
	fixtureGrant(t, dir, Grant{grantID, testSession, "claude-haiku-5-5", time.Now().Add(time.Minute).UnixMilli()})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, cli, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--tools", "", "--session-id", testSession, "--model", "claude-haiku-5-5", "--max-turns", "8", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "-p", "Offline maximum-token fixture.")
	command.Dir = dir
	command.Env = []string{"PATH=/opt/native:/opt/homebrew/bin:/usr/bin:/bin", "HOME=" + dir, "CLAUDE_CONFIG_DIR=" + filepath.Join(dir, "profile"), "ANTHROPIC_BASE_URL=https://api.anthropic.com", "ANTHROPIC_AUTH_TOKEN=offline-fixture-credential", "HTTP_PROXY=" + proxy.URL, "HTTPS_PROXY=" + proxy.URL, "NO_PROXY=localhost,127.0.0.1,::1", "NODE_EXTRA_CA_CERTS=" + ca, "CLAUDE_CODE_MAX_RETRIES=0", "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1", "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=0", "CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024"}
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("native fixture did not finish: %v", ctx.Err())
	}
	if g.Attempts.Load() != 1 || g.Denied.Load() < 1 {
		t.Fatalf("attempts=%d denied=%d exit=%v output=%s", g.Attempts.Load(), g.Denied.Load(), err, output)
	}
	if !bytes.Contains(output, []byte("native_dispatch_already_consumed")) {
		t.Fatalf("native recovery was not explicitly rejected: %s", output)
	}
	var assistantUUID string
	for _, line := range bytes.Split(output, []byte("\n")) {
		var event struct {
			Type    string
			UUID    string
			Message struct{ ID string }
		}
		if json.Unmarshal(line, &event) == nil && event.Type == "assistant" && event.Message.ID == "msg_offline_budget" {
			assistantUUID = event.UUID
		}
	}
	if assistantUUID == "" {
		t.Fatal("native assistant resume point missing")
	}
	fixtureGrant(t, dir, Grant{"22222222-2222-3333-4444-666666666666", testSession, "claude-haiku-5-5", time.Now().Add(time.Minute).UnixMilli()})
	args := append([]string(nil), command.Args[1:]...)
	for i := range args {
		if args[i] == "--session-id" {
			args[i] = "--resume"
		}
	}
	args[len(args)-1] = "A genuinely new caller turn."
	args = append(args, "--resume-session-at", assistantUUID)
	resumed := exec.CommandContext(ctx, cli, args...)
	resumed.Dir = dir
	resumed.Env = command.Env
	next, err := resumed.CombinedOutput()
	if err != nil || g.Attempts.Load() != 2 || !bytes.Contains(next, []byte("RESUMED_NEW_TURN")) {
		t.Fatalf("native continuation failed without replay: calls=%d exit=%v output=%s", g.Attempts.Load(), err, next)
	}
}

const testSession = "11111111-2222-3333-4444-555555555555"
const grantID = "11111111-2222-3333-4444-666666666666"

type roundTrip func(*http.Request) (*http.Response, error)

func (r roundTrip) RoundTrip(q *http.Request) (*http.Response, error) { return r(q) }

func modelBody(session, model string) []byte {
	identity, _ := json.Marshal(map[string]string{"session_id": session})
	body, _ := json.Marshal(map[string]any{"model": model, "metadata": map[string]string{"user_id": string(identity)}, "messages": []any{}})
	return body
}

func fixtureGrant(t *testing.T, dir string, grant Grant) {
	t.Helper()
	body, _ := json.Marshal(grant)
	if err := os.WriteFile(filepath.Join(dir, "grant.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentGrantConsumedExactlyOnce(t *testing.T) {
	g := Gate{Directory: t.TempDir(), Session: testSession}
	fixtureGrant(t, g.Directory, Grant{grantID, testSession, "fixture", time.Now().Add(time.Minute).UnixMilli()})
	var successes atomic.Int64
	var workers sync.WaitGroup
	for i := 0; i < 40; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if g.consume(modelBody(testSession, "fixture")) == nil {
				successes.Add(1)
			}
		}()
	}
	workers.Wait()
	if successes.Load() != 1 {
		t.Fatalf("accepted %d duplicate dispatches", successes.Load())
	}
	if _, err := os.Stat(filepath.Join(g.Directory, grantID+".consumed.json")); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidGrantNeverConsumes(t *testing.T) {
	g := Gate{Directory: t.TempDir(), Session: testSession}
	valid := Grant{grantID, testSession, "fixture", time.Now().Add(time.Minute).UnixMilli()}
	for _, grant := range []Grant{{grantID, "other", "fixture", valid.Expires}, {grantID, testSession, "other", valid.Expires}, {grantID, testSession, "fixture", 1}, {"../unsafe", testSession, "fixture", valid.Expires}} {
		fixtureGrant(t, g.Directory, grant)
		if g.consume(modelBody(testSession, "fixture")) == nil {
			t.Fatal("invalid grant accepted")
		}
	}
	fixtureGrant(t, g.Directory, valid)
	if g.consume(modelBody("other", "fixture")) == nil {
		t.Fatal("foreign session accepted")
	}
	if _, err := os.Stat(filepath.Join(g.Directory, grantID+".consumed.json")); !os.IsNotExist(err) {
		t.Fatal("invalid call consumed grant")
	}
}

func fixtureCA(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(2 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	ca := filepath.Join(dir, "ca.pem")
	private := filepath.Join(dir, "ca.key")
	if err = os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(private, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0600); err != nil {
		t.Fatal(err)
	}
	cert, roots, err := certificate(ca, private)
	if err != nil {
		t.Fatal(err)
	}
	return cert, roots
}

func TestRealTLS304FramingAndSingleModelDispatch(t *testing.T) {
	cert, roots := fixtureCA(t)
	var modelCalls atomic.Int64
	g := &Gate{Directory: t.TempDir(), Session: testSession, Certificate: cert}
	g.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "Bearer fixture-secret" || req.Header.Get("User-Agent") != "truthful-fixture/1" {
			t.Error("caller headers changed")
		}
		if req.URL.Host != "api.anthropic.com" || req.URL.Scheme != "https" || !req.Close {
			t.Error("native transport invariant failed")
		}
		if req.URL.Path == "/api/claude_code/policy_limits" {
			if req.Header.Get("If-None-Match") != "actual-validator" {
				t.Error("policy validator changed")
			}
			return &http.Response{StatusCode: 304, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"ETag": []string{"actual-validator"}, "Transfer-Encoding": []string{"chunked"}}, TransferEncoding: []string{"chunked"}, ContentLength: -1, Body: io.NopCloser(strings.NewReader("0\r\n\r\n"))}, nil
		}
		modelCalls.Add(1)
		body, _ := io.ReadAll(req.Body)
		if !bytes.Equal(body, modelBody(testSession, "fixture")) {
			t.Error("model request changed")
		}
		return &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, ContentLength: -1, Body: io.NopCloser(strings.NewReader("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"))}, nil
	})
	proxy := httptest.NewServer(g)
	defer proxy.Close()
	u, _ := url.Parse(proxy.URL)
	transport := &http.Transport{Proxy: http.ProxyURL(u), TLSClientConfig: &tls.Config{RootCAs: roots}, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	request := func(method, path string, body []byte) *http.Response {
		t.Helper()
		q, _ := http.NewRequest(method, "https://api.anthropic.com"+path, bytes.NewReader(body))
		q.Header.Set("Authorization", "Bearer fixture-secret")
		q.Header.Set("User-Agent", "truthful-fixture/1")
		q.Header.Set("If-None-Match", "actual-validator")
		r, err := client.Do(q)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	r := request("GET", "/api/claude_code/policy_limits", nil)
	body, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil || len(body) != 0 || r.StatusCode != 304 || len(r.TransferEncoding) != 0 || r.Header.Get("ETag") != "actual-validator" {
		t.Fatal("304 framing or validator invalid")
	}
	fixtureGrant(t, g.Directory, Grant{grantID, testSession, "fixture", time.Now().Add(time.Minute).UnixMilli()})
	for _, status := range []int{200, 429} {
		r = request("POST", "/v1/messages", modelBody(testSession, "fixture"))
		body, err = io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil || r.StatusCode != status {
			t.Fatalf("status %d, want %d: %v", r.StatusCode, status, err)
		}
		if status == 200 && !bytes.Contains(body, []byte("event: message_stop")) {
			t.Fatal("stream modified")
		}
	}
	if modelCalls.Load() != 1 || g.Attempts.Load() != 1 || g.Denied.Load() != 1 {
		t.Fatal("unrequested model reached native backend")
	}
}
