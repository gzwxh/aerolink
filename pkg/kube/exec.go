package kube

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/zxh326/kite/pkg/common"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// ExecOptions 保存 ExecCommand 的参数
type ExecOptions struct {
	Namespace     string
	PodName       string
	ContainerName string
	Command       []string
	Stdin         io.Reader
	Stdout        io.Writer
	Stderr        io.Writer
	TTY           bool
}

// ExecCommand 在 pod 中执行一条命令
func (c *K8sClient) ExecCommand(ctx context.Context, opts ExecOptions) error {
	req := c.ClientSet.CoreV1().RESTClient().Post().
		Resource(string(common.Pods)).
		Name(opts.PodName).
		Namespace(opts.Namespace).
		SubResource("exec")

	req.VersionedParams(&corev1.PodExecOptions{
		Container: opts.ContainerName,
		Command:   opts.Command,
		Stdin:     opts.Stdin != nil,
		Stdout:    opts.Stdout != nil,
		Stderr:    opts.Stderr != nil,
		TTY:       opts.TTY,
	}, scheme.ParameterCodec)

	exec, err := newRemoteCommandExecutor(c.Configuration, req.URL())
	if err != nil {
		return fmt.Errorf("failed to create executor: %w", err)
	}

	err = exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:  opts.Stdin,
		Stdout: opts.Stdout,
		Stderr: opts.Stderr,
		Tty:    opts.TTY,
	})

	if err != nil {
		return fmt.Errorf("failed to stream execution: %w", err)
	}

	return nil
}

// ExecCommandBuffered 执行一条命令，并以字符串返回 stdout 与 stderr
func (c *K8sClient) ExecCommandBuffered(ctx context.Context, namespace, pod, container string, command []string) (string, string, error) {
	var stdout, stderr bytes.Buffer
	err := c.ExecCommand(ctx, ExecOptions{
		Namespace:     namespace,
		PodName:       pod,
		ContainerName: container,
		Command:       command,
		Stdout:        &stdout,
		Stderr:        &stderr,
		TTY:           false,
	})
	return stdout.String(), stderr.String(), err
}
