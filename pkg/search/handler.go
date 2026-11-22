package search

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/hashicorp/golang-lru/v2/expirable"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/middleware"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/resources"
	"github.com/zxh326/kite/pkg/utils"
	"golang.org/x/sync/errgroup"
	"k8s.io/klog/v2"
)

type SearchHandler struct {
	cache       *expirable.LRU[string, []common.SearchResult]
	searchFuncs map[string]resources.SearchFunc
}
type SearchResponse struct {
	Results []common.SearchResult `json:"results"`
	Total   int                   `json:"total"`
}

const (
	defaultSearchLimit = 50
	maxSearchLimit     = 100
)

var searchResourceOrder = map[string]int{
	string(common.Deployments):          1,
	string(common.DaemonSets):           2,
	string(common.StatefulSets):         3,
	string(common.Pods):                 4,
	string(common.ConfigMaps):           5,
	string(common.Services):             6,
	string(common.Secrets):              7,
	string(common.Ingresses):            8,
	string(common.Namespaces):           9,
	string(common.PodDisruptionBudgets): 10,
}

func NewSearchHandler(searchFuncs map[string]resources.SearchFunc) *SearchHandler {
	return &SearchHandler{
		cache:       expirable.NewLRU[string, []common.SearchResult](100, nil, time.Minute*10),
		searchFuncs: searchFuncs,
	}
}

func (h *SearchHandler) createCacheKey(clusterName, userKey, query string, limit int) string {
	return h.createCacheKeyPrefix(clusterName, userKey, limit) + normalizeSearchQuery(query)
}

func (h *SearchHandler) createCacheKeyPrefix(clusterName, userKey string, limit int) string {
	return fmt.Sprintf("search:%s:%s:%d:", clusterName, userKey, limit)
}

func (h *SearchHandler) Search(c *gin.Context, query string, limit int) ([]common.SearchResult, error) {
	start := time.Now()
	query = normalizeSearchQuery(query)
	limit = normalizeSearchLimit(limit)

	// 确定要搜索哪些资源类型
	guessSearchResources, q := utils.GuessSearchResources(query)

	// 收集要执行的搜索函数
	type searchEntry struct {
		name string
		fn   resources.SearchFunc
	}
	var entries []searchEntry
	for name, searchFunc := range h.searchFuncs {
		if guessSearchResources == "all" || name == guessSearchResources {
			entries = append(entries, searchEntry{name: name, fn: searchFunc})
		}
	}

	// 用 errgroup 并行执行搜索
	resultSlices := make([][]common.SearchResult, len(entries))
	var hadFailure atomic.Bool // set on panic OR error — prevents caching incomplete results
	g, _ := errgroup.WithContext(context.Background())

	for i, entry := range entries {
		searchContext := c.Copy()
		g.Go(func() (err error) {
			defer func() {
				if r := recover(); r != nil {
					klog.Errorf("search: resource %q panicked: %v", entry.name, r)
					hadFailure.Store(true)
				}
			}()
			resourceStart := time.Now()
			results, searchErr := entry.fn(searchContext, q, int64(limit))
			elapsed := time.Since(resourceStart)
			if searchErr != nil {
				klog.Errorf("search: resource %q failed after %s: %v", entry.name, elapsed, searchErr)
				hadFailure.Store(true)
				return nil
			}
			klog.V(4).Infof("search: resource=%s query=%q results=%d elapsed=%s", entry.name, q, len(results), elapsed)
			resultSlices[i] = results
			return nil
		})
	}

	_ = g.Wait() // all goroutines return nil, error is always nil

	// 合并所有资源类型的结果
	var allResults []common.SearchResult
	for _, slice := range resultSlices {
		allResults = append(allResults, slice...)
	}
	user := c.MustGet("user").(model.User)
	clusterName := getSearchClusterName(c)
	allResults = filterSearchResultsByAccess(user, clusterName, allResults)

	queryLower := strings.ToLower(q)
	sortResults(allResults, queryLower)

	// 限制结果总数
	if len(allResults) > limit {
		allResults = allResults[:limit]
	}

	// 只有在没有失败（panic 或错误）时才缓存结果——避免
	// 把不完整的结果缓存下来，在 TTL 内当作正常的 200 OK 返回。
	if !hadFailure.Load() {
		h.cache.Add(h.createCacheKey(clusterName, user.Key(), query, limit), allResults)
	}
	klog.V(4).Infof("search: query=%q resources=%d results=%d cacheable=%t elapsed=%s", query, len(entries), len(allResults), !hadFailure.Load(), time.Since(start))
	return allResults, nil
}

// GlobalSearch 处理跨多个资源类型的全局搜索
func (h *SearchHandler) GlobalSearch(c *gin.Context) {
	user := c.MustGet("user").(model.User)
	clusterName := getSearchClusterName(c)
	// CanSeeNamespacesInCluster 已含 CanAccessCluster，额外承认「只靠命名空间级权限绑定组
	// 进入该集群」的账号（第 18 轮 D-148：只看 GetUserRoles 时，这类账号连自己有 get 权限
	// 的对象都搜不到，整块功能对它们禁用）。口径与集群概览 GetOverview 一致。
	// 不会因此多给数据：结果每条都过 filterSearchResultsByAccess（按命名空间的 CanAccess），
	// 缓存键也按用户隔离。
	if !rbac.CanSeeNamespacesInCluster(user, clusterName) {
		// 带上机器可读码与完整语义：光回 `Access denied` 会让前端只能贴英文原句（第 18 轮 D-146）。
		c.JSON(http.StatusForbidden, gin.H{
			"code":  "access_denied",
			"error": fmt.Sprintf("user %s does not have access to search on cluster %s", user.Username, clusterName),
		})
		return
	}

	query := normalizeSearchQuery(c.Query("q"))
	if query == "" {
		c.JSON(http.StatusOK, SearchResponse{})
		return
	}

	// 解析 limit 参数
	limitStr := c.DefaultQuery("limit", strconv.Itoa(defaultSearchLimit))
	limit, err := strconv.Atoi(limitStr)
	if err != nil {
		limit = defaultSearchLimit
	}
	limit = normalizeSearchLimit(limit)

	cacheKey := h.createCacheKey(clusterName, user.Key(), query, limit)

	if cachedResults, found := h.cache.Get(cacheKey); found {
		cachedResults = filterSearchResultsByAccess(user, clusterName, cachedResults)
		klog.V(4).Infof("search: query=%q cache=exact results=%d", query, len(cachedResults))
		response := SearchResponse{
			Results: cachedResults,
			Total:   len(cachedResults),
		}
		c.JSON(http.StatusOK, response)
		return
	}

	if cachedResults, found := h.searchCachedPrefix(clusterName, user.Key(), query, limit); found {
		cachedResults = filterSearchResultsByAccess(user, clusterName, cachedResults)
		klog.V(4).Infof("search: query=%q cache=prefix results=%d", query, len(cachedResults))
		h.cache.Add(cacheKey, cachedResults)
		response := SearchResponse{
			Results: cachedResults,
			Total:   len(cachedResults),
		}
		c.JSON(http.StatusOK, response)
		return
	}

	allResults, err := h.Search(c, query, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to perform search"})
		return
	}

	response := SearchResponse{
		Results: allResults,
		Total:   len(allResults),
	}

	c.JSON(http.StatusOK, response)
}

func filterSearchResultsByAccess(user model.User, clusterName string, results []common.SearchResult) []common.SearchResult {
	filtered := make([]common.SearchResult, 0, len(results))
	for _, result := range results {
		if result.ResourceType == string(common.Namespaces) {
			if !rbac.CanAccessNamespace(user, clusterName, result.Name) {
				continue
			}
		} else {
			namespace := result.Namespace
			if namespace == "" {
				namespace = common.AllNamespaces
			}
			if !rbac.CanAccess(user, result.ResourceType, string(common.VerbGet), clusterName, namespace) {
				continue
			}
		}
		filtered = append(filtered, result)
	}
	return filtered
}

func (h *SearchHandler) searchCachedPrefix(clusterName, userKey, query string, limit int) ([]common.SearchResult, bool) {
	query = normalizeSearchQuery(query)
	if query == "" {
		return nil, false
	}

	prefix := h.createCacheKeyPrefix(clusterName, userKey, limit)
	var bestQuery string
	var bestResults []common.SearchResult
	for _, key := range h.cache.Keys() {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		cachedQuery := strings.TrimPrefix(key, prefix)
		if cachedQuery == query || !strings.HasPrefix(query, cachedQuery) || len(cachedQuery) <= len(bestQuery) {
			continue
		}
		results, found := h.cache.Get(key)
		if !found || len(results) >= limit {
			continue
		}
		bestQuery = cachedQuery
		bestResults = results
	}
	if bestResults == nil {
		return nil, false
	}

	results, ok := filterCachedPrefixResults(bestResults, query, limit)
	if !ok {
		return nil, false
	}
	return results, true
}

func filterCachedPrefixResults(results []common.SearchResult, query string, limit int) ([]common.SearchResult, bool) {
	resourceType, q := utils.GuessSearchResources(query)
	if q == "" || strings.Contains(q, ":") || strings.Contains(q, "=") {
		return nil, false
	}

	queryLower := strings.ToLower(q)
	filtered := make([]common.SearchResult, 0, len(results))
	for _, result := range results {
		if resourceType != "all" && result.ResourceType != resourceType {
			continue
		}
		if strings.Contains(strings.ToLower(result.Name), queryLower) {
			filtered = append(filtered, result)
			if len(filtered) >= limit {
				break
			}
		}
	}
	return filtered, true
}

func getResourceOrder(resourceType string) int {
	if order, exists := searchResourceOrder[resourceType]; exists {
		return order
	}
	return len(searchResourceOrder) // Default to the end if not found
}

// sortResults 对搜索结果排序：精确匹配优先，然后按资源类型
func sortResults(results []common.SearchResult, query string) {
	var exactMatches, partialMatches []common.SearchResult

	for _, result := range results {
		if strings.ToLower(result.Name) == query {
			exactMatches = append(exactMatches, result)
		} else {
			partialMatches = append(partialMatches, result)
		}
	}

	// 按资源排序
	sortByResources := func(a, b common.SearchResult) bool {
		return getResourceOrder(a.ResourceType) < getResourceOrder(b.ResourceType)
	}

	sort.SliceStable(exactMatches, func(i, j int) bool {
		return sortByResources(exactMatches[i], exactMatches[j])
	})
	sort.SliceStable(partialMatches, func(i, j int) bool {
		return sortByResources(partialMatches[i], partialMatches[j])
	})

	// 合并结果
	copy(results, append(exactMatches, partialMatches...))
}

func normalizeSearchLimit(limit int) int {
	if limit < 1 || limit > maxSearchLimit {
		return defaultSearchLimit
	}
	return limit
}

func normalizeSearchQuery(query string) string {
	return strings.Join(strings.Fields(query), " ")
}

func getSearchClusterName(c *gin.Context) string {
	if clusterName := c.GetString(middleware.ClusterNameKey); clusterName != "" {
		return clusterName
	}
	if clusterName := c.GetHeader(middleware.ClusterNameHeader); clusterName != "" {
		return clusterName
	}
	if clusterName, ok := c.GetQuery(middleware.ClusterNameHeader); ok {
		return clusterName
	}
	clusterName, _ := c.Cookie(middleware.ClusterNameHeader)
	return clusterName
}
