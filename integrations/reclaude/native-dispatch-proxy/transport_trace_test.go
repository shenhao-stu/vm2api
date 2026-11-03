package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type traceConn struct {
	bytes.Buffer
	fail bool
}

func (c *traceConn) Write(p []byte) (int, error) {
	if c.fail {
		return 0, syscall.EPIPE
	}
	return c.Buffer.Write(p)
}
func (*traceConn) Close() error                     { return nil }
func (*traceConn) LocalAddr() net.Addr              { return nil }
func (*traceConn) RemoteAddr() net.Addr             { return nil }
func (*traceConn) SetDeadline(time.Time) error      { return nil }
func (*traceConn) SetReadDeadline(time.Time) error  { return nil }
func (*traceConn) SetWriteDeadline(time.Time) error { return nil }

type failingBody struct {
	io.Reader
	err error
}

func (r *failingBody) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err == io.EOF {
		return n, r.err
	}
	return n, err
}
func (*failingBody) Close() error { return nil }

func traceRequest(t *testing.T, transport roundTrip, failedWrite bool) (*Gate, *traceConn) {
	t.Helper()
	g := &Gate{Directory: t.TempDir(), Session: testSession, Transport: transport}
	fixtureGrant(t, g.Directory, Grant{grantID, testSession, "fixture", time.Now().Add(time.Minute).UnixMilli()})
	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages?credential=never-record-this", bytes.NewReader(modelBody(testSession, "fixture")))
	req.Header.Set("Authorization", "Bearer never-record-this")
	var wire bytes.Buffer
	if err := req.Write(&wire); err != nil {
		t.Fatal(err)
	}
	conn := &traceConn{fail: failedWrite}
	g.forward(conn, bufio.NewReader(&wire))
	return g, conn
}

func readTrace(t *testing.T, g *Gate) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(g.Directory, "transport-errors.safe.jsonl"))
	if err != nil {
		t.Fatalf("transport diagnostic unavailable: %v", err)
	}
	if bytes.Contains(raw, []byte("never-record-this")) || bytes.Contains(raw, []byte("api.anthropic.com")) || bytes.Contains(raw, []byte("fixture-body")) || bytes.Contains(raw, []byte("private arbitrary failure")) {
		t.Fatal("diagnostic leaked URL, credential, body or arbitrary error")
	}
	var row map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(raw), &row); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"version": true, "grant_id": true, "request_sha256": true, "at_ms": true, "stage": true, "class": true, "status": true, "provider_bytes": true, "downstream_bytes": true, "elapsed_ms": true}
	for key := range row {
		if !allowed[key] {
			t.Fatalf("unexpected diagnostic field %q", key)
		}
	}
	consumed, _ := filepath.Glob(filepath.Join(g.Directory, "*.consumed.json"))
	if g.Attempts.Load() != 1 || g.Denied.Load() != 0 || len(consumed) != 1 {
		t.Fatal("diagnosis changed single-grant dispatch")
	}
	data, _ := os.ReadFile(consumed[0])
	var grant map[string]any
	if json.Unmarshal(data, &grant) != nil || row["grant_id"] != grant["id"] || row["request_sha256"] != grant["body_sha256"] {
		t.Fatal("diagnostic is not bound to the original consumed grant")
	}
	info, _ := os.Stat(filepath.Join(g.Directory, "transport-errors.safe.jsonl"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("diagnostic file permissions are not private")
	}
	return row
}

func TestTransportDiagnosticSeparatesBodyReadAndDownstreamWrite(t *testing.T) {
	for _, tc := range []struct {
		name, stage, class string
		readError          error
		writeError         bool
	}{
		{"truncated_provider", "provider_body", "unexpected_eof", io.ErrUnexpectedEOF, false},
		{"reset_provider", "provider_body", "connection_reset", syscall.ECONNRESET, false},
		{"disconnected_cli", "downstream_write", "broken_pipe", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g, _ := traceRequest(t, roundTrip(func(*http.Request) (*http.Response, error) {
				var body io.ReadCloser = io.NopCloser(strings.NewReader("fixture-body"))
				if tc.readError != nil {
					body = &failingBody{Reader: strings.NewReader("fixture-body"), err: tc.readError}
				}
				return &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, ContentLength: -1, Body: body}, nil
			}), tc.writeError)
			row := readTrace(t, g)
			if row["stage"] != tc.stage || row["class"] != tc.class || row["status"] != float64(200) || row["elapsed_ms"].(float64) < 0 {
				t.Fatalf("incorrect stage classification: %#v", row)
			}
			if !tc.writeError && row["provider_bytes"] != float64(len("fixture-body")) {
				t.Fatalf("observed bytes were lost: %#v", row)
			}
		})
	}
}

func TestTransportDiagnosticSanitizesArbitraryHeaderFailure(t *testing.T) {
	g, conn := traceRequest(t, roundTrip(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private arbitrary failure https://provider/secret?key=never-record-this")
	}), false)
	row := readTrace(t, g)
	if row["stage"] != "response_headers" || row["class"] != "other" || row["status"] != float64(0) {
		t.Fatalf("incorrect header classification: %#v", row)
	}
	if !strings.Contains(conn.String(), "native_transport_error") || strings.Contains(conn.String(), "private arbitrary") {
		t.Fatal("diagnostics changed client error privacy")
	}
}

func TestSuccessfulTransportDoesNotCreateErrorOrChangeResponse(t *testing.T) {
	g, conn := traceRequest(t, roundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{}, ContentLength: 12, Body: io.NopCloser(strings.NewReader("fixture-body"))}, nil
	}), false)
	if _, err := os.Stat(filepath.Join(g.Directory, "transport-errors.safe.jsonl")); !os.IsNotExist(err) {
		t.Fatal("successful transport should not create an error record")
	}
	if !strings.HasSuffix(conn.String(), "fixture-body") || g.Attempts.Load() != 1 {
		t.Fatal("successful response or dispatch changed")
	}
}

func TestTransportDiagnosticWriteFailureDoesNotAuthorizeOrMaskRequest(t *testing.T) {
	var g *Gate
	g, conn := traceRequest(t, roundTrip(func(*http.Request) (*http.Response, error) {
		return nil, syscall.ECONNRESET
	}), false)
	path := filepath.Join(g.Directory, "transport-errors.safe.jsonl")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	// Diagnostics may fail independently, but a consumed grant must never reset.
	g.recordTransport(grantID, modelBody(testSession, "fixture"), time.Now(), 0, "response_headers", syscall.ECONNRESET, 0, 0)
	if g.TraceFailures.Load() != 1 || g.Attempts.Load() != 1 || !strings.Contains(conn.String(), "native_transport_error") {
		t.Fatal("diagnostic I/O failure changed request handling")
	}
	if err := g.consume(modelBody(testSession, "fixture")); err == nil {
		t.Fatal("diagnostic I/O failure allowed replay")
	}
}

func TestTransportDiagnosticDoesNotFollowSymlink(t *testing.T) {
	g, _ := traceRequest(t, roundTrip(func(*http.Request) (*http.Response, error) {
		return nil, syscall.ECONNRESET
	}), false)
	path := filepath.Join(g.Directory, "transport-errors.safe.jsonl")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(t.TempDir(), "unrelated")
	if err := os.WriteFile(victim, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, path); err != nil {
		t.Fatal(err)
	}
	g.recordTransport(grantID, modelBody(testSession, "fixture"), time.Now(), 0, "response_headers", syscall.ECONNRESET, 0, 0)
	raw, _ := os.ReadFile(victim)
	if string(raw) != "keep" || g.TraceFailures.Load() != 1 || g.Attempts.Load() != 1 {
		t.Fatal("diagnostic followed a symlink or changed dispatch")
	}
}
