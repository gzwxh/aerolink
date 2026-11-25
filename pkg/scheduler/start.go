package scheduler

import (
	"context"

	"github.com/gzwxh/aerolink/pkg/cluster"
)

func Start(ctx context.Context, cm *cluster.ClusterManager) {
	manager := NewManager()

	registerHelmReleaseAutoUpgradeExecutor(manager, cm)
	manager.Start(ctx)
}
