package kube

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/go-logr/logr"
	"github.com/zxh326/kite/pkg/common"
	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	toolscache "k8s.io/client-go/tools/cache"
	"k8s.io/klog/v2"
	"sigs.k8s.io/controller-runtime/pkg/cache"

	metricsv1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrllog "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	gatewayapiv1 "sigs.k8s.io/gateway-api/apis/v1"
)

var runtimeScheme = runtime.NewScheme()

const (
	defaultCacheSyncTimeout = 60 * time.Second
	defaultKubeAPIQPS       = 50
	defaultKubeAPIBurst     = 100
)

// cacheSyncTimeout 返回已配置的缓存同步超时，可通过
// AEROLINK_CACHE_SYNC_TIMEOUT 环境变量（单位：秒）覆盖。大型/远程集群上
// informer 的首次 LIST 可能耗时很久，因此默认值
// 给得比较宽松，并仍可针对边界情况调整。
func cacheSyncTimeout() time.Duration {
	if v := common.Getenv("CACHE_SYNC_TIMEOUT"); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return defaultCacheSyncTimeout
}

// kubeAPIQPS 返回 Kubernetes API 客户端的 QPS 上限，可通过
// AEROLINK_KUBE_API_QPS 环境变量覆盖。默认 50（client-go 默认是 5，
// 对大型/远程集群在首次缓存同步期间来说太低了）。
func kubeAPIQPS() float32 {
	if v := common.Getenv("KUBE_API_QPS"); v != "" {
		if qps, err := strconv.ParseFloat(v, 32); err == nil && qps > 0 {
			return float32(qps)
		}
	}
	return defaultKubeAPIQPS
}

// kubeAPIBurst 返回 Kubernetes API 客户端的突发上限，
// 可通过 AEROLINK_KUBE_API_BURST 环境变量覆盖。默认 100（client-go
// 默认是 10）。
func kubeAPIBurst() int {
	if v := common.Getenv("KUBE_API_BURST"); v != "" {
		if burst, err := strconv.Atoi(v); err == nil && burst > 0 {
			return burst
		}
	}
	return defaultKubeAPIBurst
}

func init() {
	ctrllog.SetLogger(controllerRuntimeLogger(klog.NewKlogr()))
	_ = scheme.AddToScheme(runtimeScheme)
	_ = apiextensionsv1.AddToScheme(runtimeScheme)
	_ = gatewayapiv1.Install(runtimeScheme)
	_ = metricsv1.AddToScheme(runtimeScheme)
}

func controllerRuntimeLogger(logger logr.Logger) logr.Logger {
	return logr.New(controllerRuntimeLogSink{sink: logger.GetSink()})
}

type controllerRuntimeLogSink struct {
	sink logr.LogSink
}

func (l controllerRuntimeLogSink) Init(info logr.RuntimeInfo) {
	l.sink.Init(info)
}

func (l controllerRuntimeLogSink) Enabled(level int) bool {
	return klog.V(2).Enabled() && l.sink.Enabled(level)
}

func (l controllerRuntimeLogSink) Info(level int, msg string, keysAndValues ...any) {
	if !klog.V(2).Enabled() {
		return
	}
	l.sink.Info(level, msg, keysAndValues...)
}

func (l controllerRuntimeLogSink) Error(err error, msg string, keysAndValues ...any) {
	if !klog.V(2).Enabled() {
		return
	}
	l.sink.Error(err, msg, keysAndValues...)
}

func (l controllerRuntimeLogSink) WithValues(keysAndValues ...any) logr.LogSink {
	l.sink = l.sink.WithValues(keysAndValues...)
	return l
}

func (l controllerRuntimeLogSink) WithName(name string) logr.LogSink {
	l.sink = l.sink.WithName(name)
	return l
}

func (l controllerRuntimeLogSink) WithCallDepth(depth int) logr.LogSink {
	if sink, ok := l.sink.(logr.CallDepthLogSink); ok {
		l.sink = sink.WithCallDepth(depth)
	}
	return l
}

// K8sClient 保存 Kubernetes 客户端实例
type K8sClient struct {
	client.Client
	ClientSet     kubernetes.Interface
	Configuration *rest.Config
	MetricsClient *metricsclient.Clientset
	CacheEnabled  bool // true when using controller-runtime informer cache

	cancel context.CancelFunc
}

// NewClient 依据 rest.Config 创建 K8sClient
func NewClient(config *rest.Config) (*K8sClient, error) {
	// 调整 QPS/Burst，使大型/远程集群上首次缓存同步的 LIST
	// 不会被 client-go 的默认值（QPS=5、Burst=10）限流。
	// 这些值可通过 AEROLINK_KUBE_API_QPS 与 AEROLINK_KUBE_API_BURST 覆盖。
	// 在 rest.Config 上显式设置的值（例如来自 kubeconfig）会被保留。
	if config.QPS == 0 {
		config.QPS = kubeAPIQPS()
	}
	if config.Burst == 0 {
		config.Burst = kubeAPIBurst()
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, err
	}

	metricsClient, err := metricsclient.NewForConfig(config)
	if err != nil {
		klog.Warningf("failed to create metrics client: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cacheEnabled := os.Getenv("DISABLE_CACHE") != "true"

	var c client.Client
	if !cacheEnabled {
		c, err = client.New(config, client.Options{
			Scheme: runtimeScheme,
		})
		if err != nil {
			cancel()
			return nil, fmt.Errorf("failed to create client: %w", err)
		}
	} else {
		mgr, err := manager.New(config, manager.Options{
			Scheme:         runtimeScheme,
			LeaderElection: false,
			Metrics: metricsserver.Options{
				BindAddress: "0", // Disable metrics server
			},
			Cache: cache.Options{
				DefaultWatchErrorHandler: func(ctx context.Context, r *toolscache.Reflector, err error) {
				},
			},
		})
		if err != nil {
			cancel()
			return nil, err
		}

		// 为 Pod 的 spec.nodeName 添加字段索引器，以便按节点高效查询
		if err := mgr.GetFieldIndexer().IndexField(ctx, &corev1.Pod{}, "spec.nodeName", func(rawObj client.Object) []string {
			pod := rawObj.(*corev1.Pod)
			if pod.Spec.NodeName == "" {
				return nil
			}
			return []string{pod.Spec.NodeName}
		}); err != nil {
			cancel()
			return nil, fmt.Errorf("failed to create field indexer for spec.nodeName: %w", err)
		}
		go func() {
			if err := mgr.Start(ctx); err != nil {
				fmt.Printf("Error starting manager: %v\n", err)
			}
		}()
		syncCtx, syncCancel := context.WithTimeout(ctx, cacheSyncTimeout())
		defer syncCancel()
		if !mgr.GetCache().WaitForCacheSync(syncCtx) {
			cancel()
			return nil, fmt.Errorf("failed to wait for cache sync (timeout: %s); "+
				"the cluster may be too large or the API server too slow. "+
				"Consider increasing AEROLINK_CACHE_SYNC_TIMEOUT or setting DISABLE_CACHE=true", cacheSyncTimeout())
		}
		c = mgr.GetClient()
	}

	return &K8sClient{
		Client:        c,
		ClientSet:     clientset,
		Configuration: config,
		MetricsClient: metricsClient,
		CacheEnabled:  cacheEnabled,
		cancel:        cancel,
	}, nil
}

func (c *K8sClient) Stop(name string) {
	klog.Infof("Stopping K8s client for %s", name)
	c.cancel()
}

// GetScheme 返回客户端使用的 runtime scheme
func GetScheme() *runtime.Scheme {
	return runtimeScheme
}

func WaitForResourceDeletion(ctx context.Context, client client.Client, obj client.Object, timeout time.Duration) error {
	key := types.NamespacedName{
		Namespace: obj.GetNamespace(),
		Name:      obj.GetName(),
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	timeoutCh := time.After(timeout)
	for {
		select {
		case <-timeoutCh:
			return fmt.Errorf("timed out waiting for resource deletion: %s", key)
		case <-ticker.C:
			if err := client.Get(ctx, key, obj); err != nil {
				if errors.IsNotFound(err) {
					return nil
				}
				return fmt.Errorf("failed to get resource: %w", err)
			} else if obj.GetDeletionTimestamp().IsZero() {
				// 该资源仍然存在，但没有设置删除时间戳
				// 删除后可能被重新创建
				// 因此可以认为它已被成功删除。
				return nil
			}
		}
	}
}
