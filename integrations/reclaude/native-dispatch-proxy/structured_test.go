package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestActualCLIStructuredRecoveryCannotDispatchTwice(t *testing.T) {
	cli := os.Getenv("NATIVE_CLI")
	if cli == "" {
		t.Skip("set NATIVE_CLI for the actual offline executable")
	}
	cert, _ := fixtureCA(t)
	dir := t.TempDir()
	g := &Gate{Directory: dir, Session: testSession, Certificate: cert}
	g.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/v1/messages" {
			return &http.Response{StatusCode: 404, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{}, ContentLength: 0, Body: http.NoBody}, nil
		}
		request, _ := io.ReadAll(req.Body)
		if !bytes.Contains(request, []byte("StructuredOutput")) {
			t.Error("native schema tool missing")
		}
		events := []map[string]any{
			{"type": "message_start", "message": map[string]any{"id": "msg_schema_fixture", "type": "message", "role": "assistant", "model": "claude-haiku-5-5", "content": []any{}, "stop_reason": nil, "usage": map[string]int{"input_tokens": 7, "output_tokens": 0}}},
			{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "text", "text": ""}},
			{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "text_delta", "text": "{\"ok\":true}"}},
			{"type": "content_block_stop", "index": 0},
			{"type": "message_delta", "delta": map[string]string{"stop_reason": "end_turn"}, "usage": map[string]int{"output_tokens": 11}},
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
	ca := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[1]}), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGrant(t, dir, Grant{grantID, testSession, "claude-haiku-5-5", time.Now().Add(time.Minute).UnixMilli()})
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, cli, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--tools", "", "--session-id", testSession, "--model", "claude-haiku-5-5", "--json-schema", `{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}`, "--output-format", "stream-json", "--include-partial-messages", "--verbose", "-p", "Return the synthetic object.")
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/opt/native:/opt/homebrew/bin:/usr/bin:/bin", "HOME=" + dir, "CLAUDE_CONFIG_DIR=" + filepath.Join(dir, "profile"), "ANTHROPIC_BASE_URL=https://api.anthropic.com", "ANTHROPIC_AUTH_TOKEN=offline-fixture-only", "HTTP_PROXY=" + proxy.URL, "HTTPS_PROXY=" + proxy.URL, "NO_PROXY=localhost,127.0.0.1,::1", "NODE_EXTRA_CA_CERTS=" + ca, "CLAUDE_CODE_MAX_RETRIES=0", "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1", "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=0", "CLAUDE_CODE_MAX_OUTPUT_TOKENS=128"}
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatal(ctx.Err())
	}
	consumed, _ := filepath.Glob(filepath.Join(dir, "*.consumed.json"))
	if g.Attempts.Load() != 1 || g.Denied.Load() < 1 || len(consumed) != 1 || err == nil {
		t.Fatalf("attempts=%d denied=%d grants=%d exit=%v output=%s", g.Attempts.Load(), g.Denied.Load(), len(consumed), err, output)
	}
	usageObserved := false
	for _, line := range bytes.Split(output, []byte("\n")) {
		var event struct {
			Type  string
			Event struct {
				Type  string
				Usage struct {
					Output int `json:"output_tokens"`
				}
			}
		}
		if json.Unmarshal(line, &event) == nil && event.Type == "stream_event" && event.Event.Type == "message_delta" && event.Event.Usage.Output == 11 {
			usageObserved = true
		}
	}
	if !usageObserved || !bytes.Contains(output, []byte("native_dispatch_already_consumed")) {
		t.Fatalf("observed terminal usage or denial missing: %s", output)
	}
	t.Logf("actual CLI: one consumed grant, one synthetic provider dispatch, %d extra POSTs blocked, original output_tokens=11 retained; real provider calls=0", g.Denied.Load())
}
