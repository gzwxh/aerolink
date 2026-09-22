# Makefile for AeroLink project
.PHONY: help dev build build-cli rancherrbac clean test docker-build docker-run frontend backend backend-cli install deps changelog e2e-install e2e-install-browser e2e-kind-up e2e-kind-down e2e-stop-app e2e-setup-ldap e2e-setup-dex e2e-run e2e-run-existing e2e-run-headed e2e-test e2e-test-headed

# Variables
BINARY_NAME=aerolink
UI_DIR=ui
E2E_DIR=e2e
DOCKER_IMAGE=aerolink
DOCKER_TAG=latest
E2E_KIND_NAME ?= aerolink-e2e
E2E_PORT ?= 38080
E2E_KUBECONFIG ?= $(shell printf '%s' "$${TMPDIR:-/tmp/}aerolink-e2e.kubeconfig")
E2E_AUTH_NETWORK ?= aerolink-e2e-auth
E2E_LDAP_CONTAINER ?= aerolink-e2e-ldap
E2E_LDAP_PORT ?= 3389
E2E_DEX_CONTAINER ?= aerolink-e2e-dex
E2E_OAUTH_PORT ?= 5556
# 外部身份夹具的地址。specs/external-auth.spec.ts 只从环境变量读这两个值，缺一个就整组跳过，
# 所以在这里给出默认值（与 .github/workflows/e2e.yml 保持一致）。Dex 的 issuer 没有子路径，
# 写成 http://host:5556/dex 会让 OIDC 发现请求 404。
E2E_LDAP_URL ?= ldap://127.0.0.1:$(E2E_LDAP_PORT)
E2E_OAUTH_ISSUER ?= http://127.0.0.1:$(E2E_OAUTH_PORT)
# Existing-cluster mode (e2e-run-existing): KUBECONFIG must point at the cluster,
# E2E_CLUSTER_NAME is the kubeconfig context AeroLink imports it as, and
# E2E_NODE_NAME is the node the node-based specs look for.
E2E_CLUSTER_NAME ?= aerolink-e2e
E2E_CONTEXT_NAME ?= $(E2E_CLUSTER_NAME)
E2E_NODE_NAME ?=
SPEC ?=

# 本地开发默认环境变量（存在时由 run/dev 目标自动加载，见 dev.env）
# 必须用绝对路径：POSIX 规则下，`. name` 对不含斜杠的文件名只按 $PATH 查找、
# 不回退当前目录（dash 与以 sh 调用的 bash 都如此），`. dev.env` 会报 "file not found"。
DEV_ENV ?= dev.env
LOAD_DEV_ENV = if [ -f "$(abspath $(DEV_ENV))" ]; then set -a; . "$(abspath $(DEV_ENV))"; set +a; fi;

# Version information
# 发布版本号（前端展示与镜像构建共用）；发新版时修改这里。
# 形式与 git tag 一致（vX.Y.Z）：CI 发布用 tag 覆盖这里，本地构建用这个默认值，
# 两边格式相同，界面展示与 /api/v1/version 才对得上。
VERSION ?= v1.0.0
BUILD_DATE ?= $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
COMMIT_ID ?= $(shell git rev-parse HEAD 2>/dev/null || echo "unknown")

# Build flags
# 这两行只做两件事：-s -w 去掉符号表与调试信息（体积小），-X 在链接期把值写进
# pkg/version 的字符串变量。`github.com/zxh326/kite/...` 是 **Go 符号名**（= go.mod 的
# module 路径 + 包 + 变量），不是网址：这里不发任何网络请求，$(VERSION) / $(BUILD_DATE)
# / $(COMMIT_ID) 也都是本机求值（make 变量、date、git rev-parse），耗时微秒级。
# 注意：整个 -ldflags "..." 必须留在 LDFLAGS 里，不能只留版本号——go build 需要的是
# 「-ldflags + 参数」这一对，写成 LDFLAGS="v1.0.0" 会被当成包路径而报错。
# LDFLAGS=-ldflags "-s -w \
# 	-X 'github.com/zxh326/kite/pkg/version.Version=$(VERSION)' \
# 	-X 'github.com/zxh326/kite/pkg/version.BuildDate=$(BUILD_DATE)' \
# 	-X 'github.com/zxh326/kite/pkg/version.CommitID=$(COMMIT_ID)'"

# 本机临时覆盖（不进版本库，见 .gitignore）：把 VERSION / LDFLAGS 这类本机专用值写进
# Makefile.local，例如让本机构建的后端/前端显示另一个版本号而不改仓库里的 VERSION。
# 文件不存在时该行被忽略；放在这里是为了让覆盖值赢过上面的 ?= 与 LDFLAGS。
-include Makefile.local

# Default target
.DEFAULT_GOAL := build
DOCKER_TAG=latest

LOCALBIN ?= $(shell pwd)/bin
$(LOCALBIN):
	mkdir -p $(LOCALBIN)
GOLANGCI_LINT = $(LOCALBIN)/golangci-lint

# Help target
help: ## Show this help message
	@echo "Available targets:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Install dependencies
install: deps ## Install all dependencies
	@echo "📦 Installing dependencies..."

deps: ## Install frontend and backend dependencies
	@echo "📦 Installing frontend dependencies..."
	cd $(UI_DIR) && pnpm install
	@echo "📦 Installing backend dependencies..."
	go mod tidy
	go mod vendor

# Build targets
.PHONY: build
build: ## Build both frontend and backend (always rebuilds both)
	cd $(UI_DIR) && pnpm run build
	CGO_ENABLED=1 go build -trimpath $(LDFLAGS) -o $(BINARY_NAME) .
	@echo "✅ Build completed successfully! (parquet search uses the embedded DuckDB engine)"
	@echo "🚀 Run './$(BINARY_NAME)' to start the server"

build-cli: ## Build both frontend and backend without CGO (pure-Go duckdb CLI driver)
	cd $(UI_DIR) && pnpm run build
	CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o $(BINARY_NAME) .
	@echo "✅ Build completed successfully! (parquet search shells out to the duckdb binary)"
	@echo "🚀 Run './$(BINARY_NAME)' to start the server"

clean-frontend: ## Clean frontend build artifacts
	cd $(UI_DIR) && rm -rf dist node_modules/.vite
	rm -rf static

clean-backend: ## Clean backend build artifacts
	rm -rf $(BINARY_NAME) bin/

clean: clean-frontend clean-backend ## Clean all build artifacts
	@echo "🧹 All build artifacts cleaned!"

cross-compile: frontend ## Cross-compile for multiple architectures
	@echo "🔄 Cross-compiling for multiple architectures..."
	@echo "ℹ️  交叉编译走纯 Go 驱动（-tags duckdb_cli）：SDK 驱动的 libduckdb 是按平台分发的预编译"
	@echo "    静态库，交叉编译要为每个目标再配一套 C 工具链；这几份产物需要目标机有 duckdb 可执行文件。"
	mkdir -p bin
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-amd64 .
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-arm64 .
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-darwin-arm64 .
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-windows-amd64.exe .
	# GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-darwin-amd64 .

# 授权迁移工具（Rancher → AeroLink 权限绑定组）的单文件构建。
# 日常使用见 tools/rancherrbac/README.md：目标机上只要二进制 + 配置文件。
rancherrbac: ## 打包授权迁移工具（参数透传给 scripts/build-rancherrbac.sh，如 -a 全平台）
	sh scripts/build-rancherrbac.sh $(ARGS)

package-release:
	@echo "🔄 Packaging..."
	tar -czvf bin/$(BINARY_NAME)-$(shell git describe --tags --match 'v*' | grep -oE 'v[0-9]+\.[0-9][0-9]*(\.[0-9]+)?').tar.gz bin/*

package-binaries: ## Package each aerolink binary file separately
	@echo "🔄 Packaging aerolink binaries separately..."
	@VERSION=$$(git describe --tags --match 'v*' | grep -oE 'v[0-9]+\.[0-9][0-9]*(\.[0-9]+)?'); \
	for file in bin/aerolink-*; do \
		if [ -f "$$file" ]; then \
			filename=$$(basename "$$file"); \
			echo "📦 Packaging $$filename with version $$VERSION..."; \
			tar -czvf "bin/$$filename-$$VERSION.tar.gz" "$$file"; \
		fi; \
	done
	@echo "✅ All aerolink binaries packaged successfully!"

changelog: ## Generate categorized release notes into CHANGELOG.md
	@echo "📝 Generating CHANGELOG.md..."
	@printf '%s\n' '# Changelog' '' '本文件由 `make changelog` 生成（脚本：`scripts/changelog.sh`），请勿手工编辑。' '' > CHANGELOG.md
	@sh scripts/changelog.sh >> CHANGELOG.md
	@echo "✅ CHANGELOG.md updated"

.PHONY: frontend
frontend: ## Build frontend only (always rebuilds)
	cd $(UI_DIR) && pnpm run build

# GNU make globs like `ui/src/**/*.tsx` do NOT recurse into subdirectories
# (they behave like a single `*`), so deep file changes never triggered a
# rebuild. Collect the real file lists with find instead.
UI_SOURCES := $(shell find $(UI_DIR)/src -type f 2>/dev/null) \
	$(UI_DIR)/index.html \
	$(UI_DIR)/package.json \
	$(UI_DIR)/vite.config.ts

GO_SOURCES := $(shell find . -type f -name '*.go' \
	-not -path './vendor/*' \
	-not -path './ui/*' \
	-not -path './static/*' \
	-not -path './bin/*' \
	-not -path './e2e/*' \
	-not -path './.git/*' 2>/dev/null)

# 默认后端构建：parquet 检索用 DuckDB 的 **Go SDK（cgo，进程内引擎）**。
#
# 引擎（libduckdb，含 parquet 扩展）静态链进二进制，运行时不再需要外部 duckdb 可执行文件，
# 也没有每次查询的进程启动开销。代价是构建需要 CGO（gcc/g++）、产物动态依赖
# libstdc++/libc（运行镜像不能用 distroless/static），交叉编译见 cross-compile 的说明。
backend: ## Build backend only (always rebuilds; CGO + embedded DuckDB engine)
	@echo "🏗️ Building backend with the DuckDB Go SDK (CGO)..."
	CGO_ENABLED=1 go build -trimpath $(LDFLAGS) -o $(BINARY_NAME) .

# 纯 Go 后端构建（`-tags duckdb_cli`）：parquet 检索改为 exec 外部 duckdb 可执行文件。
#
# 与 backend 目标**只差检索驱动**，两者查同一份 parquet、走同一套 SQL 与结果归一
# （pkg/audit/archive_query_duckdb.go），结果逐字段一致（有跨驱动一致性测试保证）。
# 需要它的场景：交叉编译（SDK 要各平台的 libduckdb 与 C 工具链）、没有 gcc/g++ 的构建环境、
# 以及 SDK 驱动出问题时的退路。用这个构建时，镜像/目标机要有 `duckdb` 可执行文件。
backend-cli: ## Build backend without CGO (pure-Go duckdb CLI driver; needs the duckdb binary at runtime)
	@echo "🏗️ Building backend with the pure-Go DuckDB CLI driver..."
	CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o $(BINARY_NAME) .

# Production targets
run: backend ## Run the built application (loads dev.env when present)
	@echo "🚀 Starting $(BINARY_NAME) server..."
	@$(LOAD_DEV_ENV) ./$(BINARY_NAME)

dev: ## Run in development mode (frontend HMR + backend auto rebuild/restart)
	@echo "🔄 Starting development mode..."
	@scripts/dev-backend.sh & \
		WATCHER_PID=$$!; \
		trap 'kill $$WATCHER_PID 2>/dev/null || true' INT TERM; \
		echo "🚀 Backend watcher PID: $$WATCHER_PID"; \
		echo "🔄 Starting development server..."; \
		cd $(UI_DIR) && pnpm run dev; \
		echo "🛑 Stopping backend watcher..."; \
		kill $$WATCHER_PID 2>/dev/null || true

lint: golangci-lint ## Run linters
	@echo "🔍 Running linters..."
	@echo "Backend linting..."
	go vet ./...
	$(GOLANGCI_LINT) run
	@echo "Frontend linting..."
	cd $(UI_DIR) && pnpm run lint

golangci-lint: ## Download golangci-lint locally if necessary.
	test -f $(GOLANGCI_LINT) || curl -sSfL https://golangci-lint.run/install.sh | sh -s v2.12.1

format: ## Format code
	@echo "✨ Formatting code..."
	go fmt ./...
	cd $(UI_DIR) && pnpm run format

# Pre-commit checks
pre-commit: format lint ## Run pre-commit checks
	@echo "✅ Pre-commit checks completed!"

test: ## Run tests
	@echo "🧪 Running tests..."
	go test -v ./...
	cd $(UI_DIR) && pnpm run test

e2e-install: ## Install e2e dependencies
	@echo "📦 Installing e2e dependencies..."
	cd $(E2E_DIR) && pnpm install

e2e-install-browser: ## Install Playwright Chromium browser
	@echo "🌐 Installing Playwright Chromium..."
	cd $(E2E_DIR) && pnpm exec playwright install chromium

e2e-kind-up: ## Create or reuse the local kind cluster for e2e
	@if kind get clusters | grep -qx "$(E2E_KIND_NAME)"; then \
		echo "☸️ Reusing kind cluster $(E2E_KIND_NAME)..."; \
		kind export kubeconfig --name "$(E2E_KIND_NAME)" --kubeconfig "$(E2E_KUBECONFIG)"; \
	else \
		echo "☸️ Creating kind cluster $(E2E_KIND_NAME)..."; \
		kind create cluster --name "$(E2E_KIND_NAME)" --wait 2m --kubeconfig "$(E2E_KUBECONFIG)"; \
	fi

e2e-kind-down: ## Delete the local kind cluster used by e2e
	@if kind get clusters | grep -qx "$(E2E_KIND_NAME)"; then \
		echo "🧹 Deleting kind cluster $(E2E_KIND_NAME)..."; \
		kind delete cluster --name "$(E2E_KIND_NAME)"; \
	else \
		echo "ℹ️ kind cluster $(E2E_KIND_NAME) does not exist"; \
	fi
	rm -f "$(E2E_KUBECONFIG)"

e2e-stop-app: ## Stop any local e2e app process listening on the e2e port
	@PIDS=$$(lsof -tiTCP:$(E2E_PORT) -sTCP:LISTEN 2>/dev/null || true); \
	if [ -n "$$PIDS" ]; then \
		echo "🛑 Stopping local e2e app on port $(E2E_PORT)..."; \
		kill $$PIDS 2>/dev/null || true; \
		sleep 1; \
	fi

e2e-setup-ldap: ## Start the OpenLDAP service used by external-auth e2e
	@docker network inspect "$(E2E_AUTH_NETWORK)" >/dev/null 2>&1 || docker network create "$(E2E_AUTH_NETWORK)" >/dev/null
	@docker rm -f "$(E2E_LDAP_CONTAINER)" >/dev/null 2>&1 || true
	docker run -d --name "$(E2E_LDAP_CONTAINER)" \
		--network "$(E2E_AUTH_NETWORK)" \
		--network-alias ldap \
		-p "$(E2E_LDAP_PORT):389" \
		-e LDAP_ORGANISATION="AeroLink E2E" \
		-e LDAP_DOMAIN="aerolink.test" \
		-e LDAP_ADMIN_PASSWORD="admin" \
		-e LDAP_CONFIG_PASSWORD="admin" \
		-e LDAP_TLS="false" \
		-v "$(CURDIR)/e2e/fixtures/openldap:/container/service/slapd/assets/config/bootstrap/ldif/custom:ro" \
		osixia/openldap:1.5.0 --copy-service
	@for i in $$(seq 1 60); do \
		if docker exec "$(E2E_LDAP_CONTAINER)" ldapsearch -x -H ldap://localhost:389 -b dc=aerolink,dc=test -D "cn=admin,dc=aerolink,dc=test" -w admin >/dev/null 2>&1; then \
			break; \
		fi; \
		sleep 1; \
	done
	docker exec "$(E2E_LDAP_CONTAINER)" ldapsearch -x -H ldap://localhost:389 -b dc=aerolink,dc=test -D "cn=admin,dc=aerolink,dc=test" -w admin >/dev/null

e2e-setup-dex: ## Start the Dex service used by external-auth e2e
	@docker network inspect "$(E2E_AUTH_NETWORK)" >/dev/null 2>&1 || docker network create "$(E2E_AUTH_NETWORK)" >/dev/null
	@docker rm -f "$(E2E_DEX_CONTAINER)" >/dev/null 2>&1 || true
	docker run -d --name "$(E2E_DEX_CONTAINER)" \
		--network "$(E2E_AUTH_NETWORK)" \
		-p "$(E2E_OAUTH_PORT):5556" \
		-v "$(CURDIR)/e2e/fixtures/dex/config.yaml:/etc/dex/config.yaml:ro" \
		ghcr.io/dexidp/dex:v2.45.1 dex serve /etc/dex/config.yaml
	@for i in $$(seq 1 60); do \
		if curl -fsS "http://127.0.0.1:$(E2E_OAUTH_PORT)/.well-known/openid-configuration" >/dev/null; then \
			break; \
		fi; \
		sleep 1; \
	done
	curl -fsS "http://127.0.0.1:$(E2E_OAUTH_PORT)/.well-known/openid-configuration" >/dev/null

e2e-run: e2e-kind-up e2e-stop-app ## Run e2e tests against the local kind cluster
	@echo "🧪 Running e2e tests..."
	cd $(E2E_DIR) && KUBECONFIG="$(E2E_KUBECONFIG)" AEROLINK_E2E_CLUSTER_NAME="$(E2E_KIND_NAME)" AEROLINK_E2E_PORT="$(E2E_PORT)" AEROLINK_E2E_LDAP_URL="$(E2E_LDAP_URL)" AEROLINK_E2E_OAUTH_ISSUER="$(E2E_OAUTH_ISSUER)" pnpm exec playwright test $(SPEC)

e2e-run-existing: e2e-stop-app ## Run e2e tests against an existing cluster (KUBECONFIG, E2E_CLUSTER_NAME, E2E_NODE_NAME)
	@echo "🧪 Running e2e tests against an existing cluster..."
	cd $(E2E_DIR) && KUBECONFIG="$(KUBECONFIG)" AEROLINK_E2E_CLUSTER_NAME="$(E2E_CLUSTER_NAME)" AEROLINK_E2E_CONTEXT_NAME="$(E2E_CONTEXT_NAME)" AEROLINK_E2E_NODE_NAME="$(E2E_NODE_NAME)" AEROLINK_E2E_PORT="$(E2E_PORT)" AEROLINK_E2E_LDAP_URL="$(E2E_LDAP_URL)" AEROLINK_E2E_OAUTH_ISSUER="$(E2E_OAUTH_ISSUER)" pnpm exec playwright test $(SPEC)

e2e-run-headed: e2e-kind-up e2e-stop-app ## Run e2e tests in headed mode against the local kind cluster
	@echo "🧪 Running headed e2e tests..."
	cd $(E2E_DIR) && KUBECONFIG="$(E2E_KUBECONFIG)" AEROLINK_E2E_CLUSTER_NAME="$(E2E_KIND_NAME)" AEROLINK_E2E_PORT="$(E2E_PORT)" AEROLINK_E2E_LDAP_URL="$(E2E_LDAP_URL)" AEROLINK_E2E_OAUTH_ISSUER="$(E2E_OAUTH_ISSUER)" pnpm exec playwright test --headed $(SPEC)

e2e-test: e2e-install e2e-install-browser e2e-run ## Run e2e tests against the local kind cluster

e2e-test-headed: e2e-install e2e-install-browser e2e-run-headed ## Run e2e tests in headed mode against the local kind cluster

docs-dev: ## Start documentation server in development mode
	@echo "📚 Starting documentation server..."
	cd docs && pnpm run docs:dev
docs-build: ## Build documentation
	@echo "📚 Building documentation..."
	cd docs && pnpm run docs:build

# ----- Docker 镜像 -----
IMAGE ?= swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:v1.0.0
# 基础镜像默认全部取自公司 SWR（Dockerfile 中的默认值就是 SWR 路径）。
# 后端依赖在仓库里 vendored（构建不下载 Go 模块），所以这里只剩前端依赖源；直连环境可置空：
#   make image DOCKER_BUILD_ARGS=
# --provenance=false --sbom=false：禁止 BuildKit 附加 provenance/SBOM 证明清单。
# 带证明的镜像会以 OCI manifest list 推送，部分仓库（如华为云 SWR）无法解析，
# 推送时报 "Invalid image, fail to parse 'manifest.json'"。
DOCKER_BUILD_ARGS ?= --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
	--provenance=false --sbom=false

# 版本信息单独传，不放进 DOCKER_BUILD_ARGS：后者可能被置空以走直连环境，
# 而镜像里的版本号（前端展示）不该跟着丢掉。
.PHONY: image push
image: ## Build the Docker image (IMAGE=registry/repo:tag)
	docker build $(DOCKER_BUILD_ARGS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg BUILD_DATE=$(BUILD_DATE) \
		--build-arg COMMIT_ID=$(COMMIT_ID) \
		-t $(IMAGE) .

push: image ## Build and push the Docker image
	docker push $(IMAGE)
