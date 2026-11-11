package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestAPIProviderRequiresAnExplicitHTTPSOrigin(t *testing.T) {
	for _, raw := range []string{"http://example.com", "https://a:b@example.com", "https://example.com/path", "https://example.com?key=a", "https://example.com#x", "https://"} {
		if _, err := apiProviderURL(raw); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	if _, err := apiProviderURL("https://example.com"); err != nil {
		t.Fatal(err)
	}
}

func TestAPIProviderPreservesNativeRequestAndAllowsOnePaidDispatch(t *testing.T) {
	dir := t.TempDir()
	base, _ := url.Parse("https://example.com")
	g := &Gate{Directory: dir, Session: testSession, APIBase: base}
	g.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://example.com/v1/messages?beta=true" || r.Host != "example.com" || r.Header.Get("X-Api-Key") != "fixture-key" || r.Header.Get("User-Agent") != "actual-cli-fixture" {
			t.Error("native request changed")
		}
		b, _ := io.ReadAll(r.Body)
		if !bytes.Contains(b, []byte("caller-system-preserved")) {
			t.Error("system lost")
		}
		return &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(bytes.NewBufferString("data: provider-final\n\n")), ContentLength: -1}, nil
	})
	grant, _ := json.Marshal(Grant{ID: "bbbbaaaa-0000-4000-8000-000000000001", Session: testSession, Model: "claude-sonnet-5-5", Expires: time.Now().Add(time.Minute).UnixMilli()})
	if err := os.WriteFile(filepath.Join(dir, "grant.json"), grant, 0600); err != nil {
		t.Fatal(err)
	}
	id, _ := json.Marshal(map[string]string{"session_id": testSession})
	body, _ := json.Marshal(map[string]any{"model": "claude-sonnet-5-5", "metadata": map[string]string{"user_id": string(id)}, "system": "caller-system-preserved"})
	s := httptest.NewServer(g)
	defer s.Close()
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, _ := http.NewRequest("POST", s.URL+"/v1/messages?beta=true", bytes.NewReader(body))
			r.Header.Set("X-Api-Key", "fixture-key")
			r.Header.Set("User-Agent", "actual-cli-fixture")
			resp, err := s.Client().Do(r)
			if err != nil {
				t.Error(err)
				return
			}
			defer resp.Body.Close()
			io.Copy(io.Discard, resp.Body)
		}()
	}
	wg.Wait()
	if g.Attempts.Load() != 1 || g.Denied.Load() != 9 {
		t.Fatalf("attempts=%d denied=%d", g.Attempts.Load(), g.Denied.Load())
	}
	for _, path := range []string{"/v1/other", "/v1/messages/../other"} {
		r, _ := http.Post(s.URL+path, "application/json", bytes.NewReader(body))
		if r.StatusCode != 400 {
			t.Error("unexpected operation accepted")
		}
		r.Body.Close()
	}
}

func TestAPIProviderRetainsOriginal429WithoutInvitingCLIRetry(t *testing.T) {
	dir := t.TempDir()
	base, _ := url.Parse("https://example.com")
	id := "bbbbaaaa-0000-4000-8000-000000000002"
	grant, _ := json.Marshal(Grant{ID: id, Session: testSession, Model: "claude-sonnet-5-5", Expires: time.Now().Add(time.Minute).UnixMilli()})
	if err := os.WriteFile(filepath.Join(dir, "grant.json"), grant, 0600); err != nil {
		t.Fatal(err)
	}
	identity, _ := json.Marshal(map[string]string{"session_id": testSession})
	body, _ := json.Marshal(map[string]any{"model": "claude-sonnet-5-5", "metadata": map[string]string{"user_id": string(identity)}})
	original := `{"error":{"message":"provider-restriction-fixture"}}`
	g := &Gate{Directory: dir, Session: testSession, APIBase: base, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 429, Status: "429 Too Many Requests", ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{}, Body: io.NopCloser(bytes.NewBufferString(original)), ContentLength: int64(len(original))}, nil
	})}
	s := httptest.NewServer(g)
	defer s.Close()
	r, err := s.Client().Post(s.URL+"/v1/messages", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	data, _ := io.ReadAll(r.Body)
	if r.StatusCode != 400 || string(data) != original || g.Attempts.Load() != 1 {
		t.Fatal("private CLI rejection lost the original body or permitted retry")
	}
	data, err = os.ReadFile(filepath.Join(dir, id+".provider-status.json"))
	var receipt struct{ Status int }
	if err != nil || json.Unmarshal(data, &receipt) != nil || receipt.Status != 429 {
		t.Fatal("original provider status was not retained")
	}
}
