package ai

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
	"k8s.io/klog/v2"
)

const (
	pendingSessionTTL             = 15 * time.Minute
	pendingSessionCleanupInterval = 10 * time.Minute
)

type pendingSession struct {
	Provider      string
	Model         string
	SystemPrompt  string
	Messages      []AgentMessage
	ToolCalls     []ToolCall
	ToolResults   []ContentBlock
	NextToolIndex int
	Iteration     int
	UserID        uint
	ClusterName   string
	ExpiresAt     time.Time
}

type pendingSessionStore struct{}

var agentPendingSessions = &pendingSessionStore{}

func (s *pendingSessionStore) save(session pendingSession) (string, error) {
	sessionID := newPendingSessionID()
	session.ExpiresAt = time.Now().Add(pendingSessionTTL)
	dbSession := &model.PendingSession{
		SessionID:     sessionID,
		Provider:      session.Provider,
		AIModel:       session.Model,
		SystemPrompt:  model.LongText(session.SystemPrompt),
		NextToolIndex: session.NextToolIndex,
		Iteration:     session.Iteration,
		UserID:        session.UserID,
		ClusterName:   session.ClusterName,
		ExpiresAt:     session.ExpiresAt,
	}
	if err := dbSession.Messages.Marshal(session.Messages); err != nil {
		return "", fmt.Errorf("failed to marshal pending messages: %w", err)
	}
	if err := dbSession.ToolCalls.Marshal(session.ToolCalls); err != nil {
		return "", fmt.Errorf("failed to marshal pending tool calls: %w", err)
	}
	if err := dbSession.ToolResults.Marshal(session.ToolResults); err != nil {
		return "", fmt.Errorf("failed to marshal pending tool results: %w", err)
	}
	if err := model.SavePendingSession(dbSession); err != nil {
		return "", err
	}

	return sessionID, nil
}

func (s *pendingSessionStore) load(sessionID string) (pendingSession, error) {
	dbSession, err := model.GetPendingSession(sessionID)
	if err != nil {
		return pendingSession{}, fmt.Errorf("pending action not found or expired")
	}

	session := pendingSession{
		Provider:      dbSession.Provider,
		Model:         dbSession.AIModel,
		SystemPrompt:  string(dbSession.SystemPrompt),
		NextToolIndex: dbSession.NextToolIndex,
		Iteration:     dbSession.Iteration,
		UserID:        dbSession.UserID,
		ClusterName:   dbSession.ClusterName,
		ExpiresAt:     dbSession.ExpiresAt,
	}
	if err := dbSession.Messages.Unmarshal(&session.Messages); err != nil {
		return pendingSession{}, fmt.Errorf("failed to unmarshal pending messages: %w", err)
	}
	if err := dbSession.ToolCalls.Unmarshal(&session.ToolCalls); err != nil {
		return pendingSession{}, fmt.Errorf("failed to unmarshal pending tool calls: %w", err)
	}
	if err := dbSession.ToolResults.Unmarshal(&session.ToolResults); err != nil {
		return pendingSession{}, fmt.Errorf("failed to unmarshal pending tool results: %w", err)
	}
	return session, nil
}

func (s *pendingSessionStore) claim(sessionID string) error {
	deleted, err := model.DeletePendingSession(sessionID)
	if err != nil {
		return err
	}
	if !deleted {
		return fmt.Errorf("pending action not found or expired")
	}
	return nil
}

func newPendingSessionID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err == nil {
		return hex.EncodeToString(buf)
	}
	return fmt.Sprintf("pending-%d", time.Now().UnixNano())
}

// StartPendingSessionCleanup 定期清理过期的待确认会话。
//
// 不在请求路径上顺手清理（每次保存会话都删一遍全表）：AI 每轮工具调用都会保存一次
// 会话，那条全表 DELETE 既和主写入抢锁，又把延迟压在用户请求上。过期行本身不影响
// 正确性（读取会过滤 expires_at），晚一点回收只是占点空间。
func StartPendingSessionCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(pendingSessionCleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := model.CleanupExpiredPendingSessions(); err != nil {
					klog.V(4).Infof("Failed to cleanup expired pending sessions: %v", err)
				}
			}
		}
	}()
}
