package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Only optional API-provider mode uses this journal. Terminal readers must wait
// for the synced completion marker; a partial stream is never final usage.
type apiCapture struct {
	io.ReadCloser
	file             *os.File
	directory, grant string
	status           int
	bytes            int64
	eof              bool
	failed           bool
	once             sync.Once
}

func (g *Gate) captureAPI(body io.ReadCloser, grant string, status int) (*apiCapture, error) {
	f, err := os.OpenFile(filepath.Join(g.Directory, grant+".api-stream.private"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	return &apiCapture{ReadCloser: body, file: f, directory: g.Directory, grant: grant, status: status}, nil
}

func (c *apiCapture) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	if n > 0 {
		c.bytes += int64(n)
		if c.bytes > 64*1024*1024 {
			c.failed = true
			return 0, io.ErrShortBuffer
		}
		if _, e := c.file.Write(p[:n]); e != nil {
			c.failed = true
			return 0, e
		}
	}
	c.eof = err == io.EOF
	if err != nil && err != io.EOF {
		c.failed = true
	}
	return n, err
}

func (c *apiCapture) finish() {
	c.once.Do(func() {
		synced := c.file.Sync() == nil
		if c.file.Close() != nil {
			synced = false
		}
		path := filepath.Join(c.directory, c.grant+".api-terminal.json")
		f, err := os.OpenFile(path+".tmp", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return
		}
		err = json.NewEncoder(f).Encode(map[string]any{"grant_id": c.grant, "status": c.status, "bytes": c.bytes, "complete": synced && c.eof && !c.failed})
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil && closeErr == nil {
			_ = os.Rename(path+".tmp", path)
		}
	})
}

func writePrivateRequest(directory, grant string, body []byte) error {
	f, err := os.OpenFile(filepath.Join(directory, grant+".api-request.private.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(body); err != nil {
		return err
	}
	return f.Sync()
}
