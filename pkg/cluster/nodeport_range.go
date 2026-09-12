package cluster

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetNodePortRange returns the --service-node-port-range configured on the
// cluster's kube-apiserver (falls back to the Kubernetes default 30000-32767
// when the flag or the apiserver pod cannot be read).
func (cm *ClusterManager) GetNodePortRange(c *gin.Context) {
	clusterName := strings.TrimSpace(c.Param("name"))
	if clusterName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cluster name is required"})
		return
	}
	cs, err := cm.GetClientSet(clusterName)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()

	const defaultMin, defaultMax = 30000, 32767
	min, max := defaultMin, defaultMax
	source := "default"

	// The flag lives on the kube-apiserver process. Try the canonical label
	// first, then the pod-name prefix used by kubeadm clusters.
	pods, err := cs.K8sClient.ClientSet.CoreV1().
		Pods("kube-system").
		List(ctx, metav1.ListOptions{LabelSelector: "component=kube-apiserver"})
	if err != nil || len(pods.Items) == 0 {
		pods, err = cs.K8sClient.ClientSet.CoreV1().
			Pods("kube-system").
			List(ctx, metav1.ListOptions{LabelSelector: "tier=control-plane"})
		if err == nil {
			filtered := pods.Items[:0]
			for _, pod := range pods.Items {
				if strings.HasPrefix(pod.Name, "kube-apiserver") {
					filtered = append(filtered, pod)
				}
			}
			pods.Items = filtered
		}
	}

	if err == nil {
		for _, pod := range pods.Items {
			found := false
			for _, container := range pod.Spec.Containers {
				joined := append(append([]string{}, container.Command...), container.Args...)
				for _, arg := range joined {
					if !strings.HasPrefix(arg, "--service-node-port-range") {
						continue
					}
					value := strings.TrimPrefix(arg, "--service-node-port-range=")
					parts := strings.SplitN(value, "-", 2)
					if len(parts) != 2 {
						continue
					}
					lo, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
					hi, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
					if err1 != nil || err2 != nil || lo <= 0 || hi <= lo {
						continue
					}
					min, max = lo, hi
					source = "kube-apiserver"
					found = true
					break
				}
				if found {
					break
				}
			}
			if found {
				break
			}
		}
	} else {
		fmt.Printf("nodeport-range: failed to list kube-apiserver pods: %v\n", err)
	}

	c.JSON(http.StatusOK, gin.H{"min": min, "max": max, "source": source})
}
