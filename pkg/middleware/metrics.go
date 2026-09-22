package middleware

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
)

var (
	httpRequestsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests processed.",
		},
		[]string{"method", "route", "status"},
	)

	httpRequestDurationSeconds = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request duration in seconds.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "route", "status"},
	)

	// 资源 watch（SSE）的观测指标：推送量与上游 watch 数。
	// 用途一是对比「周期性全量推送」改造前后的出网体积，二是确认上游 watch
	// 收敛为每个集群固定 1 条（复用缓存之后应恒为 1）。
	WatchConnections = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "aerolink_watch_connections",
			Help: "Current number of active resource watch (SSE) connections.",
		},
		[]string{"cluster", "resource"},
	)

	WatchEventsPushed = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "aerolink_watch_events_pushed_total",
			Help: "Total number of SSE events pushed, by event type.",
		},
		[]string{"cluster", "resource", "type"},
	)

	WatchPushBytes = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "aerolink_watch_push_bytes_total",
			Help: "Total bytes written to resource watch (SSE) connections.",
		},
		[]string{"cluster", "resource"},
	)

	WatchUpstreamWatches = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "aerolink_watch_upstream_watches",
			Help: "Current number of upstream Kubernetes watches.",
		},
		[]string{"cluster"},
	)

	// WatchRejected 统计被「每用户每集群连接上限」拒绝的连接数。
	// 有值说明有人在被限流（或上限给得太紧），前端此时已降级为轮询。
	WatchRejected = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "aerolink_watch_rejected_total",
			Help: "Total number of resource watch (SSE) connections rejected by the per-user limit.",
		},
		[]string{"cluster"},
	)
)

func init() {
	_ = prometheus.Register(httpRequestsTotal)
	_ = prometheus.Register(httpRequestDurationSeconds)
	_ = prometheus.Register(WatchConnections)
	_ = prometheus.Register(WatchEventsPushed)
	_ = prometheus.Register(WatchPushBytes)
	_ = prometheus.Register(WatchUpstreamWatches)
	_ = prometheus.Register(WatchRejected)
}

func Metrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = c.Request.URL.Path
		}
		method := c.Request.Method
		if method == http.MethodOptions {
			return
		}
		for _, path := range unlogPath {
			if strings.HasPrefix(route, path) {
				return
			}
		}

		status := strconv.Itoa(c.Writer.Status())
		httpRequestsTotal.WithLabelValues(method, route, status).Inc()
		httpRequestDurationSeconds.WithLabelValues(method, route, status).Observe(time.Since(start).Seconds())
	}
}
