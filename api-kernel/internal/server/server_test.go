package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/api-kernel/internal/pool"
)

func TestForwardCopiesUpstream(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("X-Api-Key") != "sk-test" {
			t.Fatalf("missing x-api-key")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: {\"type\":\"message_stop\"}\n\n")
	}))
	defer up.Close()

	h := (&Server{Token: "t", Pool: pool.NewManager()}).Handler()
	env, _ := json.Marshal(forwardEnv{
		Method:  "POST",
		URL:     up.URL + "/v1/messages?beta=true",
		Headers: map[string]string{"x-api-key": "sk-test"},
		Body:    `{"model":"x"}`,
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/forward", strings.NewReader(string(env)))
	req.Header.Set("X-Kin-Internal-Token", "t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "message_stop") {
		t.Fatalf("body %s", rec.Body.String())
	}
}

// The upstream keeps the stream open until the proxy's client sees the first
// event. A recorder cannot catch buffering by net/http's network writer.
func TestForwardDeliversSSEBeforeUpstreamFinishes(t *testing.T) {
	testForwardLiveStream(t, false)
}

func TestForwardCancelsUpstreamWhenStreamClientDisconnects(t *testing.T) {
	testForwardLiveStream(t, true)
}

func testForwardLiveStream(t *testing.T, disconnect bool) {
	t.Helper()
	const first = "data: first\n\n"
	const terminal = "data: done\n\n"
	next := make(chan struct{})
	canceled := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		_, _ = io.WriteString(w, first)
		w.(http.Flusher).Flush()
		select {
		case <-next:
			_, _ = io.WriteString(w, terminal)
		case <-r.Context().Done():
			close(canceled)
		}
	}))
	defer up.Close()
	proxy := httptest.NewServer((&Server{Pool: pool.NewManager()}).Handler())
	defer proxy.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	env, _ := json.Marshal(forwardEnv{URL: up.URL})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxy.URL+"/internal/forward", strings.NewReader(string(env)))
	resp, err := proxy.Client().Do(req)
	if err != nil {
		t.Fatalf("waiting for first event: %v", err)
	}
	defer resp.Body.Close()
	buf := make([]byte, len(first))
	if _, err := io.ReadFull(resp.Body, buf); err != nil || string(buf) != first {
		t.Fatalf("first event %q, error %v", buf, err)
	}
	if disconnect {
		resp.Body.Close()
		select {
		case <-canceled:
		case <-ctx.Done():
			t.Fatal("client disconnected but upstream context stayed open")
		}
		return
	}
	close(next)
	rest, err := io.ReadAll(resp.Body)
	if err != nil || string(rest) != terminal {
		t.Fatalf("terminal event %q, error %v", rest, err)
	}
}
