# Makefile for AeroLink project
#
# .PHONY 一次列全（不再分散在文件各处）：所有目标都不产出同名文件，
# 漏登记会出现「目录里刚好有个同名文件 → make 报 up to date 什么都不做」。
.PHONY: help install deps build build-cli clean clean-frontend clean-backend \
	cross-compile rancherrbac package-release package-binaries changelog \
	frontend backend backend-cli run dev lint golangci-lint format pre-commit test \
	e2e-install e2e-install-browser e2e-kind-up e2e-kind-down e2e-stop-app \
	e2e-setup-ldap e2e-setup-dex e2e-run e2e-run-existing e2e-run-headed \
	e2e-test e2e-test-headed docs-dev docs-build \
	image push docs-image push-docs image-binary push-binary build-arm push-arm

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
VERSION ?= v1.0.2
BUILD_DATE ?= $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
COMMIT_ID ?= $(shell git rev-parse HEAD 2>/dev/null || echo "unknown")

# Build flags
# -s -w 去掉符号表与调试信息（体积小），-X 在链接期把值写进 pkg/version 的字符串变量。
# `github.com/zxh326/kite/...` 是 **Go 符号名**（= go.mod 的 module 路径 + 包 + 变量），
# 不是网址：这里不发任何网络请求，$(VERSION) / $(BUILD_DATE) / $(COMMIT_ID) 都是本机
# 求值（make 变量、date、git rev-parse），耗时微秒级。
#
# 必须用递归赋值（`?=` / `=`，不能用 `:=`）：变量在使用时才展开，下面
# `-include Makefile.local` 里覆盖的 VERSION / BUILD_DATE / COMMIT_ID 才能进到 ldflags。
# 注意：整个 -ldflags "..." 必须留在 LDFLAGS 里，不能只留版本号——go build 需要的是
# 「-ldflags + 参数」这一对，写成 LDFLAGS="v1.0.0" 会被当成包路径而报错。
LDFLAGS ?= -ldflags "-s -w \
	-X 'github.com/zxh326/kite/pkg/version.Version=$(VERSION)' \
	-X 'github.com/zxh326/kite/pkg/version.BuildDate=$(BUILD_DATE)' \
	-X 'github.com/zxh326/kite/pkg/version.CommitID=$(COMMIT_ID)'"

# 本机临时覆盖（不进版本库，见 .gitignore）：把 VERSION / LDFLAGS 这类本机专用值写进
# Makefile.local，例如让本机构建的后端/前端显示另一个版本号而不改仓库里的 VERSION。
# 文件不存在时该行被忽略；放在这里是为了让覆盖值赢过上面的 ?= 与 LDFLAGS。
-include Makefile.local

# Default target
# 裸敲 `make`（不带目标）打印中文帮助；构建请显式写 `make build` / `make dev`。
.DEFAULT_GOAL := help
DOCKER_TAG=latest

LOCALBIN ?= $(shell pwd)/bin
$(LOCALBIN):
	mkdir -p $(LOCALBIN)
GOLANGCI_LINT = $(LOCALBIN)/golangci-lint

# Help target
# 只列出带 `## ` 注释的目标：新加目标时顺手写一行描述，否则它不会出现在 `make help` 里。
# `##@ 分组名` 开一个新分组标题，按文件里的先后顺序输出，所以要放在该组第一个目标之前。
# 列宽按最长的目标名（e2e-install-browser，19 字符）留，短名不会挤掉后面的描述。
# 注意 `make -h` 是 GNU make 自带的用法说明（英文、只讲 make 自己的参数），本项目的
# 中文帮助走 `make help`（也是裸敲 `make` 时的默认目标）。
help: ## 查看本帮助：按分组列出所有可用目标及其说明
	@echo ""
	@echo "用法：make <目标> [变量=值]，例如 make image IMAGE=registry/repo:tag"
	@awk 'BEGIN {FS = ":.*?## "} /^##@ / {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)} /^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""

# Install dependencies
##@ 依赖
install: deps ## 安装全部依赖（前端 pnpm install + 后端 go mod tidy/vendor）
	@echo "📦 Installing dependencies..."

deps: ## 安装前端与后端依赖（pnpm install / go mod tidy + go mod vendor）
	@echo "📦 Installing frontend dependencies..."
	cd $(UI_DIR) && pnpm install
	@echo "📦 Installing backend dependencies..."
	go mod tidy
	go mod vendor

# Build targets
##@ 构建
build: ## 构建前端 + 后端二进制（每次都重新构建；后端需 gcc/CGO）
	cd $(UI_DIR) && pnpm run build
	@CGO_ENABLED=1 go build -trimpath $(LDFLAGS) -o $(BINARY_NAME) .
	@echo "✅ Build completed successfully! (parquet search uses the embedded DuckDB engine)"
	@echo "🚀 Run './$(BINARY_NAME)' to start the server"

build-cli: ## 构建前端 + 后端二进制，后端走纯 Go 驱动（不需 gcc；运行时需 duckdb 可执行文件）
	cd $(UI_DIR) && pnpm run build
	@CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o $(BINARY_NAME) .
	@echo "✅ Build completed successfully! (parquet search shells out to the duckdb binary)"
	@echo "🚀 Run './$(BINARY_NAME)' to start the server"

clean-frontend: ## 清理前端产物（ui/dist 与嵌入用的 static/）
	cd $(UI_DIR) && rm -rf dist node_modules/.vite
	rm -rf static

clean-backend: ## 清理后端产物（二进制与 bin/）
	rm -rf $(BINARY_NAME) bin/

clean: clean-frontend clean-backend ## 清理全部构建产物
	@echo "🧹 All build artifacts cleaned!"

cross-compile: frontend ## 交叉编译各平台二进制到 bin/（纯 Go 驱动）
	@echo "🔄 Cross-compiling for multiple architectures..."
	@echo "ℹ️  交叉编译走纯 Go 驱动（-tags duckdb_cli）：SDK 驱动的 libduckdb 是按平台分发的预编译"
	@echo "    静态库，交叉编译要为每个目标再配一套 C 工具链；这几份产物需要目标机有 duckdb 可执行文件。"
	mkdir -p bin
	@GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-amd64 .
	@GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-arm64 .
	@GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-darwin-arm64 .
	@GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-windows-amd64.exe .
	# GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o bin/$(BINARY_NAME)-darwin-amd64 .

# 授权迁移工具（Rancher → AeroLink 权限绑定组）的单文件构建。
# 日常使用见 tools/rancherrbac/README.md：目标机上只要二进制 + 配置文件。
rancherrbac: ## 打包授权迁移工具（参数透传给 scripts/build-rancherrbac.sh，如 -a 全平台）
	sh scripts/build-rancherrbac.sh $(ARGS)

package-release: ## 把 bin/ 里的全部产物打成一个带版本号的 tar.gz
	@echo "🔄 Packaging..."
	tar -czvf bin/$(BINARY_NAME)-$(shell git describe --tags --match 'v*' | grep -oE 'v[0-9]+\.[0-9][0-9]*(\.[0-9]+)?').tar.gz bin/*

package-binaries: ## 把 bin/ 里每个二进制分别打一个 tar.gz
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

changelog: ## 按提交类型生成发布说明到 CHANGELOG.md
	@echo "📝 Generating CHANGELOG.md..."
	@printf '%s\n' '# Changelog' '' '本文件由 `make changelog` 生成（脚本：`scripts/changelog.sh`），请勿手工编辑。' '' > CHANGELOG.md
	@sh scripts/changelog.sh >> CHANGELOG.md
	@echo "✅ CHANGELOG.md updated"

frontend: ## 只构建前端到 static/（每次都重新构建）
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
backend: ## 只构建后端（每次都重新构建；CGO + 内嵌 DuckDB 引擎）
	@echo "🏗️ Building backend with the DuckDB Go SDK (CGO)..."
	@CGO_ENABLED=1 go build -trimpath $(LDFLAGS) -o $(BINARY_NAME) .

# 纯 Go 后端构建（`-tags duckdb_cli`）：parquet 检索改为 exec 外部 duckdb 可执行文件。
#
# 与 backend 目标**只差检索驱动**，两者查同一份 parquet、走同一套 SQL 与结果归一
# （pkg/audit/archive_query_duckdb.go），结果逐字段一致（有跨驱动一致性测试保证）。
# 需要它的场景：交叉编译（SDK 要各平台的 libduckdb 与 C 工具链）、没有 gcc/g++ 的构建环境、
# 以及 SDK 驱动出问题时的退路。用这个构建时，镜像/目标机要有 `duckdb` 可执行文件。
backend-cli: ## 只构建后端，走纯 Go 驱动（不需 gcc；运行时需 duckdb 可执行文件）
	@echo "🏗️ Building backend with the pure-Go DuckDB CLI driver..."
	@CGO_ENABLED=0 go build -tags duckdb_cli -trimpath $(LDFLAGS) -o $(BINARY_NAME) .

# Production targets
##@ 运行与开发
run: backend ## 构建并启动后端服务（存在 dev.env 时自动加载）
	@echo "🚀 Starting $(BINARY_NAME) server..."
	@$(LOAD_DEV_ENV) ./$(BINARY_NAME)

dev: ## 开发模式：前端热更新 + 后端自动重建重启
	@echo "🔄 Starting development mode..."
	@scripts/dev-backend.sh & \
		WATCHER_PID=$$!; \
		trap 'kill $$WATCHER_PID 2>/dev/null || true' INT TERM; \
		echo "🚀 Backend watcher PID: $$WATCHER_PID"; \
		echo "🔄 Starting development server..."; \
		cd $(UI_DIR) && pnpm run dev; \
		echo "🛑 Stopping backend watcher..."; \
		kill $$WATCHER_PID 2>/dev/null || true

##@ 检查与测试
lint: golangci-lint ## 静态检查（go vet + golangci-lint + 前端 eslint）
	@echo "🔍 Running linters..."
	@echo "Backend linting..."
	go vet ./...
	$(GOLANGCI_LINT) run
	@echo "Frontend linting..."
	cd $(UI_DIR) && pnpm run lint

golangci-lint: ## 本地缺少 golangci-lint 时下载（版本 v2.12.1）
	test -f $(GOLANGCI_LINT) || curl -sSfL https://golangci-lint.run/install.sh | sh -s v2.12.1

format: ## 格式化代码（go fmt + 前端 prettier）
	@echo "✨ Formatting code..."
	go fmt ./...
	cd $(UI_DIR) && pnpm run format

# Pre-commit checks
pre-commit: format lint ## 提交前检查（格式化 + lint；基线告警的处理口径见 AGENTS.md）
	@echo "✅ Pre-commit checks completed!"

test: ## 运行测试（go test -v + 前端 vitest）
	@echo "🧪 Running tests..."
	go test -v ./...
	cd $(UI_DIR) && pnpm run test

##@ 端到端测试（e2e）
e2e-install: ## 安装 e2e 依赖
	@echo "📦 Installing e2e dependencies..."
	cd $(E2E_DIR) && pnpm install

e2e-install-browser: ## 安装 Playwright Chromium 浏览器
	@echo "🌐 Installing Playwright Chromium..."
	cd $(E2E_DIR) && pnpm exec playwright install chromium

e2e-kind-up: ## 创建或复用 e2e 用的本地 kind 集群
	@if kind get clusters | grep -qx "$(E2E_KIND_NAME)"; then \
		echo "☸️ Reusing kind cluster $(E2E_KIND_NAME)..."; \
		kind export kubeconfig --name "$(E2E_KIND_NAME)" --kubeconfig "$(E2E_KUBECONFIG)"; \
	else \
		echo "☸️ Creating kind cluster $(E2E_KIND_NAME)..."; \
		kind create cluster --name "$(E2E_KIND_NAME)" --wait 2m --kubeconfig "$(E2E_KUBECONFIG)"; \
	fi

e2e-kind-down: ## 删除 e2e 用的本地 kind 集群
	@if kind get clusters | grep -qx "$(E2E_KIND_NAME)"; then \
		echo "🧹 Deleting kind cluster $(E2E_KIND_NAME)..."; \
		kind delete cluster --name "$(E2E_KIND_NAME)"; \
	else \
		echo "ℹ️ kind cluster $(E2E_KIND_NAME) does not exist"; \
	fi
	rm -f "$(E2E_KUBECONFIG)"

e2e-stop-app: ## 停掉占用 e2e 端口的本地应用进程
	@PIDS=$$(lsof -tiTCP:$(E2E_PORT) -sTCP:LISTEN 2>/dev/null || true); \
	if [ -n "$$PIDS" ]; then \
		echo "🛑 Stopping local e2e app on port $(E2E_PORT)..."; \
		kill $$PIDS 2>/dev/null || true; \
		sleep 1; \
	fi

e2e-setup-ldap: ## 启动外部认证 e2e 用的 OpenLDAP 容器
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

e2e-setup-dex: ## 启动外部认证 e2e 用的 Dex 容器
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

e2e-run: e2e-kind-up e2e-stop-app ## 对本地 kind 集群跑 e2e（SPEC=... 可只跑单个用例）
	@echo "🧪 Running e2e tests..."
	cd $(E2E_DIR) && KUBECONFIG="$(E2E_KUBECONFIG)" AEROLINK_E2E_CLUSTER_NAME="$(E2E_KIND_NAME)" AEROLINK_E2E_PORT="$(E2E_PORT)" AEROLINK_E2E_LDAP_URL="$(E2E_LDAP_URL)" AEROLINK_E2E_OAUTH_ISSUER="$(E2E_OAUTH_ISSUER)" pnpm exec playwright test $(SPEC)

e2e-run-existing: e2e-stop-app ## 对已有集群跑 e2e（需 KUBECONFIG / E2E_CLUSTER_NAME / E2E_NODE_NAME）
	@echo "🧪 Running e2e tests against an existing cluster..."
	cd $(E2E_DIR) && KUBECONFIG="$(KUBECONFIG)" AEROLINK_E2E_CLUSTER_NAME="$(E2E_CLUSTER_NAME)" AEROLINK_E2E_CONTEXT_NAME="$(E2E_CONTEXT_NAME)" AEROLINK_E2E_NODE_NAME="$(E2E_NODE_NAME)" AEROLINK_E2E_PORT="$(E2E_PORT)" AEROLINK_E2E_LDAP_URL="$(E2E_LDAP_URL)" AEROLINK_E2E_OAUTH_ISSUER="$(E2E_OAUTH_ISSUER)" pnpm exec playwright test $(SPEC)

e2e-run-headed: e2e-kind-up e2e-stop-app ## 对本地 kind 集群跑 e2e（有头模式）
	@echo "🧪 Running headed e2e tests..."
	cd $(E2E_DIR) && KUBECONFIG="$(E2E_KUBECONFIG)" AEROLINK_E2E_CLUSTER_NAME="$(E2E_KIND_NAME)" AEROLINK_E2E_PORT="$(E2E_PORT)" AEROLINK_E2E_LDAP_URL="$(E2E_LDAP_URL)" AEROLINK_E2E_OAUTH_ISSUER="$(E2E_OAUTH_ISSUER)" pnpm exec playwright test --headed $(SPEC)

e2e-test: e2e-install e2e-install-browser e2e-run ## 一键跑 e2e：装依赖 + 装浏览器 + 对本地 kind 集群执行

e2e-test-headed: e2e-install e2e-install-browser e2e-run-headed ## 一键跑 e2e（有头模式）

##@ 文档站
docs-dev: ## 启动文档站开发服务（VitePress）
	@echo "📚 Starting documentation server..."
	cd docs && pnpm run docs:dev
docs-build: ## 构建文档站静态产物
	@echo "📚 Building documentation..."
	cd docs && pnpm run docs:build

# ----- Docker 镜像 -----
##@ Docker 镜像
IMAGE ?= swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:v1.0.2
# 基础镜像默认全部取自公司 SWR（Dockerfile 中的默认值就是 SWR 路径）。
# 后端依赖在仓库里 vendored（构建不下载 Go 模块），所以这里只剩前端依赖源；直连环境可置空：
#   make image DOCKER_BUILD_ARGS=
# --provenance=false --sbom=false：禁止 BuildKit 附加 provenance/SBOM 证明清单。
# 带证明的镜像会以 OCI manifest list 推送，部分仓库（如华为云 SWR）无法解析，
# 推送时报 "Invalid image, fail to parse 'manifest.json'"。
# 两条镜像路径（image / image-binary）都必须带上，image-binary 曾漏掉这两个参数。
DOCKER_PROVENANCE_ARGS ?= --provenance=false --sbom=false
DOCKER_BUILD_ARGS ?= --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
	$(DOCKER_PROVENANCE_ARGS)

# 两条镜像构建路径，产物功能等价，差别在「在哪编译」：
#   make image        —— 容器内编译（golang:1.26.8 / Debian glibc 2.41），可复现、不挑本机工具链；
#                        代价是把 vendor(872MB) + ui 传进上下文并编译两遍，实测 12 分钟以上。
#   make image-binary —— 本机 `make build`（含前端）后只把二进制打进镜像，1~2 分钟；
#                        前提是本机 glibc **不高于**运行基座（openEuler 24.03 LTS-SP4 = glibc 2.38），
#                        并且必须用 CGO 默认构建：`make cross-compile` 出的 bin/aerolink-<arch>
#                        是 `-tags duckdb_cli` 纯 Go 产物，不含 DuckDB 引擎，用它建镜像会让
#                        parquet 审计检索失效。
#
# 版本信息单独传，不放进 DOCKER_BUILD_ARGS：后者可能被置空以走直连环境，
# 而镜像里的版本号（前端展示）不该跟着丢掉。
image: ## 构建应用镜像（IMAGE=仓库/镜像:标签）
	docker build $(DOCKER_BUILD_ARGS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg BUILD_DATE=$(BUILD_DATE) \
		--build-arg COMMIT_ID=$(COMMIT_ID) \
		-t $(IMAGE) .

push: image ## 构建并推送应用镜像
	docker push $(IMAGE)

# 文档站镜像（VitePress 静态站 + nginx）。构建上下文是 docs/ 本身，不是仓库根：
# 根 .dockerignore 里的 `docs` 会把它挡在上下文外，所以 -f 之外最后一个参数必须是 docs/。
# 与应用镜像同一约定：地址连同 tag 直接写死（发新版时与上面的 IMAGE 一起改），
# 换仓库或改名字再覆盖 DOCS_IMAGE。刻意不用 $(VERSION)：本机 Makefile.local 会覆盖它，
# 那样两个镜像的 tag 会不一致。
DOCS_IMAGE ?= swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink-docs:v1.0.2
# 运行基座同样取 SWR（已推入 docker.io/library/nginx:1.31.7）；直连环境可改回 nginx:alpine。
DOCS_NGINX_IMAGE ?= swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/nginx:1.31.7
# 与 image 一致：文档站构建里唯一联网的就是 pnpm install，默认取国内镜像源。
DOCS_NPM_REGISTRY ?= https://registry.npmmirror.com

docs-image: ## 构建文档站镜像（DOCS_IMAGE=仓库/镜像:标签）
	docker build -f docs/Dockerfile \
		--build-arg NGINX_IMAGE=$(DOCS_NGINX_IMAGE) \
		--build-arg NPM_REGISTRY=$(DOCS_NPM_REGISTRY) \
		$(DOCKER_PROVENANCE_ARGS) \
		-t $(DOCS_IMAGE) docs/

# 与 push / push-binary 同一形状（构建 + 推送一步到位），命令名也刻意对齐，
# 免得文档站要单独记一条 `docker push`。文档站不需要 image-binary 那种「本机编译」路径：
# 它本来就是容器内 pnpm + vitepress 构建，一次几十秒，没有加速的必要。
push-docs: docs-image ## 构建并推送文档站镜像
	docker push $(DOCS_IMAGE)

# image-binary 的输入目录：只放一个二进制 + CA 证书，构建上下文因此只有 ~100MB。
BINARY_DIST_DIR ?= dist
# 可信根证书 bundle 的路径各发行版命名不同：RHEL/openEuler 系是 ca-bundle.crt（指向
# /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem 的符号链接），Debian/Ubuntu 系才是
# ca-certificates.crt。按顺序取第一个存在的，都找不到时明确报错让使用者自己指定。
CA_BUNDLE ?= $(firstword $(wildcard \
	/etc/ssl/certs/ca-bundle.crt \
	/etc/pki/tls/certs/ca-bundle.crt \
	/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \
	/etc/ssl/certs/ca-certificates.crt))
# 与 image 一致：运行基座可覆盖。arm64 编译机（公网构建机）拉不到 docker.io，且公司 SWR 里
# 不带后缀的 openEuler tag 是单架构 amd64 manifest，所以 arm64 构建要显式指带 -arm64 后缀的那份：
#   make image-binary RUNTIME_IMAGE=swr.../openeuler:24.03-lts-sp4-arm64 GOARCH=arm64
RUNTIME_IMAGE ?= swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/openeuler/openeuler:24.03-lts-sp4
GOARCH ?= $(shell go env GOARCH)

# 注意：这里先跑 `build`（= 前端 pnpm build 到 ../static + CGO 编译），保证二进制里
# embed 的是最新前端产物；版本号走 Makefile 的 LDFLAGS，不传 --build-arg。
image-binary: build ## 用本机编译的二进制构建镜像（快；要求本机 glibc 不高于运行基座）
	@command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
	@test -n "$(CA_BUNDLE)" && test -f "$(CA_BUNDLE)" || { \
		echo "cannot find a CA bundle (tried ca-bundle.crt / ca-certificates.crt);" >&2; \
		echo "install ca-certificates or set CA_BUNDLE=/path/to/bundle" >&2; exit 1; }
	@rm -rf $(BINARY_DIST_DIR) && mkdir -p $(BINARY_DIST_DIR)
	cp $(BINARY_NAME) $(BINARY_DIST_DIR)/$(BINARY_NAME)-$(GOARCH)
	@# 运行基座（openEuler 精简镜像）不带可信根证书，必须从构建机拷一份；
	@# 统一放到 Debian 命名 ca-certificates.crt —— Go 的系统证书查找顺序里它是第一个候选。
	cp $(CA_BUNDLE) $(BINARY_DIST_DIR)/ca-certificates.crt
	docker build -f Dockerfile.binary \
		$(DOCKER_PROVENANCE_ARGS) \
		--build-arg RUNTIME_IMAGE=$(RUNTIME_IMAGE) \
		--build-arg TARGETARCH=$(GOARCH) \
		-t $(IMAGE) $(BINARY_DIST_DIR)
	@echo "✅ $(IMAGE) built from the locally compiled binary (CA bundle: $(CA_BUNDLE))"

push-binary: image-binary ## 用本机编译的二进制构建镜像并推送
	docker push $(IMAGE)

# ----- ARM（arm64） -----
##@ ARM（arm64）
# 本地（x86_64，含 WSL2）出 arm64 镜像走的是**宿主机交叉编译 + 零 RUN 镜像**，不在容器里编：
#   - 后端：CGO_ENABLED=0 GOARCH=arm64 -tags duckdb_cli（纯 Go，本机 85 秒），不需要任何 arm64 工具链；
#   - 镜像：Dockerfile.arm **一条 RUN 都没有**，所以无需本机能在 arm64 里执行程序。
#     （本机跑不了 arm64：WSL2 内核没注册 qemu binfmt，`docker run --platform linux/arm64 hello-world`
#     直接 exec format error；任何在目标架构里跑的 RUN 因此此路不通。）
# 代价：丢掉内嵌 DuckDB 引擎，parquet 检索改为 exec 外部 duckdb（镜像里自带，口径见
# pkg/audit/archive_query_duckdb_cli.go），所以多一次进程启动。要内嵌引擎就去一台原生 ARM 机器
# 按 Dockerfile.binary 构建（scripts/provision-arm64-builder.sh，约 4 分钟，已实跑验证过）。
ARMARCH ?= arm64
# duckdb CLI 版本：需与基座的 libstdc++ 兼容（v2.0.0 实测要求 GLIBCXX_3.4.22 / CXXABI_1.3.11，
# 而 openEuler 24.03 的 libstdc++.so.6.0.30 提供到 3.4.30），换版本先重跑这道核对。
DUCKDB_VERSION ?= v2.0.0
DUCKDB_URL ?= https://github.com/duckdb/duckdb/releases/download/$(DUCKDB_VERSION)/duckdb-cli-linux-$(ARMARCH).tar.gz
ARM_TAG ?= $(VERSION)-$(ARMARCH)
ARM_IMAGE ?= swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:$(ARM_TAG)
ARM_DIST_DIR ?= dist-arm
# arm64 基座（SWR 里带 -arm64 后缀那份；不带后缀的是单架构 amd64）
RUNTIME_IMAGE_ARM ?= swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/openeuler/openeuler:24.03-lts-sp4-arm64
# Dockerfile.arm 用来代做目录属主的小镜像（跟构建机架构，靠 $BUILDPLATFORM）；拉不到 docker hub 时换可达地址。
CHOWN_STAGING_IMAGE ?= busybox:latest
# 取目标架构的 duckdb CLI（构建机自身是 amd64 时也能交叉准备 arm64 产物）。
# 落地文件名带架构与版本：否则换 ARMARCH / DUCKDB_VERSION 重跑会复用上一个架构那份。
# 架构校验用 readelf 的 Machine 而不是 `file`：后者把 amd64 写成 x86-64、arm64 写成 aarch64，
# 直接拿 GOARCH 的值去 grep 必挂。
ARCH_MACHINE ?= $(if $(filter arm64,$(ARMARCH)),AArch64,X86-64)
$(ARM_DIST_DIR)/duckdb-$(ARMARCH)-$(DUCKDB_VERSION):
	@mkdir -p $(ARM_DIST_DIR)
	@test -f $@ || { \
		echo "下载 duckdb $(DUCKDB_VERSION) linux-$(ARMARCH)…"; \
		curl -fSL --retry 3 --retry-delay 2 -m 900 -o $@.tmp.tar.gz "$(DUCKDB_URL)"; \
		tar -xzf $@.tmp.tar.gz -C $(ARM_DIST_DIR) duckdb; \
		mv $(ARM_DIST_DIR)/duckdb $@; \
		rm -f $@.tmp.tar.gz; \
	}
	@chmod 0755 $@
	@readelf -h $@ | grep -q "Machine:.*$(ARCH_MACHINE)" || { \
		echo "$@ 不是 $(ARMARCH) 二进制（期望 Machine: $(ARCH_MACHINE)）："; readelf -h $@ | grep Machine; exit 1; }

build-arm: frontend $(ARM_DIST_DIR)/duckdb-$(ARMARCH)-$(DUCKDB_VERSION) ## 本地交叉构 arm64 镜像（纯 Go + 内嵌 duckdb CLI；不需 ARM 机器）
	@command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
	@rm -rf $(ARM_DIST_DIR)/aerolink-$(ARMARCH) $(ARM_DIST_DIR)/ca-certificates.crt
	@CGO_ENABLED=0 GOOS=linux GOARCH=$(ARMARCH) go build -tags duckdb_cli -trimpath $(LDFLAGS) -o $(ARM_DIST_DIR)/aerolink-$(ARMARCH) .
	@readelf -h $(ARM_DIST_DIR)/aerolink-$(ARMARCH) | grep -q "Machine:.*$(ARCH_MACHINE)" || { \
		echo "交叉编译产物架构不对（期望 $(ARMARCH)）"; exit 1; }
	@test -n "$(CA_BUNDLE)" && test -f "$(CA_BUNDLE)" || { \
		echo "cannot find a CA bundle (tried ca-bundle.crt / ca-certificates.crt);" >&2; \
		echo "install ca-certificates or set CA_BUNDLE=/path/to/bundle" >&2; exit 1; }
	@cp $(CA_BUNDLE) $(ARM_DIST_DIR)/ca-certificates.crt
	docker build -f Dockerfile.arm \
		$(DOCKER_PROVENANCE_ARGS) \
		--build-arg RUNTIME_IMAGE=$(RUNTIME_IMAGE_ARM) \
		--build-arg CHOWN_STAGING_IMAGE=$(CHOWN_STAGING_IMAGE) \
		--build-arg TARGETARCH=$(ARMARCH) \
		--build-arg DUCKDB_BIN=duckdb-$(ARMARCH)-$(DUCKDB_VERSION) \
		-t $(ARM_IMAGE) $(ARM_DIST_DIR)
	@echo "✅ $(ARM_IMAGE)（纯 Go 驱动 + duckdb CLI $(DUCKDB_VERSION)）"
	@echo "ℹ️  本机是 $(GOARCH)；ARMARCH=arm64 时本镜像在本地跑不起，推仓后在 arm64 机器上验"

push-arm: build-arm ## 本地交叉构 arm64 镜像并推送到 SWR
	docker push $(ARM_IMAGE)
