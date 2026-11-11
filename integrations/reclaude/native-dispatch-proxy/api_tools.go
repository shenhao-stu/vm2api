package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

// Some API providers return a caller's original tool name even though the
// interactive CLI registered it under MCP. Only declared, unambiguous aliases
// may be restored. The capture beneath this reader keeps the original bytes.
func callerToolAliases(body []byte) map[string]string {
	var request struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if json.Unmarshal(body, &request) != nil {
		return nil
	}
	declared := map[string]bool{}
	for _, tool := range request.Tools {
		declared[tool.Name] = true
	}
	aliases := map[string]string{}
	for name := range declared {
		if bare, ok := strings.CutPrefix(name, "mcp__caller__"); ok && bare != "" && !declared[bare] {
			aliases[bare] = name
		}
	}
	return aliases
}

type toolAliasReader struct {
	io.ReadCloser
	reader  *bufio.Reader
	aliases map[string]string
	buffer  []byte
	pending error
}

func (r *toolAliasReader) Read(p []byte) (int, error) {
	for len(r.buffer) == 0 {
		if r.pending != nil {
			return 0, r.pending
		}
		var line []byte
		var err error
		for {
			var part []byte
			part, err = r.reader.ReadSlice('\n')
			if len(line)+len(part) > 2*1024*1024 {
				return 0, io.ErrShortBuffer
			}
			line = append(line, part...)
			if err != bufio.ErrBufferFull {
				break
			}
		}
		r.pending = err
		if bytes.HasPrefix(line, []byte("data:")) {
			var event map[string]json.RawMessage
			if json.Unmarshal(bytes.TrimSpace(line[5:]), &event) == nil && string(event["type"]) == `"content_block_start"` {
				var block map[string]json.RawMessage
				if json.Unmarshal(event["content_block"], &block) == nil && string(block["type"]) == `"tool_use"` {
					var name string
					if json.Unmarshal(block["name"], &name) == nil && r.aliases[name] != "" {
						block["name"], _ = json.Marshal(r.aliases[name])
						event["content_block"], _ = json.Marshal(block)
						mapped, _ := json.Marshal(event)
						line = append(append([]byte("data: "), mapped...), '\n')
					}
				}
			}
		}
		r.buffer = line
	}
	n := copy(p, r.buffer)
	r.buffer = r.buffer[n:]
	return n, nil
}
