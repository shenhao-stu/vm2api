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
	"strings"
	"testing"
	"time"
)

// The real CLI and Gate consume one synthetic grant. Only the provider body's
// terminal boundary changes: a complete stream versus an interrupted body.
func TestActualCLIInterruptedStreamDoesNotProvideFinalUsage(t *testing.T) {
	cli := os.Getenv("NATIVE_CLI")
	if cli == "" {
		t.Skip("set NATIVE_CLI for the actual offline executable")
	}
	for _, complete := range []bool{true, false} {
		t.Run(map[bool]string{true: "complete", false: "interrupted"}[complete], func(t *testing.T) {
			cert, _ := fixtureCA(t)
			dir := t.TempDir()
			gate := &Gate{Directory: dir, Session: testSession, Certificate: cert}
			gate.Transport = roundTrip(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path != "/v1/messages" {
					return &http.Response{StatusCode: 404, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{}, ContentLength: 0, Body: http.NoBody}, nil
				}
				reader, writer := io.Pipe()
				go func() {
					writeEvent := func(value map[string]any) {
						data, _ := json.Marshal(value)
						_, _ = io.WriteString(writer, "event: "+value["type"].(string)+"\ndata: "+string(data)+"\n\n")
					}
					writeEvent(map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_stream_reset_fixture", "type": "message", "role": "assistant", "model": "claude-haiku-5-5", "content": []any{}, "stop_reason": nil, "usage": map[string]any{"input_tokens": 2, "output_tokens": 6, "cache_read_input_tokens": 7, "cache_creation_input_tokens": 9, "cache_creation": map[string]int{"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 9}}}})
					writeEvent(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "thinking", "thinking": ""}})
					writeEvent(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "thinking_delta", "thinking": "Synthetic fixture only."}})
					// Let the reader observe initial frames before changing the seam.
					time.Sleep(150 * time.Millisecond)
					if !complete {
						_ = writer.CloseWithError(io.ErrUnexpectedEOF)
						return
					}
					writeEvent(map[string]any{"type": "content_block_stop", "index": 0})
					writeEvent(map[string]any{"type": "content_block_start", "index": 1, "content_block": map[string]string{"type": "text", "text": ""}})
					writeEvent(map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]string{"type": "text_delta", "text": "OK"}})
					writeEvent(map[string]any{"type": "content_block_stop", "index": 1})
					writeEvent(map[string]any{"type": "message_delta", "delta": map[string]string{"stop_reason": "end_turn"}, "usage": map[string]int{"output_tokens": 23}})
					writeEvent(map[string]any{"type": "message_stop"})
					_ = writer.Close()
				}()
				return &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, ContentLength: -1, Body: reader}, nil
			})
			proxy := httptest.NewServer(gate)
			defer proxy.Close()
			ca := filepath.Join(dir, "ca.pem")
			if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[1]}), 0600); err != nil {
				t.Fatal(err)
			}
			fixtureGrant(t, dir, Grant{grantID, testSession, "claude-haiku-5-5", time.Now().Add(time.Minute).UnixMilli()})
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, cli, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--tools", "", "--session-id", testSession, "--model", "claude-haiku-5-5", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "-p", "Synthetic transport fixture.")
			command.Dir = dir
			command.Env = []string{"PATH=/opt/native:/opt/homebrew/bin:/usr/bin:/bin", "HOME=" + dir, "CLAUDE_CONFIG_DIR=" + filepath.Join(dir, "profile"), "ANTHROPIC_BASE_URL=https://api.anthropic.com", "ANTHROPIC_AUTH_TOKEN=offline-only", "HTTP_PROXY=" + proxy.URL, "HTTPS_PROXY=" + proxy.URL, "NO_PROXY=localhost,127.0.0.1,::1", "NODE_EXTRA_CA_CERTS=" + ca, "CLAUDE_CODE_MAX_RETRIES=0", "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1", "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=0", "CLAUDE_CODE_MAX_OUTPUT_TOKENS=128"}
			output, exitError := command.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatal(ctx.Err())
			}
			grants, _ := filepath.Glob(filepath.Join(dir, "*.consumed.json"))
			if gate.Attempts.Load() != 1 || gate.Denied.Load() != 0 || len(grants) != 1 {
				t.Fatalf("attempts=%d denied=%d grants=%d", gate.Attempts.Load(), gate.Denied.Load(), len(grants))
			}
			initial, final, syntheticDelta, apiError := false, false, false, false
			for _, line := range bytes.Split(output, []byte("\n")) {
				var value map[string]any
				if json.Unmarshal(line, &value) != nil {
					continue
				}
				if value["type"] == "assistant" && value["is_api_error_message"] == true {
					apiError = true
				}
				if value["type"] != "stream_event" {
					continue
				}
				event := value["event"].(map[string]any)
				if event["type"] == "message_start" {
					initial = event["message"].(map[string]any)["usage"].(map[string]any)["output_tokens"] == float64(6)
				}
				if event["type"] == "message_delta" {
					delta := event["delta"].(map[string]any)
					usage := event["usage"].(map[string]any)
					final = delta["stop_reason"] == "end_turn" && usage["output_tokens"] == float64(23)
					syntheticDelta = apiError && delta["stop_reason"] == nil && usage["output_tokens"] == float64(6)
				}
			}
			if !initial || final != complete || (exitError == nil) != complete || apiError == complete {
				t.Fatalf("initial=%t final=%t api_error=%t exit=%v synthetic_fixture_output=%s", initial, final, apiError, exitError, output)
			}
			if !complete && (!syntheticDelta || (!strings.Contains(string(output), "StreamTruncated") && !strings.Contains(string(output), "ECONNRESET"))) {
				t.Fatalf("reset/synthetic error delta missing: %s", output)
			}
			if !complete {
				trace := readTrace(t, gate)
				if trace["stage"] != "provider_body" || trace["class"] != "unexpected_eof" || trace["provider_bytes"].(float64) <= 0 {
					t.Fatalf("real CLI transport failure was misclassified: %#v", trace)
				}
			}
			t.Logf("complete=%t initial=6 terminal23=%t synthetic_null_stop=%t stream_truncated=%t reset=%t attempts=1 denied=0 real_provider_calls=0", complete, final, syntheticDelta, strings.Contains(string(output), "StreamTruncated"), strings.Contains(string(output), "ECONNRESET"))
		})
	}
}
