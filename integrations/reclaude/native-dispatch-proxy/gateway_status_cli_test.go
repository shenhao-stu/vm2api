package main

import (
	"bytes"
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Run the distributed CLI against a synthetic failing gateway.
func TestActualCLIGatewayErrorKeepsFirstResponse(t *testing.T) {
	cli := os.Getenv("NATIVE_CLI")
	if cli == "" {
		t.Skip("set NATIVE_CLI in an isolated network")
	}
	dir := t.TempDir()
	cert, _ := fixtureCA(t)
	gate := &Gate{Directory: dir, Session: testSession, Certificate: cert, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		status := http.StatusNotFound
		if r.URL.Path == "/v1/messages" {
			status = http.StatusBadGateway
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: http.NoBody}, nil
	})}
	fixtureGrant(t, dir, Grant{grantID, testSession, "claude-haiku-5-5", time.Now().Add(time.Minute).UnixMilli()})
	proxy := httptest.NewServer(gate)
	defer proxy.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, cli, "--bare", "--model", "claude-haiku-5-5", "--session-id", testSession, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "-p", "Synthetic gateway failure.")
	c.Dir = dir
	c.Env = []string{"HOME=" + dir, "PATH=/opt/native:/usr/bin:/bin", "CLAUDE_CONFIG_DIR=" + filepath.Join(dir, "profile"), "ANTHROPIC_API_KEY=offline-fixture", "HTTP_PROXY=" + proxy.URL, "HTTPS_PROXY=" + proxy.URL, "NO_PROXY=127.0.0.1,localhost", "NODE_EXTRA_CA_CERTS=" + filepath.Join(dir, "ca.pem"), "CLAUDE_CODE_MAX_RETRIES=0", "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1"}
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[1]}), 0600); err != nil {
		t.Fatal(err)
	}
	output, _ := c.CombinedOutput()
	if ctx.Err() != nil || gate.Attempts.Load() != 1 || gate.Denied.Load() != 0 || !bytes.Contains(output, []byte("native_gateway_error_no_replay")) || bytes.Contains(output, []byte("native_dispatch_already_consumed")) {
		t.Fatalf("attempts=%d denied=%d marker=%v deadline=%v", gate.Attempts.Load(), gate.Denied.Load(), bytes.Contains(output, []byte("native_gateway_error_no_replay")), ctx.Err())
	}
}
