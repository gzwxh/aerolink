package resources

import (
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"aerolink/pkg/rbac"
	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/klog/v2"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// informer 缓存的 List 会在响应里塞这个假 continue token（见
// controller-runtime 的 cache reader）。拿它再请求必然失败，对外要抹掉。
const cacheContinueToken = "continue-not-supported"

// paginationClient 选择本次 LIST 使用的客户端。
//
// informer 缓存不支持真分页：带 continue 的 List 直接返回
// "continue list option is not supported by the cache"，带 limit 时只在本地
// 截断并塞一个假 token。所以「分页模式」（前端传 paginate=true）与翻页
// （continue 非空）的请求必须走直连 apiserver。
//
// 其它只带 limit 的既有调用方（命名空间详情、最近事件等）继续走缓存：
// limit 在缓存里是本地截断，结果可用，也不额外增加 apiserver 压力。
func paginationClient(c *gin.Context, cs *cluster.ClientSet) client.Client {
	if cs.K8sClient == nil {
		return nil
	}
	if c.Query("paginate") != "true" && c.Query("continue") == "" {
		return cs.K8sClient
	}
	if cs.K8sClient.DirectClient == nil {
		return cs.K8sClient
	}
	return cs.K8sClient.DirectClient
}

const (
	// 多命名空间集合合并分页的单次请求扫描上限：选中命名空间的数据排在很靠后时，
	// 一次请求最多扫这么多页，剩余部分由前端的「加载更多」继续推进。
	maxNamespaceFilterPages = 50
	// namespaces 参数最多接受的命名空间个数，避免构造超长请求。
	maxNamespaceFilterCount = 200
)

// parseNamespaceFilter 解析多命名空间集合参数（逗号分隔）。
//
// 它只用来「收窄」跨命名空间列表，因此仅在 namespace 为空 / _all 的命名空间级
// 资源请求上由调用方启用。不传时返回 nil，调用方行为与之前完全一致。
func parseNamespaceFilter(c *gin.Context) []string {
	raw := strings.TrimSpace(c.Query("namespaces"))
	if raw == "" {
		return nil
	}
	seen := make(map[string]struct{}, 8)
	filter := make([]string, 0, 8)
	for _, part := range strings.Split(raw, ",") {
		ns := strings.TrimSpace(part)
		if ns == "" || ns == common.AllNamespaces || ns == "*" {
			continue
		}
		if _, ok := seen[ns]; ok {
			continue
		}
		seen[ns] = struct{}{}
		filter = append(filter, ns)
		if len(filter) >= maxNamespaceFilterCount {
			break
		}
	}
	return filter
}

func namespaceFilterCovers(filter []string, namespace string) bool {
	for _, ns := range filter {
		if ns == namespace {
			return true
		}
	}
	return false
}

func (h *GenericResourceHandler[T, V]) list(c *gin.Context) (V, error) {
	var zero V
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	objectList := reflect.New(h.listType).Interface().(V)

	namespace := c.Param("namespace")
	allNamespaces := namespace == "" || namespace == common.AllNamespaces

	var baseOpts []client.ListOption
	if !h.isClusterScoped {
		if !allNamespaces {
			baseOpts = append(baseOpts, client.InNamespace(namespace))
		}
	}

	baseOpts, limit, err := parseListQueryOptions(c, baseOpts)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return zero, err
	}

	// 多命名空间集合：仅对跨命名空间的命名空间级资源生效，集群级资源忽略。
	var namespaceFilter []string
	if !h.isClusterScoped && allNamespaces {
		namespaceFilter = parseNamespaceFilter(c)
	}

	listClient := paginationClient(c, cs)
	// 集合过滤依赖真分页：informer 缓存的假 token 无法继续翻页，因此有直连
	// 客户端时改用它；没有直连能力时只取一页（退化为旧的单页行为）。
	canMergePages := len(namespaceFilter) > 0 && cs.K8sClient != nil && cs.K8sClient.DirectClient != nil
	if canMergePages {
		listClient = cs.K8sClient.DirectClient
	}

	user := c.MustGet("user").(model.User)
	continueToken := c.Query("continue")

	collected := make([]runtime.Object, 0, 64)
	for page := 0; ; page++ {
		pageList := objectList
		if page > 0 {
			pageList = reflect.New(h.listType).Interface().(V)
		}

		// 合并翻页时每轮只请求「还差多少条」：若每轮都按完整 limit 请求，凑够后
		// 当前页可能只消费了一半，而页尾的 continue 已越过整页，剩余条目会被
		// 永久跳过。按剩余量请求保证凑满时整页都已消费完，游标才不丢数据。
		accepted, nextToken, err := h.fetchFilteredPage(c, user, cs, listClient, pageList, baseOpts,
			allNamespaces, namespaceFilter, limit-int64(len(collected)), continueToken)
		if err != nil {
			return zero, err
		}
		collected = append(collected, accepted...)
		continueToken = nextToken

		if !canMergePages || continueToken == "" {
			break
		}
		if limit > 0 && int64(len(collected)) >= limit {
			break
		}
		if page+1 >= maxNamespaceFilterPages {
			break
		}
	}

	sort.Slice(collected, func(i, j int) bool {
		o1, _ := meta.Accessor(collected[i])
		o2, _ := meta.Accessor(collected[j])
		if o1 == nil || o2 == nil {
			return false
		}

		t1 := o1.GetCreationTimestamp()
		t2 := o2.GetCreationTimestamp()
		if t1.Equal(&t2) {
			return o1.GetName() < o2.GetName()
		}

		return t1.After(t2.Time)
	})

	_ = meta.SetList(objectList, collected)

	// 跨多页合并时 objectList 的 ListMeta 还停在第 1 页，必须写回最后一次
	// List 的 continue token，调用方才能从正确的位置继续翻。
	if len(namespaceFilter) > 0 {
		if listMeta, err := meta.ListAccessor(objectList); err == nil {
			listMeta.SetContinue(continueToken)
		}
	}

	// 缓存路径（非分页）会带一个假 continue token，抹掉它，免得调用方拿它翻页。
	if listMeta, err := meta.ListAccessor(objectList); err == nil && listMeta.GetContinue() == cacheContinueToken {
		listMeta.SetContinue("")
	}

	return objectList, nil
}

// parseListQueryOptions 解析 labelSelector / fieldSelector / limit 三个通用查询
// 参数，解析成功的选项追加进 baseOpts。解析失败返回带原因的 error，由调用方
// 统一回 400。
func parseListQueryOptions(c *gin.Context, baseOpts []client.ListOption) ([]client.ListOption, int64, error) {
	if labelSelector := c.Query("labelSelector"); labelSelector != "" {
		selector, err := metav1.ParseToLabelSelector(labelSelector)
		if err != nil {
			return nil, 0, fmt.Errorf("invalid labelSelector parameter: %w", err)
		}
		labelSelectorOption, err := metav1.LabelSelectorAsSelector(selector)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to convert labelSelector: %w", err)
		}
		baseOpts = append(baseOpts, client.MatchingLabelsSelector{Selector: labelSelectorOption})
	}

	if fieldSelector := c.Query("fieldSelector"); fieldSelector != "" {
		fieldSelectorOption, err := fields.ParseSelector(fieldSelector)
		if err != nil {
			return nil, 0, fmt.Errorf("invalid fieldSelector parameter: %w", err)
		}
		baseOpts = append(baseOpts, client.MatchingFieldsSelector{Selector: fieldSelectorOption})
	}

	var limit int64
	if c.Query("limit") != "" {
		parsed, err := strconv.ParseInt(c.Query("limit"), 10, 64)
		if err != nil {
			return nil, 0, fmt.Errorf("invalid limit parameter")
		}
		limit = parsed
	}
	return baseOpts, limit, nil
}

// fetchFilteredPage 请求一页并对每条做集合 / 权限过滤，返回本页接受的条目与页尾
// continue 游标。remaining 是本轮允许新增的条数（limit - 已收集数）：服务端按
// remaining 截断本页，凑满时整页恰好消费完，游标不会越过未处理条目。
func (h *GenericResourceHandler[T, V]) fetchFilteredPage(
	c *gin.Context,
	user model.User,
	cs *cluster.ClientSet,
	listClient client.Client,
	pageList V,
	baseOpts []client.ListOption,
	allNamespaces bool,
	namespaceFilter []string,
	remaining int64,
	continueToken string,
) ([]runtime.Object, string, error) {
	ctx := c.Request.Context()
	opts := append([]client.ListOption{}, baseOpts...)
	if remaining > 0 {
		opts = append(opts, client.Limit(remaining))
	}
	if continueToken != "" {
		opts = append(opts, client.Continue(continueToken))
	}

	if err := listClient.List(ctx, pageList, opts...); err != nil {
		if h.Name() == string(common.EndpointSlices) && meta.IsNoMatchError(err) {
			// EndpointSlices 偶发 NoMatch：按「无数据」收尾，不让整次列表失败。
			_ = meta.SetList(pageList, []runtime.Object{})
			return nil, "", nil
		}
		respondReadFailure(c, err)
		return nil, "", err
	}

	pageItems, err := meta.ExtractList(pageList)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to extract items from list"})
		return nil, "", err
	}

	// 过滤必须发生在「是否凑够 limit」的判定之前：整页被集合 / 权限过滤掉时
	// 不能误判为已凑够而提前停止，否则多选命名空间仍会拿到空表。
	accepted := make([]runtime.Object, 0, len(pageItems))
	for _, item := range pageItems {
		filtered, err := h.filterListItem(c, user, cs, allNamespaces, namespaceFilter, item)
		if err != nil {
			return nil, "", err
		}
		if filtered == nil {
			continue
		}
		accepted = append(accepted, filtered)
		if remaining > 0 && int64(len(accepted)) >= remaining {
			break
		}
	}

	nextToken := ""
	if listMeta, err := meta.ListAccessor(pageList); err == nil {
		nextToken = listMeta.GetContinue()
	}
	return accepted, nextToken, nil
}

// filterListItem 做逐条过滤（清理字段 / 命名空间集合 / RBAC），返回 nil 表示丢弃。
// 集合与 RBAC 过滤都在 limit 之前完成，返回条数才是用户真正能看到的数据。
func (h *GenericResourceHandler[T, V]) filterListItem(
	c *gin.Context,
	user model.User,
	cs *cluster.ClientSet,
	allNamespaces bool,
	namespaceFilter []string,
	item runtime.Object,
) (runtime.Object, error) {
	obj, err := meta.Accessor(item)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to access object metadata"})
		return nil, err
	}
	obj.SetManagedFields(nil)
	if anno := obj.GetAnnotations(); anno != nil {
		delete(anno, common.KubectlAnnotation)
	}
	if len(namespaceFilter) > 0 && !namespaceFilterCovers(namespaceFilter, obj.GetNamespace()) {
		return nil, nil
	}
	if h.Name() == string(common.Namespaces) && !rbac.CanAccessNamespace(user, cs.Name, obj.GetName()) {
		return nil, nil
	}
	if allNamespaces && obj.GetNamespace() != "" &&
		!rbac.CanAccess(user, h.Name(), string(common.VerbGet), cs.Name, obj.GetNamespace()) {
		return nil, nil
	}
	return item, nil
}

func (h *GenericResourceHandler[T, V]) List(c *gin.Context) {
	object, err := h.list(c)
	if err != nil {
		return
	}
	c.JSON(http.StatusOK, object)
}

func (h *GenericResourceHandler[T, V]) Search(c *gin.Context, q string, limit int64) ([]common.SearchResult, error) {
	if !h.enableSearch || q == "" {
		return nil, nil
	}
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	user := c.MustGet("user").(model.User)
	ctx := c.Request.Context()
	objectList := reflect.New(h.listType).Interface().(V)
	var listOpts []client.ListOption
	if idx := strings.Index(q, ":"); idx > 0 {
		labelKey := strings.TrimSpace(q[:idx])
		labelValue := strings.TrimSpace(q[idx+1:])
		listOpts = append(listOpts, client.MatchingLabels{labelKey: labelValue})
	} else if idx := strings.Index(q, "="); idx > 0 {
		labelKey := strings.TrimSpace(q[:idx])
		labelValue := strings.TrimSpace(q[idx+1:])
		listOpts = append(listOpts, client.MatchingLabels{labelKey: labelValue})
	}
	if err := cs.K8sClient.List(ctx, objectList, listOpts...); err != nil {
		klog.Errorf("failed to list %s: %v", h.name, err)
		return nil, err
	}
	isLabelSearch := strings.Contains(q, ":") || strings.Contains(q, "=")
	items, err := meta.ExtractList(objectList)
	if err != nil {
		klog.Errorf("failed to extract items from list: %v", err)
		return nil, err
	}

	results := make([]common.SearchResult, 0, limit)

	for _, item := range items {
		obj, ok := item.(client.Object)
		if !ok {
			klog.Errorf("item is not a client.Object: %v", item)
			continue
		}
		if !isLabelSearch && !strings.Contains(strings.ToLower(obj.GetName()), strings.ToLower(q)) {
			continue
		}
		if h.Name() == string(common.Namespaces) {
			if !rbac.CanAccessNamespace(user, cs.Name, obj.GetName()) {
				continue
			}
		} else {
			namespace := obj.GetNamespace()
			if namespace == "" {
				namespace = common.AllNamespaces
			}
			if !rbac.CanAccess(user, h.Name(), string(common.VerbGet), cs.Name, namespace) {
				continue
			}
		}
		result := common.SearchResult{
			ID:           string(obj.GetUID()),
			Name:         obj.GetName(),
			Namespace:    obj.GetNamespace(),
			ResourceType: h.name,
			CreatedAt:    obj.GetCreationTimestamp().String(),
		}
		results = append(results, result)
		if limit > 0 && int64(len(results)) >= limit {
			break
		}
	}

	return results, nil
}
