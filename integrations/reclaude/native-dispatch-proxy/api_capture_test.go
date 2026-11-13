package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestAPICapturePreservesPartialEvidenceWithoutClaimingCompletion(t *testing.T) {
	for _, complete := range []bool{false, true} {
		dir := t.TempDir()
		g := &Gate{Directory: dir}
		capture, err := g.prepareAPICapture("fixture")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := g.prepareAPICapture("fixture"); err == nil {
			t.Fatal("overwrote an existing receipt")
		}
		capture.ReadCloser = io.NopCloser(bytes.NewBufferString("original-provider-bytes"))
		capture.status = 503
		if complete {
			_, _ = io.Copy(io.Discard, capture)
		} else {
			_, _ = capture.Read(make([]byte, 8))
		}
		capture.finish()
		capture.finish()
		data, _ := os.ReadFile(filepath.Join(dir, "fixture.api-terminal.json"))
		var terminal struct {
			Complete bool
			Status   int
			Bytes    int64
		}
		if json.Unmarshal(data, &terminal) != nil || terminal.Complete != complete || terminal.Status != 503 || terminal.Bytes == 0 {
			t.Fatal("lost original status or misclassified partial stream")
		}
		info, err := os.Stat(filepath.Join(dir, "fixture.api-stream.private"))
		if err != nil || info.Mode().Perm() != 0600 || info.Size() != terminal.Bytes {
			t.Fatal("private stream is not preserved")
		}
	}
}
