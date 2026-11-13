package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCallerToolAliasesAreDeclaredAndUnambiguous(t *testing.T) {
	a := callerToolAliases([]byte(`{"tools":[{"name":"mcp__caller__Agent"},{"name":"Bash"},{"name":"mcp__caller__Bash"}]}`))
	if len(a) != 1 || a["Agent"] != "mcp__caller__Agent" {
		t.Fatal(a)
	}
}

func TestAPIToolMappingKeepsOriginalReceiptAndOneDispatch(t *testing.T) {
	dir := t.TempDir()
	base, _ := url.Parse("https://example.com")
	original := "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"owned\",\"name\":\"Agent\",\"input\":{}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":2,\"output_tokens\":7,\"cache_creation\":{\"ephemeral_1h_input_tokens\":13}}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	g := &Gate{Directory: dir, Session: testSession, APIBase: base, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(original)), ContentLength: int64(len(original))}, nil
	})}
	fixtureGrant(t, dir, Grant{grantID, testSession, "fixture", time.Now().Add(time.Minute).UnixMilli()})
	identity, _ := json.Marshal(map[string]string{"session_id": testSession})
	body, _ := json.Marshal(map[string]any{"model": "fixture", "metadata": map[string]string{"user_id": string(identity)}, "tools": []map[string]string{{"name": "mcp__caller__Agent"}}})
	s := httptest.NewServer(g)
	defer s.Close()
	resp, err := s.Client().Post(s.URL+"/v1/messages", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || !bytes.Contains(data, []byte(`"name":"mcp__caller__Agent"`)) || !bytes.Contains(data, []byte(`"ephemeral_1h_input_tokens":13`)) {
		t.Fatalf("mapped response: %s %v", data, err)
	}
	deadline := time.Now().Add(time.Second)
	for g.Active.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	raw, err := os.ReadFile(filepath.Join(dir, grantID+".api-stream.private"))
	if err != nil || string(raw) != original || g.Attempts.Load() != 1 {
		t.Fatal("raw usage evidence changed or request duplicated")
	}
	terminal, err := os.ReadFile(filepath.Join(dir, grantID+".api-terminal.json"))
	var marker struct {
		Complete bool
		Bytes    int
	}
	if err != nil || json.Unmarshal(terminal, &marker) != nil || !marker.Complete || marker.Bytes != len(original) {
		t.Fatal("original terminal not durable")
	}
}

func TestCompressedSSEKeepsOriginalProviderEvents(t *testing.T) {
	for _, encoding := range []string{"", "gzip", "br"} {
		t.Run(encoding, func(t *testing.T) {
			original := []byte(`data: {"type":"message_stop"}` + "\n\n")
			var wire bytes.Buffer
			if encoding == "gzip" {
				z := gzip.NewWriter(&wire)
				_, _ = z.Write(original)
				_ = z.Close()
			} else {
				wire.Write(original)
			}
			r := &http.Response{Header: make(http.Header), Body: io.NopCloser(&wire), ContentLength: int64(wire.Len())}
			if encoding != "" {
				r.Header.Set("Content-Encoding", encoding)
			}
			err := decodeAPIEventStream(r)
			if encoding == "br" {
				if err == nil {
					t.Fatal("unsupported coding accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(r.Body)
			if err != nil || !bytes.Equal(data, original) || r.Header.Get("Content-Encoding") != "" {
				t.Fatalf("stream mismatch: %v", err)
			}
		})
	}
}

func TestToolAliasStreamChangesOnlyDeclaredToolName(t *testing.T) {
	raw := "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"one\",\"name\":\"Agent\",\"input\":{}}}\n\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"Agent\"}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n"
	under := io.NopCloser(strings.NewReader(raw))
	r := &toolAliasReader{ReadCloser: under, reader: bufio.NewReader(under), aliases: map[string]string{"Agent": "mcp__caller__Agent"}}
	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if !strings.Contains(s, `"name":"mcp__caller__Agent"`) || !strings.Contains(s, `"partial_json":"Agent"`) || !strings.Contains(s, `"output_tokens":7`) || strings.Count(s, "mcp__caller__") != 1 {
		t.Fatal(s)
	}
}
