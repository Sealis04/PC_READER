package background

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/locallog"
	"github.com/sealis04/pc_reader/agent/internal/payload"
)

// BatchSize is the most entries one upload carries (the contract's limit).
const BatchSize = 500

// LogUploader is what UploadLogs needs from the API client.
type LogUploader interface {
	UploadLogs(ctx context.Context, token string, entries []payload.LogEntry) ([]int64, error)
}

var _ LogUploader = (*api.Client)(nil)

// UploadLogs sends the local log to the server and returns how many entries it sent. It is
// confirm-then-clear: batches of up to 500, and only the ids the server returns are deleted, so
// entries logged during the upload and entries of a failed batch stay for the next time. A 413
// halves the batch and retries. The first failure stops the upload; nothing is lost.
func UploadLogs(ctx context.Context, store *locallog.Store, up LogUploader, token string) (int, error) {
	sent, size := 0, BatchSize
	for {
		entries, err := store.Next(size)
		if err != nil {
			return sent, err
		}
		if len(entries) == 0 {
			return sent, nil
		}
		batch := make([]payload.LogEntry, len(entries))
		for i, e := range entries {
			batch[i] = payload.LogEntry{
				LocalEntryID: e.ID,
				LoggedAt:     e.LoggedAt.UTC().Format(time.RFC3339),
				Level:        e.Level,
				Category:     e.Category,
				Message:      e.Message,
			}
		}
		ids, err := up.UploadLogs(ctx, token, batch)
		var apiErr *api.Error
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusRequestEntityTooLarge && size > 1 {
			size = max(1, len(entries)/2)
			continue
		}
		if err != nil {
			return sent, err
		}
		if len(ids) == 0 {
			return sent, errors.New("the server stored none of the log entries")
		}
		if err := store.Delete(ids); err != nil {
			return sent, err
		}
		sent += len(ids)
	}
}
