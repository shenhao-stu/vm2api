package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type transferReader struct {
	io.ReadCloser
	bytes int64
	err   error
}

func (r *transferReader) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	r.bytes += int64(n)
	if err != nil && err != io.EOF {
		r.err = err
	}
	return n, err
}

type transferWriter struct {
	io.Writer
	bytes int64
	err   error
}

func (w *transferWriter) Write(p []byte) (int, error) {
	n, err := w.Writer.Write(p)
	w.bytes += int64(n)
	if err != nil {
		w.err = err
	}
	return n, err
}

func transportClass(err error) string {
	var network net.Error
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.As(err, &network) && network.Timeout():
		return "timeout"
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.ECONNABORTED):
		return "connection_reset"
	case errors.Is(err, syscall.EPIPE):
		return "broken_pipe"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "unexpected_eof"
	case errors.Is(err, net.ErrClosed), errors.Is(err, io.ErrClosedPipe):
		return "closed"
	default:
		return "other"
	}
}

// This is a transport diagnostic, never a final-usage or billing receipt.
// No provider/client error string, headers, URL or content crosses this boundary.
// A consumed request emits at most two bounded records; denied retries emit none.
func (g *Gate) recordTransport(grantID string, body []byte, started time.Time, status int, stage string, err error, readBytes, writtenBytes int64) {
	hash := sha256.Sum256(body)
	data, _ := json.Marshal(map[string]any{
		"version": 1, "grant_id": grantID, "request_sha256": hex.EncodeToString(hash[:]), "at_ms": started.UnixMilli(),
		"stage": stage, "class": transportClass(err), "status": status,
		"provider_bytes": readBytes, "downstream_bytes": writtenBytes, "elapsed_ms": time.Since(started).Milliseconds(),
	})
	file, openError := os.OpenFile(filepath.Join(g.Directory, "transport-errors.safe.jsonl"), os.O_WRONLY|os.O_CREATE|os.O_APPEND|syscall.O_NOFOLLOW, 0600)
	if openError != nil {
		g.TraceFailures.Add(1)
		return
	}
	defer file.Close()
	if _, writeError := file.Write(append(data, '\n')); writeError != nil {
		g.TraceFailures.Add(1)
	} else if file.Sync() != nil {
		g.TraceFailures.Add(1)
	}
}
